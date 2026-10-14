import { implement } from "@orpc/server";
import {
  CONTRACT_FORMAT_EXT,
  type ContractFormat,
  checkRepoPath,
  contract,
  type ProjectSdlcSettings,
  renderRepoPath,
  type SdlcArtifact,
  type SdlcArtifactView,
  type SdlcContractInput,
  type SdlcPhase,
  type SdlcReportInput,
  sdlcContractInput,
  sdlcDocKey,
  sdlcItemRef,
} from "@xdev-hive/contracts";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { loadProject } from "../catalog/index.ts";
import { docHistory, type Principal, saveDraft } from "../knowledge/index.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type RequestContext,
  type Tx,
} from "../platform/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import { activeItemProjects, itemForUser, requireProjectWrite, type SdlcItemRow } from "./access.ts";
import { artifactViews } from "./artifact-view.ts";
import { sdlcArtifactSyncs, sdlcArtifacts, sdlcItems, sdlcItemTasks } from "./schema.ts";

/**
 * Contract liên repo (D23): mỗi contract là một dòng `sdlc_artifacts` `scope = contract`, file nguồn ở repo bên cung
 * cấp, bản sao ở repo mỗi bên dùng. Người tạo qua `contracts.create`, agent qua `sdlc_report contracts`. Cổng duyệt dựng
 * ở `phases.workflowFor`; tự duyệt luôn từ chối contract (`autoapprove.decide`).
 */

export interface ContractParticipant {
  projectId: string;
  key: string;
  teamId: string;
}

export interface ContractDraft {
  name: string;
  format: ContractFormat;
  providerProjectId: string;
  consumerProjectIds: string[];
  content: string;
}

export interface ContractRejection {
  name: string;
  reason: string;
}

/** Contract chỉ nối các dự án đã tham gia hạng mục, vì quyền và đội của từng bên lấy từ `sdlc_item_projects`. */
export function checkContractParties(input: SdlcContractInput, participantIds: ReadonlySet<string>): string | null {
  const parsed = sdlcContractInput.safeParse(input);
  if (!parsed.success) return parsed.error.issues[0]?.message ?? "Contract không hợp lệ.";
  const { providerProjectId, consumerProjectIds } = parsed.data;
  if (new Set(consumerProjectIds).size !== consumerProjectIds.length) return "Bên dùng bị lặp.";
  if (!participantIds.has(providerProjectId)) return "Bên cung cấp không thuộc hạng mục.";
  if (consumerProjectIds.some((p) => !participantIds.has(p))) return "Bên dùng không thuộc hạng mục.";
  return null;
}

/** Đường dẫn bản nháp contract khi chế độ khai khuôn có `{name}.{ext}`; để repo và hub dùng chung một tên đuôi file. */
export function contractFileName(name: string, format: ContractFormat): string {
  return `${name}.${CONTRACT_FORMAT_EXT[format]}`;
}

/**
 * Agent báo contract theo key dự án (nó không biết id). Contract sai không làm hỏng cả báo cáo: bỏ riêng từng cái và
 * trả lý do để hiện cho người soạn.
 */
