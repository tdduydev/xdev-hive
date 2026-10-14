import {
  type ProjectSettings,
  type RunGateMissing,
  SDLC_BLOCKING_ORDER,
  SDLC_GATE_BLOCKED,
  type SdlcBlocking,
  type SdlcMode,
  sdlcDocKey,
  TASK_DEPENDENCIES_OPEN,
} from "@xdev-hive/contracts";
import { and, asc, eq, isNull } from "drizzle-orm";
import { loadProject } from "../catalog/index.ts";
import type { Tx } from "../platform/index.ts";
import { dependenciesOf } from "../tasks/index.ts";
import { sdlcArtifacts, sdlcItemPhases, sdlcItemProjects, sdlcItems, sdlcItemTasks, sdlcOverrides } from "./schema.ts";

type ArtifactMissing = Extract<RunGateMissing, { kind: "artifact" }>;

export interface GatePhase {
  phaseIndex: number;
  phaseId: string;
  kind: string;
  status: string;
}

export interface GateArtifact {
  phaseId: string;
  artifactId: string;
  required: boolean;
  scope: "item" | "project" | "contract";
  instance: string;
  projectId: string;
  consumerProjectIds: string[];
  docKey: string;
  baselineVersion: number | null;
  approval: "none" | "human" | "auto" | "revoked" | "reaffirmed";
}

