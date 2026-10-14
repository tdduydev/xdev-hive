import {
  renderRepoPath,
  SDLC_PRESET_IDS,
  SDLC_PRESETS,
  type SdlcMode,
  type SdlcModeDryRun,
  type SdlcModeSaveInput,
  type SdlcModeView,
  type SdlcSize,
  sdlcDocKey,
  sdlcMode,
  sdlcModeDryRunInput,
  sdlcModeSaveInput,
  sdlcModeWarnings,
  sdlcSlug,
} from "@xdev-hive/contracts";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { recordAudit } from "../audit/index.ts";
import { findProject } from "../catalog/index.ts";
import { loadPolicy } from "../governance/index.ts";
import { docTypeOf, gateApplies } from "../knowledge/index.ts";
import { BadRequestError, ConflictError, NotFoundError, type Tx } from "../platform/index.ts";
import { allowWith, requireOrgRole, requireTeamRole, teams, visibleTeamIds } from "../tenancy/index.ts";
import { sdlcItems, sdlcModes } from "./schema.ts";

/**
 * Chế độ AI SDLC (spec 011 US8, FR-001..FR-004). Preset là hằng trong contracts, chỉ đọc; chế độ tự tạo nằm ở
 * `sdlc_modes` theo đội hoặc tổ chức. Mỗi hạng mục chụp chế độ lúc tạo (D2), nên sửa hay xoá ở đây không đổi luật của
 * hạng mục đang mở.
 */

const OPEN_STATUSES = ["active", "paused"] as const;

const presetRefs = (): [string, SdlcMode][] =>
  Object.entries(SDLC_PRESETS).flatMap(([id, mode]) => (mode ? [[id, mode] as [string, SdlcMode]] : []));

const isPreset = (slug: string) => (SDLC_PRESET_IDS as readonly string[]).includes(slug);

/** Số hạng mục đang mở theo `mode_ref` (preset id hoặc slug), để trang hiện "N hạng mục còn dùng bản cũ". */
async function openItemCounts(tx: Tx): Promise<Map<string, number>> {
  const rows = await tx
    .select({ ref: sdlcItems.modeRef, n: sql<number>`count(*)::int` })
    .from(sdlcItems)
    .where(inArray(sdlcItems.status, [...OPEN_STATUSES]))
    .groupBy(sdlcItems.modeRef);
  return new Map(rows.map((r) => [r.ref, r.n]));
}