export function contractsFromReport(
  report: Extract<SdlcReportInput, { kind: "contracts" }>,
  participants: readonly ContractParticipant[],
  existingNames: ReadonlySet<string> = new Set(),
): { drafts: ContractDraft[]; rejected: ContractRejection[] } {
  const byKey = new Map(participants.map((p) => [p.key, p.projectId]));
  const ids = new Set(byKey.values());
  const seen = new Set(existingNames);
  const drafts: ContractDraft[] = [];
  const rejected: ContractRejection[] = [];
  for (const c of report.data.contracts) {
    const reject = (reason: string) => rejected.push({ name: c.name, reason });
    if (seen.has(c.name)) {
      reject("Tên contract đã có trong hạng mục.");
      continue;
    }
    const providerProjectId = byKey.get(c.provider);
    if (!providerProjectId) {
      reject(`Bên cung cấp "${c.provider}" không thuộc hạng mục.`);
      continue;
    }
    const unknown = c.consumers.filter((k) => !byKey.has(k));
    if (unknown.length > 0) {
      reject(`Bên dùng "${unknown.join(", ")}" không thuộc hạng mục.`);
      continue;
    }
    const consumerProjectIds = [...new Set(c.consumers.map((k) => byKey.get(k) as string))];
    // `itemId` chỉ để qua schema; kiểm bên bằng đúng hàm của route để agent và người cùng luật.
    const err = checkContractParties(
      { itemId: crypto.randomUUID(), name: c.name, format: c.format, providerProjectId, consumerProjectIds },
      ids,
    );
    if (err) {
      reject(err);
      continue;
    }
    seen.add(c.name);
    drafts.push({ name: c.name, format: c.format, providerProjectId, consumerProjectIds, content: c.content });
  }
  return { drafts, rejected };
}

/**
 * Đội cần một checkpoint người cho contract: bên cung cấp trước rồi từng bên dùng, mỗi đội một lần dù có nhiều dự án
 * (D21, D23).
 */
export function contractCheckpointTeams(
  contract: Pick<ContractDraft, "providerProjectId" | "consumerProjectIds">,
  participants: readonly ContractParticipant[],
): string[] {
  const teamOf = new Map(participants.map((p) => [p.projectId, p.teamId]));
  const teams: string[] = [];
  for (const id of [contract.providerProjectId, ...contract.consumerProjectIds]) {
    const team = teamOf.get(id);
    if (team && !teams.includes(team)) teams.push(team);
  }
  return teams;
}

/** Bên dùng chỉ đổi được khi chưa có baseline: sau đó task bên dùng đã dựa vào danh sách cũ. */
export function canChangeConsumers(baselineVersion: number | null): boolean {
  return baselineVersion === null;
}

/**
 * Cảnh báo "Contract X đổi sau khi task T-n chạy" (US17 #3). Chỉ cảnh báo khi baseline này là bản sau bản đầu và có
 * task bên dùng bắt đầu chạy trước thời điểm baseline; task đang chạy không bị dừng nên người cần biết.
 */
export function contractBaselineWarnings(input: {
  name: string;
  baselineVersion: number | null;
  previousBaselineVersion: number | null;
  baselineAt: Date;
  consumerTasks: readonly { ref: string; projectId: string; firstRunAt: Date | null }[];
  consumerProjectIds: readonly string[];
}): string[] {
  if (input.baselineVersion === null || input.previousBaselineVersion === null) return [];
  const consumers = new Set(input.consumerProjectIds);
  return input.consumerTasks
    .filter((t) => consumers.has(t.projectId) && t.firstRunAt && t.firstRunAt < input.baselineAt)
    .map((t) => `Contract ${input.name} đổi sau khi task ${t.ref} chạy.`);
}

// ---- Đọc/ghi ------------------------------------------------------------------------------------------------------

type ArtifactRow = typeof sdlcArtifacts.$inferSelect;

interface Party extends ContractParticipant {
  role: "home" | "participant";
  settings: ProjectSdlcSettings;
}

const closed = () => new ConflictError("SDLC_ITEM_CLOSED", "Hạng mục đã xong hoặc đã huỷ.");

/** Dự án đang tham gia kèm key và cài đặt đã chụp; đường dẫn file contract theo `docsRoot` của từng repo. */
async function partiesOf(tx: Tx, itemId: string): Promise<Party[]> {
  const out: Party[] = [];
  for (const m of await activeItemProjects(tx, itemId)) {
    const project = await loadProject(tx, m.projectId);
    if (project)
      out.push({ projectId: m.projectId, key: project.key, teamId: m.teamId, role: m.role, settings: m.settings });
  }
  return out;
}