export interface GateOverride {
  id: string;
  taskId: string | null;
  projectId: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export type CodeRunGate =
  | {
      block: true;
      code: typeof SDLC_GATE_BLOCKED | typeof TASK_DEPENDENCIES_OPEN;
      message: string;
      itemId: string;
      missing: RunGateMissing[];
    }
  | {
      block: false;
      /** Chặn mềm: run vẫn chạy, engine ghi cảnh báo vào sự kiện run. */
      warn?: string;
      /** Ngoại lệ đã cho run qua, để engine ghi `sdlc.override_used`. */
      overrideId?: string;
      itemId?: string;
    };

const PASS: CodeRunGate = { block: false };

/** Mức chặt nhất; không mức nào được khai thì chặn cứng, vì mặc định của chế độ là `hard`. */
export function strictestBlocking(...levels: (SdlcBlocking | null | undefined)[]): SdlcBlocking {
  const rank = (l: SdlcBlocking) => SDLC_BLOCKING_ORDER.indexOf(l);
  let best: SdlcBlocking | null = null;
  for (const level of levels) if (level && (best === null || rank(level) > rank(best))) best = level;
  return best ?? "hard";
}

/**
 * Ngoại lệ còn hiệu lực cho task. Phạm vi hẹp nhất thắng để audit ghi đúng ngoại lệ đã dùng. Hết hạn hay thu hồi thì
 * không tính, nhưng run đã tạo trước đó vẫn chạy tiếp (cổng chỉ kiểm lúc tạo run).
 */
export function activeOverride(
  overrides: readonly GateOverride[],
  scope: { taskId: string; projectId: string },
  now: Date,
): GateOverride | null {
  const live = overrides.filter((o) => !o.revokedAt && (!o.expiresAt || o.expiresAt > now));
  return (
    live.find((o) => o.taskId === scope.taskId) ??
    live.find((o) => !o.taskId && o.projectId === scope.projectId) ??
    live.find((o) => !o.taskId && !o.projectId) ??
    null
  );
}

const baseName = (path: string) => path.split("/").pop() || path;

/**
 * Tài liệu bắt buộc chưa có baseline của dự án `project`: mọi giai đoạn trước `implementation` (không `skipped`), lấy
 * tài liệu chung, tài liệu riêng của dự án và contract dự án cung cấp hay dùng (FR-055). Tài liệu chung và riêng suy từ
 * chế độ đã chụp chứ không chỉ từ các dòng đang có: dòng chưa được tạo thì vẫn là chưa có baseline, tránh cổng mở nhầm.
 */
export function missingArtifacts(input: {
  item: { number: number; slug: string; mode: SdlcMode };
  homeKey: string;
  project: { id: string; key: string };
  phases: readonly GatePhase[];
  artifacts: readonly GateArtifact[];
}): ArtifactMissing[] {
  const { item, homeKey, project, phases, artifacts } = input;
  const implementation = phases.find((p) => p.kind === "implementation")?.phaseIndex ?? Number.POSITIVE_INFINITY;
  const out: ArtifactMissing[] = [];
  for (const phase of phases) {
    if (phase.phaseIndex >= implementation || phase.status === "skipped") continue;
    const modePhase = item.mode.phases.find((p) => p.id === phase.phaseId);
    const phaseName = modePhase?.name ?? phase.phaseId;
    const state = (row: GateArtifact | undefined): ArtifactMissing["reason"] | null =>
      row?.approval === "revoked" ? "revoked" : row?.baselineVersion == null ? "no_baseline" : null;

    for (const art of modePhase?.artifacts ?? []) {
      if (!art.required || art.scope === "contract") continue;
      const instance = art.scope === "project" ? project.key : "";
      const row = artifacts.find(
        (a) => a.phaseId === phase.phaseId && a.artifactId === art.id && a.instance === instance,
      );
      const reason = state(row);
      if (!reason) continue;
      out.push({
        kind: "artifact",
        docKey:
          row?.docKey ??
          sdlcDocKey({
            homeKey,
            number: item.number,
            slug: item.slug,
            artifactId: art.id,
            scope: art.scope,
            instance,
          }),
        name: `${baseName(art.path)} (${phaseName})`,
        phase: phaseName,
        reason,
      });
    }

    for (const row of artifacts) {
      if (row.phaseId !== phase.phaseId || row.scope !== "contract" || !row.required) continue;
      if (row.projectId !== project.id && !row.consumerProjectIds.includes(project.id)) continue;
      const reason = state(row);
      if (reason)
        out.push({ kind: "artifact", docKey: row.docKey, name: `contract ${row.instance}`, phase: phaseName, reason });
    }
  }
  return out;
}

const REASON_TEXT: Record<ArtifactMissing["reason"], string> = {
  no_baseline: "chưa duyệt",
  revoked: "đang duyệt lại sau khi thu hồi tự duyệt",
};

export interface GateInput {
  itemId: string;
  taskId: string;
  project: { id: string; key: string };
  /** Dự án còn trong hạng mục và đang bật AI SDLC. */
  projectActive: boolean;
  blocking: SdlcBlocking;
  openDependencies: { taskId: string; key: string; status: string }[];
  missing: ArtifactMissing[];
  overrides: readonly GateOverride[];
  now: Date;
}

/**
 * Phần quyết định thuần của `codeRunGate`. Dự án đã bỏ hay tắt AI SDLC thì không ngoại lệ nào mở được: ngoại lệ chỉ
 * bỏ qua tài liệu chưa duyệt và phụ thuộc chưa xong, còn dự án ngoài hạng mục thì task không còn thuộc quy trình này.
 */
export function evaluateGate(g: GateInput): CodeRunGate {
  if (!g.projectActive) {
    return {
      block: true,
      code: SDLC_GATE_BLOCKED,
      message: `Dự án ${g.project.key} đã tắt AI SDLC.`,
      itemId: g.itemId,
      missing: [{ kind: "project", projectId: g.project.id, key: g.project.key }],
    };
  }

  const reasons: RunGateMissing[] = g.openDependencies.map((d) => ({ kind: "dependency", ...d }));
  const docsChecked = g.blocking !== "none";
  const docs = docsChecked ? g.missing : [];
  const hardDocs = g.blocking === "hard" ? docs : [];
  const blocking: RunGateMissing[] = [...reasons, ...hardDocs];

  if (blocking.length === 0) {
    if (g.blocking === "soft" && docs.length > 0) {
      const list = docs.map((d) => `${d.name} ${REASON_TEXT[d.reason]}`).join("; ");
      return { block: false, itemId: g.itemId, warn: `Chạy khi chưa đủ tài liệu (chặn mềm): ${list}.` };
    }
    return { block: false, itemId: g.itemId };
  }

  const override = activeOverride(g.overrides, { taskId: g.taskId, projectId: g.project.id }, g.now);
  if (override) return { block: false, itemId: g.itemId, overrideId: override.id };

  const parts: string[] = [];
  if (reasons.length > 0)
    parts.push(`phụ thuộc chưa xong: ${g.openDependencies.map((d) => `${d.key} (${d.status})`).join(", ")}`);
  if (hardDocs.length > 0) parts.push(hardDocs.map((d) => `${d.name} ${REASON_TEXT[d.reason]}`).join("; "));
  return {
    block: true,
    code: reasons.length > 0 ? TASK_DEPENDENCIES_OPEN : SDLC_GATE_BLOCKED,
    message: `Chưa chạy được code: ${parts.join("; ")}. Quản trị đội có thể tạo ngoại lệ nếu cần chạy gấp.`,
    itemId: g.itemId,
    missing: blocking,
  };
}

/**
 * Cổng của `runs.queueRun` cho run code (D10). Task không thuộc hạng mục nào thì cho qua (SC-011); các loại run khác
 * (review, plan…) không bị chặn vì chúng chuẩn bị chứ không viết code.
 */
export async function codeRunGate(
  tx: Tx,
  input: { taskId: string; kind?: string | undefined; now?: Date | undefined },
): Promise<CodeRunGate> {
  if (input.kind && input.kind !== "code") return PASS;
  const [link] = await tx
    .select({ itemId: sdlcItemTasks.itemId, projectId: sdlcItemTasks.projectId })
    .from(sdlcItemTasks)
    .where(eq(sdlcItemTasks.taskId, input.taskId));
  if (!link) return PASS;
  const [item] = await tx.select().from(sdlcItems).where(eq(sdlcItems.id, link.itemId));
  if (!item) return PASS;

  const members = await tx.select().from(sdlcItemProjects).where(eq(sdlcItemProjects.itemId, item.id));
  const membership = members.find((m) => m.projectId === link.projectId && !m.removedAt);
  const home = members.find((m) => m.role === "home");
  const project = await loadProject(tx, link.projectId);
  const homeProject = home && home.projectId !== link.projectId ? await loadProject(tx, home.projectId) : project;
  if (!project) return PASS;
  const sdlc: ProjectSettings["sdlc"] = project.settings.sdlc;

  const phases = await tx
    .select({
      phaseIndex: sdlcItemPhases.phaseIndex,
      phaseId: sdlcItemPhases.phaseId,
      kind: sdlcItemPhases.kind,
      status: sdlcItemPhases.status,
    })
    .from(sdlcItemPhases)
    .where(eq(sdlcItemPhases.itemId, item.id))
    .orderBy(asc(sdlcItemPhases.phaseIndex));
  const artifacts = await tx.select().from(sdlcArtifacts).where(eq(sdlcArtifacts.itemId, item.id));
  const overrides = await tx
    .select()
    .from(sdlcOverrides)
    .where(and(eq(sdlcOverrides.itemId, item.id), isNull(sdlcOverrides.revokedAt)));
  const blockedBy = (await dependenciesOf(tx, [input.taskId])).get(input.taskId)?.blockedBy ?? [];

  return evaluateGate({
    itemId: item.id,
    taskId: input.taskId,
    project: { id: project.id, key: project.key },
    projectActive: !!membership && sdlc?.enabled === true,
    blocking: strictestBlocking(item.mode.blocking, membership?.settings.blocking, sdlc?.blocking),
    openDependencies: blockedBy.map((d) => ({ taskId: d.id, key: d.key, status: d.status })),
    missing: missingArtifacts({
      item,
      homeKey: homeProject?.key ?? project.key,
      project: { id: project.id, key: project.key },
      phases,
      artifacts,
    }),
    overrides,
    now: input.now ?? new Date(),
  });
}