function customView(row: typeof sdlcModes.$inferSelect, openItems: number): SdlcModeView | null {
  // Định nghĩa lưu từ bản contracts cũ mà nay không còn parse được thì bỏ khỏi danh sách thay vì làm hỏng cả trang.
  const parsed = sdlcMode.safeParse(row.definition);
  if (!parsed.success) return null;
  return {
    ref: row.id,
    preset: false,
    teamId: row.teamId,
    slug: row.slug,
    basePreset: row.basePreset,
    version: row.version,
    enabled: row.enabled,
    definition: parsed.data,
    openItems,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Preset và chế độ tự tạo mà người dùng thấy: của tổ chức, cộng của các đội họ có vai trò (hoặc đúng `teamId` nếu lọc).
 * Preset đứng đầu để trang mặc định mở ra bộ có sẵn.
 */
export async function listModes(tx: Tx, userId: string, opts: { teamId?: string | undefined } = {}) {
  await requireOrgRole(tx, userId, "member");
  const counts = await openItemCounts(tx);
  const presets: SdlcModeView[] = presetRefs().map(([id, definition]) => ({
    ref: id,
    preset: true,
    teamId: null,
    slug: id,
    basePreset: null,
    version: 1,
    enabled: true,
    definition,
    openItems: counts.get(id) ?? 0,
    updatedAt: null,
  }));
  // Lọc theo đội cũng không mở chế độ của đội mà người xem không có vai trò.
  const mine = await visibleTeamIds(tx, userId);
  const visible = opts.teamId ? mine.filter((t) => t === opts.teamId) : mine;
  const rows = await tx
    .select()
    .from(sdlcModes)
    .where(or(isNull(sdlcModes.teamId), visible.length ? inArray(sdlcModes.teamId, visible) : undefined))
    .orderBy(desc(sdlcModes.updatedAt));
  const custom = rows.flatMap((r) => customView(r, counts.get(r.slug) ?? 0) ?? []);
  return [...presets, ...custom];
}

export interface ResolvedMode {
  /** Preset id hoặc slug: giá trị lưu ở `sdlc_items.mode_ref` và `settings.sdlc.defaultMode`. */
  ref: string;
  preset: boolean;
  version: number;
  definition: SdlcMode;
}

/**
 * Chế độ theo preset id hoặc slug cho một đội: chế độ tắt, của đội khác hay không parse được thì coi như không có.
 * Preset không bị chế độ tự tạo che vì slug trùng preset bị từ chối lúc lưu.
 */
export async function resolveMode(tx: Tx, ref: string, teamId: string): Promise<ResolvedMode | null> {
  const preset = isPreset(ref) ? SDLC_PRESETS[ref as keyof typeof SDLC_PRESETS] : undefined;
  if (preset) return { ref, preset: true, version: 1, definition: preset };
  const [row] = await tx
    .select()
    .from(sdlcModes)
    .where(
      and(
        eq(sdlcModes.slug, ref),
        eq(sdlcModes.enabled, true),
        or(isNull(sdlcModes.teamId), eq(sdlcModes.teamId, teamId)),
      ),
    );
  const parsed = row && sdlcMode.safeParse(row.definition);
  return row && parsed?.success
    ? { ref: row.slug, preset: false, version: row.version, definition: parsed.data }
    : null;
}

// ---- Lưu, xoá --------------------------------------------------------------------------------------------------

/** Chế độ của đội do quản trị đội sửa, của tổ chức do quản trị tổ chức; vai trò tự tạo có `sdlc.modes.write` cũng được. */
async function requireModesWrite(tx: Tx, userId: string, teamId: string | null) {
  if (teamId)
    await allowWith(tx, userId, "sdlc.modes.write", () => requireTeamRole(tx, userId, teamId, "admin"), teamId);
  else await allowWith(tx, userId, "sdlc.modes.write", () => requireOrgRole(tx, userId, "admin"));
}

/**
 * Model của bước agent và của checkpoint AI không được ngoài danh sách chính sách agent (FR-003, như spec 009 FR-011).
 * Chính sách không có khái niệm cấm cả CLI: danh sách rỗng là không giới hạn. Bước không nêu CLI thì để lúc chạy:
 * `resolveModel` đưa model ngoài danh sách về model đầu, nên không có đường vòng chính sách.
 */
async function requireAllowedByPolicy(tx: Tx, mode: SdlcMode) {
  const policy = await loadPolicy(tx);
  const check = (cli: keyof typeof policy.allowedModels, model: string | undefined, where: string) => {
    const allowed = policy.allowedModels[cli];
    if (model && allowed.length && !allowed.includes(model))
      throw new BadRequestError(
        "SDLC_MODE_MODEL_FORBIDDEN",
        `Chính sách agent của tổ chức không cho dùng model ${model} với ${cli} (${where}). Chọn một trong: ${allowed.join(", ")}.`,
      );
  };
  for (const phase of mode.phases) {
    for (const step of phase.steps) if (step.cli) check(step.cli, step.model, `bước “${step.id}”`);
    for (const p of phase.gate)
      for (const gate of p.gates)
        for (const r of gate.ai?.reviewers ?? []) check(r.cli, r.model, `checkpoint “${gate.id}”`);
  }
}

/** Người có `sdlc.modes.write` qua vai trò tự tạo không nhất thiết là thành viên đội, nên kiểm đội tồn tại riêng. */
async function requireTeamExists(tx: Tx, teamId: string) {
  const [team] = await tx.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId));
  if (!team) throw new NotFoundError("TEAM_NOT_FOUND", "Không tìm thấy đội.");
}