/** Tài liệu `scope: contract` của chế độ đã chụp; chế độ khai nhiều chỗ thì lấy giai đoạn đầu (thường là thiết kế). */
function contractDefinition(item: SdlcItemRow): { phase: SdlcPhase; artifact: SdlcArtifact } {
  for (const phase of item.mode.phases) {
    const artifact = phase.artifacts.find((a) => a.scope === "contract");
    if (artifact) return { phase, artifact };
  }
  throw new BadRequestError("SDLC_NO_CONTRACT", "Chế độ của hạng mục không có contract liên repo.");
}

/** Đường dẫn trong repo của một bên; repo không phải dự án chính mang `<home>-<NNN>` như tài liệu khác (D20). */
function contractPath(
  item: SdlcItemRow,
  artifact: SdlcArtifact,
  party: Party,
  homeKey: string,
  name: string,
  format: ContractFormat,
): string {
  const root = party.settings.docsRoot?.replace(/\/+$/, "");
  const template = root ? `${root}/${artifact.path}` : artifact.path;
  return renderRepoPath(template, {
    number: item.number,
    slug: item.slug,
    date: item.createdAt.toISOString().slice(0, 10),
    name,
    format,
    ...(party.role === "home" ? {} : { homeKey }),
  });
}

/** Đường dẫn không hợp lệ hoặc đã là file của hạng mục khác trong cùng repo thì từ chối trước khi ghi. */
async function rejectPathTaken(tx: Tx, paths: { projectId: string; repoPath: string }[]): Promise<void> {
  for (const p of paths) {
    const bad = checkRepoPath(p.repoPath);
    if (bad) throw new BadRequestError("SDLC_PATH_INVALID", `${bad} (${p.repoPath})`);
  }
  if (!paths.length) return;
  const [taken] = await tx
    .select({ path: sdlcArtifactSyncs.repoPath })
    .from(sdlcArtifactSyncs)
    .where(
      or(
        ...paths.map((p) =>
          and(eq(sdlcArtifactSyncs.projectId, p.projectId), eq(sdlcArtifactSyncs.repoPath, p.repoPath)),
        ),
      ),
    );
  if (taken) throw new ConflictError("SDLC_PATH_TAKEN", `Đường dẫn ${taken.path} đã thuộc một tài liệu khác.`);
}

async function contractNames(tx: Tx, itemId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ name: sdlcArtifacts.instance })
    .from(sdlcArtifacts)
    .where(and(eq(sdlcArtifacts.itemId, itemId), eq(sdlcArtifacts.scope, "contract")));
  return new Set(rows.map((r) => r.name));
}

async function insertCopies(
  tx: Tx,
  item: SdlcItemRow,
  row: ArtifactRow,
  copies: { projectId: string; repoPath: string }[],
): Promise<void> {
  if (!copies.length) return;
  await tx
    .insert(sdlcArtifactSyncs)
    .values(copies.map((c) => ({ orgId: item.orgId, artifactId: row.id, kind: "copy" as const, ...c })));
}

/**
 * Ghi một contract: dòng tài liệu (bắt buộc trước triển khai của mọi bên, D23), dòng đồng bộ nguồn và bản sao, bản nháp
 * đầu. Bên đã được kiểm ở người gọi; ở đây chỉ kiểm tên và đường dẫn.
 */
async function insertContract(
  tx: Tx,
  item: SdlcItemRow,
  parties: readonly Party[],
  draft: Omit<ContractDraft, "content"> & { content: string | null },
  author: Principal,
  source: "user" | "agent",
): Promise<ArtifactRow> {
  const { phase, artifact } = contractDefinition(item);
  if ((await contractNames(tx, item.id)).has(draft.name))
    throw new ConflictError("SDLC_CONTRACT_EXISTS", `Hạng mục đã có contract ${draft.name}.`);
  const byId = new Map(parties.map((p) => [p.projectId, p]));
  const home = parties.find((p) => p.role === "home");
  const provider = byId.get(draft.providerProjectId);
  if (!home || !provider) throw new BadRequestError("SDLC_CONTRACT_INVALID", "Bên cung cấp không thuộc hạng mục.");
  const pathOf = (p: Party) => contractPath(item, artifact, p, home.key, draft.name, draft.format);
  const source_ = { projectId: provider.projectId, repoPath: pathOf(provider) };
  const copies = draft.consumerProjectIds.flatMap((id) => {
    const p = byId.get(id);
    return p ? [{ projectId: id, repoPath: pathOf(p) }] : [];
  });
  await rejectPathTaken(tx, [source_, ...copies]);
  const [row] = await tx
    .insert(sdlcArtifacts)
    .values({
      orgId: item.orgId,
      projectId: provider.projectId,
      itemId: item.id,
      phaseId: phase.id,
      artifactId: artifact.id,
      required: true,
      scope: "contract",
      instance: draft.name,
      consumerProjectIds: draft.consumerProjectIds,
      contractFormat: draft.format,
      docKey: sdlcDocKey({
        homeKey: home.key,
        number: item.number,
        slug: item.slug,
        artifactId: artifact.id,
        scope: "contract",
        instance: draft.name,
      }),
      repoPath: source_.repoPath,
    })
    .returning();
  if (!row) throw new ConflictError("SDLC_CONTRACT_EXISTS", `Hạng mục đã có contract ${draft.name}.`);
  await tx.insert(sdlcArtifactSyncs).values({ orgId: item.orgId, artifactId: row.id, kind: "source", ...source_ });
  await insertCopies(tx, item, row, copies);
  const content = draft.content ?? artifact.template ?? null;
  if (content !== null) {
    try {
      await saveDraft(tx, author, {
        key: row.docKey,
        title: `Contract ${draft.name} · ${sdlcItemRef(item.number)} ${item.title}`.slice(0, 200),
        content,
        revision: 0,
      });
    } catch (e) {
      // Như bản nháp theo khuôn lúc tạo hạng mục: không ghi được bản nháp thì contract vẫn có, người soạn viết sau.
      if (!(e instanceof ForbiddenError) && !(e instanceof ConflictError)) throw e;
    }
  }
  await recordAudit(tx, {
    action: "sdlc.contract.create",
    targetType: "sdlc_item",
    targetId: item.id,
    data: {
      artifactId: row.id,
      name: draft.name,
      format: draft.format,
      providerProjectId: draft.providerProjectId,
      consumerProjectIds: draft.consumerProjectIds,
      source,
    },
  });
  return row;
}

async function openItem(tx: Tx, userId: string, itemId: string): Promise<SdlcItemRow> {
  const item = await itemForUser(tx, userId, itemId, true);
  if (item.status === "done" || item.status === "cancelled") throw closed();
  return item;
}

async function viewOf(tx: Tx, item: SdlcItemRow, row: ArtifactRow): Promise<SdlcArtifactView> {
  const [view] = await artifactViews(tx, item, [row]);
  if (!view) throw new NotFoundError("SDLC_CONTRACT_NOT_FOUND", "Không tìm thấy contract.");
  return view;
}

/** `contracts.create`: người tạo cần `sdlc.write` ở đội của bên cung cấp và mọi bên dùng (FR-051). */
export async function createContract(tx: Tx, userId: string, raw: SdlcContractInput): Promise<SdlcArtifactView> {
  const input = sdlcContractInput.parse(raw);
  const item = await openItem(tx, userId, input.itemId);
  const parties = await partiesOf(tx, item.id);
  const err = checkContractParties(input, new Set(parties.map((p) => p.projectId)));
  if (err) throw new BadRequestError("SDLC_CONTRACT_INVALID", err);
  await requireProjectWrite(tx, userId, [input.providerProjectId, ...input.consumerProjectIds]);
  const row = await insertContract(tx, item, parties, { ...input, content: null }, { kind: "user", userId }, "user");
  return viewOf(tx, item, row);
}

/**
 * `contracts.update`: đổi bên dùng khi chưa có baseline. Cần quyền ở bên cung cấp, bên dùng mới và bên bị bỏ, vì việc
 * bỏ cũng đổi thứ đội đó phải cài.
 */