export async function saveMode(tx: Tx, userId: string, raw: SdlcModeSaveInput): Promise<SdlcModeView> {
  const input: z.output<typeof sdlcModeSaveInput> = sdlcModeSaveInput.parse(raw);
  if (input.teamId) await requireTeamExists(tx, input.teamId);
  await requireModesWrite(tx, userId, input.teamId);
  if (isPreset(input.slug))
    throw new ConflictError("SDLC_MODE_SLUG_TAKEN", `Mã “${input.slug}” trùng một preset có sẵn. Đặt mã khác.`);
  await requireAllowedByPolicy(tx, input.definition);
  const base = {
    teamId: input.teamId,
    name: input.definition.name,
    method: input.definition.method,
    basePreset: input.basePreset,
    // Lưu `id` đúng bằng slug để hạng mục chụp ra `modeRef` khớp với định nghĩa bên trong.
    definition: { ...input.definition, id: input.slug },
    enabled: input.enabled,
  };

  let row: typeof sdlcModes.$inferSelect | undefined;
  if (input.id) {
    const [old] = await tx.select().from(sdlcModes).where(eq(sdlcModes.id, input.id)).for("update");
    if (!old) throw new NotFoundError("SDLC_MODE_NOT_FOUND", "Không tìm thấy chế độ.");
    if (old.slug !== input.slug)
      throw new BadRequestError(
        "SDLC_MODE_SLUG_FIXED",
        "Mã chế độ cố định sau khi tạo vì dự án và hạng mục tham chiếu theo mã; nhân bản nếu muốn mã khác.",
      );
    // Chuyển chế độ sang đội khác hoặc lên tổ chức cần quyền ở cả hai phía.
    await requireModesWrite(tx, userId, old.teamId);
    [row] = await tx
      .update(sdlcModes)
      .set({ ...base, version: sql`${sdlcModes.version} + 1`, updatedAt: sql`now()` })
      .where(eq(sdlcModes.id, input.id))
      .returning();
  } else {
    [row] = await tx
      .insert(sdlcModes)
      .values({ ...base, orgId: sql`hive.ctx_org()`, slug: input.slug, createdBy: userId })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new ConflictError("SDLC_MODE_SLUG_TAKEN", `Tổ chức đã có chế độ mã “${input.slug}”.`);
  }
  if (!row) throw new NotFoundError("SDLC_MODE_NOT_FOUND", "Không tìm thấy chế độ.");
  const counts = await openItemCounts(tx);
  await recordAudit(tx, {
    action: "sdlc.mode.save",
    targetType: "sdlc_mode",
    targetId: row.id,
    data: {
      slug: row.slug,
      teamId: row.teamId,
      basePreset: row.basePreset,
      version: row.version,
      enabled: row.enabled,
      created: !input.id,
      // Cảnh báo không chặn lưu (US8-3); audit giữ để soát chế độ bị cấu hình vô tác dụng.
      warnings: sdlcModeWarnings(input.definition),
    },
  });
  const view = customView(row, counts.get(row.slug) ?? 0);
  if (!view) throw new BadRequestError("SDLC_MODE_INVALID", "Chế độ vừa lưu không đọc lại được.");
  return view;
}

export async function removeMode(tx: Tx, userId: string, id: string): Promise<{ ok: true }> {
  const [row] = await tx.select().from(sdlcModes).where(eq(sdlcModes.id, id)).for("update");
  if (!row) throw new NotFoundError("SDLC_MODE_NOT_FOUND", "Không tìm thấy chế độ.");
  await requireModesWrite(tx, userId, row.teamId);
  const counts = await openItemCounts(tx);
  await tx.delete(sdlcModes).where(eq(sdlcModes.id, id));
  await recordAudit(tx, {
    action: "sdlc.mode.remove",
    targetType: "sdlc_mode",
    targetId: id,
    // Hạng mục mở giữ bản chụp nên xoá không dừng chúng; ghi số lượng để người soát biết ảnh hưởng.
    data: { slug: row.slug, teamId: row.teamId, openItems: counts.get(row.slug) ?? 0 },
  });
  return { ok: true };
}

// ---- Chạy thử --------------------------------------------------------------------------------------------------

export interface DryRunContext {
  /** Số hạng mục mẫu: số kế tiếp của dự án chính. */
  number: number;
  /** YYYY-MM-DD. */
  date: string;
  participants: string[];
}

/**
 * Đường dẫn tài liệu và cổng của từng giai đoạn nếu tạo hạng mục lúc này (FR-004). Thuần, không ghi gì. Điều kiện của
 * checkpoint (loại tài liệu, từ khoá, số dòng đổi) xét trên tiêu đề và khuôn của tài liệu chính của giai đoạn, nên tiêu
 * đề mẫu nhắc "hoàn tiền" sẽ làm checkpoint từ khoá "hoàn tiền" chạy.
 */
export function planDryRun(
  mode: SdlcMode,
  input: { projectKey: string; title: string; size?: SdlcSize | undefined },
  ctx: DryRunContext,
): SdlcModeDryRun {
  const slug = sdlcSlug(input.title);
  const home = input.projectKey;
  const common = { homeKey: home, number: ctx.number, slug };
  const phases = mode.phases.map((phase) => {
    const skipped = Boolean(input.size && phase.sizes.length && !phase.sizes.includes(input.size));
    const artifacts = phase.artifacts.flatMap((a) => {
      const vars = { number: ctx.number, slug, date: ctx.date, ...(a.perUnit ? { unit: "unit-1" } : {}) };
      if (a.scope === "contract") {
        const name = "contract-mau";
        return [
          {
            artifactId: a.id,
            path: renderRepoPath(a.path, { ...vars, name, format: "openapi" }),
            docKey: sdlcDocKey({ ...common, artifactId: a.id, scope: "contract", instance: name }),
          },
        ];
      }
      if (a.scope === "project")
        return [home, ...ctx.participants].map((key) => ({
          artifactId: a.id,
          // Repo tham gia không phải dự án chính: `{NNN}` thành `<home>-<NNN>` để không trùng số hạng mục của repo đó.
          path: renderRepoPath(a.path, key === home ? vars : { ...vars, homeKey: home }),
          docKey: sdlcDocKey({ ...common, artifactId: a.id, scope: "project", instance: key }),
        }));
      return [
        {
          artifactId: a.id,
          path: renderRepoPath(a.path, vars),
          docKey: sdlcDocKey({ ...common, artifactId: a.id, scope: "item" }),
        },
      ];
    });
    const main = phase.artifacts[0];
    const mainKey = artifacts[0]?.docKey ?? "";
    const content = `${input.title}\n\n${main?.template ?? ""}`;
    const gates = phase.gate.flatMap((p) =>
      p.gates.map((gate) => {
        // Giai đoạn bị bỏ vì cỡ thì không checkpoint nào chạy, bất kể điều kiện.
        const applies = skipped
          ? { runs: false, reason: `Giai đoạn bỏ qua với cỡ ${input.size}.` }
          : gateApplies(gate, { docType: docTypeOf(mainKey), content, base: "" });
        return {
          gateId: gate.id,
          name: gate.name,
          runs: applies.runs,
          reason: applies.reason,
          autoApprove: Boolean(phase.autoApprove?.gates.includes(gate.id)),
        };
      }),
    );
    return { id: phase.id, name: phase.name, kind: phase.kind, skipped, artifacts, gates };
  });
  return { phases, warnings: sdlcModeWarnings(mode) };
}

export async function dryRunMode(tx: Tx, userId: string, raw: unknown): Promise<SdlcModeDryRun> {
  const input = sdlcModeDryRunInput.parse(raw);
  const project = await findProject(tx, input.projectKey);
  if (!project) throw new NotFoundError("PROJECT_NOT_FOUND", `Không tìm thấy dự án ${input.projectKey}.`);
  await allowWith(tx, userId, "sdlc.read", () => requireTeamRole(tx, userId, project.teamId, "viewer"), project.teamId);
  for (const key of input.participants)
    if (!(await findProject(tx, key)))
      throw new NotFoundError("PROJECT_NOT_FOUND", `Không tìm thấy dự án tham gia ${key}.`);
  const [last] = await tx
    .select({ n: sql<number>`coalesce(max(${sdlcItems.number}), 0)::int` })
    .from(sdlcItems)
    .where(eq(sdlcItems.projectId, project.id));
  return planDryRun(input.mode, input, {
    number: (last?.n ?? 0) + 1,
    date: new Date().toISOString().slice(0, 10),
    participants: input.participants,
  });
}