export async function updateContract(
  tx: Tx,
  userId: string,
  input: { id: string; consumerProjectIds: string[] },
): Promise<SdlcArtifactView> {
  const [found] = await tx
    .select()
    .from(sdlcArtifacts)
    .where(and(eq(sdlcArtifacts.id, input.id), eq(sdlcArtifacts.scope, "contract")));
  if (!found) throw new NotFoundError("SDLC_CONTRACT_NOT_FOUND", "Không tìm thấy contract.");
  const item = await openItem(tx, userId, found.itemId);
  // Đọc lại sau khi khoá hạng mục: baseline có thể vừa tới.
  const [row] = await tx.select().from(sdlcArtifacts).where(eq(sdlcArtifacts.id, found.id));
  if (!row) throw new NotFoundError("SDLC_CONTRACT_NOT_FOUND", "Không tìm thấy contract.");
  if (!canChangeConsumers(row.baselineVersion))
    throw new ConflictError("SDLC_CONTRACT_LOCKED", "Contract đã được duyệt; không đổi bên dùng được nữa.");
  const parties = await partiesOf(tx, item.id);
  const err = checkContractParties(
    {
      itemId: item.id,
      name: row.instance,
      format: (row.contractFormat ?? "markdown") as ContractFormat,
      providerProjectId: row.projectId,
      consumerProjectIds: input.consumerProjectIds,
    },
    new Set(parties.map((p) => p.projectId)),
  );
  if (err) throw new BadRequestError("SDLC_CONTRACT_INVALID", err);
  await requireProjectWrite(tx, userId, [row.projectId, ...row.consumerProjectIds, ...input.consumerProjectIds]);

  const before = new Set(row.consumerProjectIds);
  const after = new Set(input.consumerProjectIds);
  const removed = row.consumerProjectIds.filter((id) => !after.has(id));
  if (removed.length)
    await tx
      .delete(sdlcArtifactSyncs)
      .where(
        and(
          eq(sdlcArtifactSyncs.artifactId, row.id),
          eq(sdlcArtifactSyncs.kind, "copy"),
          inArray(sdlcArtifactSyncs.projectId, removed),
        ),
      );
  const home = parties.find((p) => p.role === "home");
  const { artifact } = contractDefinition(item);
  const added = parties.filter((p) => after.has(p.projectId) && !before.has(p.projectId));
  const copies = added.map((p) => ({
    projectId: p.projectId,
    repoPath: contractPath(
      item,
      artifact,
      p,
      home?.key ?? "",
      row.instance,
      (row.contractFormat ?? "markdown") as ContractFormat,
    ),
  }));
  await rejectPathTaken(tx, copies);
  await insertCopies(tx, item, row, copies);
  const [updated] = await tx
    .update(sdlcArtifacts)
    .set({ consumerProjectIds: input.consumerProjectIds })
    .where(eq(sdlcArtifacts.id, row.id))
    .returning();
  await tx.update(sdlcItems).set({ updatedAt: sql`now()` }).where(eq(sdlcItems.id, item.id));
  await recordAudit(tx, {
    action: "sdlc.contract.update",
    targetType: "sdlc_item",
    targetId: item.id,
    data: { artifactId: row.id, name: row.instance, from: row.consumerProjectIds, to: input.consumerProjectIds },
  });
  return viewOf(tx, item, updated ?? row);
}

/**
 * `sdlc_report kind contracts` của run soạn (T022): mỗi contract hợp lệ thành một dòng và bản nháp của run; contract
 * sai bị bỏ riêng kèm lý do. Run chạy thay chủ hạng mục nên không kiểm quyền người ở đây.
 */
export async function contractsFromRunReport(
  tx: Tx,
  itemId: string,
  report: Extract<SdlcReportInput, { kind: "contracts" }>,
  author: Principal,
): Promise<{ created: string[]; rejected: ContractRejection[] }> {
  const [item] = await tx.select().from(sdlcItems).where(eq(sdlcItems.id, itemId)).for("update");
  if (!item) throw new NotFoundError("SDLC_ITEM_NOT_FOUND", "Không tìm thấy hạng mục.");
  if (item.status === "done" || item.status === "cancelled") throw closed();
  const parties = await partiesOf(tx, item.id);
  const { drafts, rejected } = contractsFromReport(report, parties, await contractNames(tx, item.id));
  const created: string[] = [];
  for (const d of drafts) {
    try {
      created.push((await insertContract(tx, item, parties, d, author, "agent")).docKey);
    } catch (e) {
      if (!(e instanceof BadRequestError) && !(e instanceof ConflictError)) throw e;
      rejected.push({ name: d.name, reason: e.message });
    }
  }
  return { created, rejected };
}

/**
 * Cảnh báo "Contract X đổi sau khi task T-n chạy" cho trang hạng mục. Thời điểm baseline lấy từ lịch sử tài liệu (đọc
 * bằng quyền chủ hạng mục như `onBaseline`); không đọc được thì bỏ qua cảnh báo thay vì làm hỏng cả trang.
 */
export async function contractWarnings(tx: Tx, item: SdlcItemRow): Promise<string[]> {
  const rows = await tx
    .select()
    .from(sdlcArtifacts)
    .where(
      and(
        eq(sdlcArtifacts.itemId, item.id),
        eq(sdlcArtifacts.scope, "contract"),
        sql`${sdlcArtifacts.baselineVersion} > 1`,
      ),
    );
  if (!rows.length) return [];
  const consumers = [...new Set(rows.flatMap((r) => r.consumerProjectIds))];
  const tasks = consumers.length
    ? await tx
        .select({
          projectId: sdlcItemTasks.projectId,
          // sdlc không import tasks/runs (runs gọi cổng của sdlc); hỏi bảng của chúng bằng SQL như participants.ts.
          ref: sql<string>`(select t.key from hive.tasks t where t.id = ${sdlcItemTasks.taskId})`,
          firstRunAt: sql<Date | null>`(select min(r.created_at) from hive.runs r where r.task_id = ${sdlcItemTasks.taskId})`,
        })
        .from(sdlcItemTasks)
        .where(and(eq(sdlcItemTasks.itemId, item.id), inArray(sdlcItemTasks.projectId, consumers)))
    : [];
  const consumerTasks = tasks.map((t) => ({
    ref: t.ref,
    projectId: t.projectId,
    firstRunAt: t.firstRunAt ? new Date(t.firstRunAt) : null,
  }));
  const out: string[] = [];
  for (const row of rows) {
    let baselineAt: Date | null = null;
    try {
      const history = await docHistory(tx, { kind: "user", userId: item.ownerUserId }, { key: row.docKey });
      const at = history.find((v) => v.version === row.baselineVersion)?.createdAt;
      baselineAt = at ? new Date(at) : null;
    } catch {
      baselineAt = null;
    }
    if (!baselineAt) continue;
    out.push(
      ...contractBaselineWarnings({
        name: row.instance,
        baselineVersion: row.baselineVersion,
        previousBaselineVersion: (row.baselineVersion ?? 1) - 1,
        baselineAt,
        consumerTasks,
        consumerProjectIds: row.consumerProjectIds,
      }),
    );
  }
  return out;
}

// ---- Route `contracts.*` -------------------------------------------------------------------------------------------

/** Hàm đăng ký riêng để router.ts chỉ thêm một dòng `contracts: contractRoutes(deps)` (T070 gộp). */
export function contractRoutes(deps: OrgDeps) {
  const { authed, inOrg } = orgMiddlewares(deps);
  const os = implement(contract.sdlc.contracts).$context<RequestContext>().use(authed).use(inOrg);
  return {
    create: os.create.handler(({ context: { tx, user }, input }) => createContract(tx, user.id, input)),
    update: os.update.handler(({ context: { tx, user }, input }) => updateContract(tx, user.id, input)),
  };
}
