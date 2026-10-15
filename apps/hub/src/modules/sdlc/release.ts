import { type SdlcReportInput, sdlcItemRef } from "@xdev-hive/contracts";
import { and, asc, eq, sql } from "drizzle-orm";
import { loadProject } from "../catalog/index.ts";
import { createProposal, getDoc, type Principal, startReview } from "../knowledge/index.ts";
import { BadRequestError, NotFoundError, type Tx } from "../platform/index.ts";
import { activeItemProjects, type SdlcItemRow } from "./access.ts";
import { sdlcArtifacts, sdlcItemPhases, sdlcQuestions } from "./schema.ts";
import { itemTrace } from "./trace.ts";

/*
 * Giai đoạn release (US11, FR-036): bước `release-notes` và `retro` soạn tài liệu như bước `draft`, hub chỉ chuẩn bị dữ
 * liệu phát hành (PR đã merge, truy vết, chỉ số của hạng mục) thành một file seed. Bài học của retro thành đề xuất thường
 * cho constitution/steering của dự án, đi quy trình duyệt tài liệu như mọi đề xuất khác.
 */

export const RELEASE_ACTIONS: readonly string[] = ["release-notes", "retro"];

const hours = (from: Date | null, to: Date | null) =>
  from && to ? `${Math.max(0, (to.getTime() - from.getTime()) / 3_600_000).toFixed(1)} giờ` : "chưa xong";
const pct = (n: number) => `${n}%`;

/**
 * Markdown cho agent đọc trong worktree. Câu chữ requirement đọc bằng quyền chủ hạng mục như các bước soạn; task không
 * gắn requirement không có trong truy vết nên không có dòng PR.
 */
export async function releaseBrief(tx: Tx, item: SdlcItemRow): Promise<string> {
  const ref = sdlcItemRef(item.number);
  const trace = await itemTrace(tx, item.ownerUserId, item);
  const tasks = new Map<
    string,
    { key: string; projectKey: string; prUrl: string | null; sha: string | null; reqs: string[] }
  >();
  for (const row of trace.rows)
    for (const t of row.tasks) {
      const seen = tasks.get(t.taskId);
      if (seen) seen.reqs.push(row.requirementId);
      else
        tasks.set(t.taskId, {
          key: t.key,
          projectKey: t.projectKey,
          prUrl: t.prUrl,
          sha: t.mergeSha,
          reqs: [row.requirementId],
        });
    }
  const merged = [...tasks.entries()].filter(([, t]) => t.sha);
  const lines = [`# Dữ liệu phát hành của hạng mục ${ref} · ${item.title}`, "", "## PR đã merge", ""];
  if (!merged.length) lines.push("Chưa có PR nào merge.");
  for (const [id, t] of merged)
    lines.push(
      `- ${t.projectKey} ${t.key} · ${trace.titles.get(id) ?? ""} · ${t.reqs.join(", ")} · ${t.prUrl ?? "không có link PR"} · merge ${t.sha?.slice(0, 7)}`,
    );
  const open = [...tasks.values()].filter((t) => !t.sha);
  if (open.length) lines.push("", `Task chưa merge: ${open.map((t) => `${t.projectKey} ${t.key}`).join(", ")}.`);

  const { total } = trace;
  lines.push(
    "",
    "## Độ phủ requirement",
    "",
    `${total.requirements} requirement · kế hoạch ${pct(total.planned)} · đã làm ${pct(total.done)} · đã kiểm ${pct(total.verified)}.`,
  );
  const unverified = trace.rows.filter((r) => !r.verified).map((r) => r.requirementId);
  if (unverified.length) lines.push(`Chưa kiểm: ${unverified.join(", ")}.`);
  for (const p of trace.byProject)
    lines.push(
      `- ${p.projectKey}: kế hoạch ${pct(p.coverage.planned)}, đã làm ${pct(p.coverage.done)}, đã kiểm ${pct(p.coverage.verified)}`,
    );

  const phases = await tx
    .select()
    .from(sdlcItemPhases)
    .where(eq(sdlcItemPhases.itemId, item.id))
    .orderBy(asc(sdlcItemPhases.phaseIndex));
  const asked = await tx
    .select({ phaseId: sdlcQuestions.phaseId, n: sql<number>`count(*)::int` })
    .from(sdlcQuestions)
    .where(and(eq(sdlcQuestions.itemId, item.id), sql`${sdlcQuestions.status} <> 'withdrawn'`))
    .groupBy(sdlcQuestions.phaseId);
  const askedIn = new Map(asked.map((q) => [q.phaseId, q.n]));
  lines.push(
    "",
    "## Chỉ số theo giai đoạn",
    "",
    "| Giai đoạn | Trạng thái | Thời gian | Câu hỏi |",
    "|---|---|---|---|",
  );
  for (const p of phases) {
    const name = item.mode.phases.find((d) => d.id === p.phaseId)?.name ?? p.phaseId;
    const time = p.status === "skipped" ? "bỏ qua" : hours(p.startedAt, p.approvedAt);
    lines.push(`| ${name} | ${p.status} | ${time} | ${askedIn.get(p.phaseId) ?? 0} |`);
  }
  lines.push(
    "",
    `Số vòng converge: ${item.convergeRound}${item.convergedAt ? " (đã hội tụ)" : ""}. Từ lúc tạo: ${hours(item.createdAt, new Date())}.`,
  );
  return `${lines.join("\n")}\n`;
}

/** Tài liệu release notes của hạng mục để link trong bình luận issue; null khi chế độ không có bước `release-notes`. */
export async function releaseNotesPath(tx: Tx, item: SdlcItemRow): Promise<string | null> {
  const ids = new Set(
    item.mode.phases.flatMap((p) => p.steps.filter((s) => s.action === "release-notes").flatMap((s) => s.artifacts)),
  );
  if (!ids.size) return null;
  const rows = await tx
    .select({
      artifactId: sdlcArtifacts.artifactId,
      repoPath: sdlcArtifacts.repoPath,
      baseline: sdlcArtifacts.baselineVersion,
    })
    .from(sdlcArtifacts)
    .where(and(eq(sdlcArtifacts.itemId, item.id), eq(sdlcArtifacts.projectId, item.projectId)));
  return rows.find((r) => ids.has(r.artifactId) && r.baseline !== null)?.repoPath ?? null;
}

/** Bình luận lên issue nguồn khi hạng mục đóng (US11): tóm tắt truy vết và link release notes trên nhánh mặc định. */
export async function doneComment(tx: Tx, item: SdlcItemRow, url: string): Promise<string> {
  const ref = sdlcItemRef(item.number);
  const { total, rows } = await itemTrace(tx, item.ownerUserId, item);
  const prs = new Set(rows.flatMap((r) => r.tasks.filter((t) => t.mergeSha).map((t) => t.taskId)));
  const notes = await releaseNotesPath(tx, item);
  const home = await loadProject(tx, item.projectId);
  // Hub đưa tài liệu đã duyệt lên nhánh mặc định nên link trỏ thẳng vào đó; chưa biết URL repo thì chỉ ghi đường dẫn.
  const blob = home?.scmKind === "gitlab" ? "/-/blob/" : "/blob/";
  const link =
    notes && home?.repoWebUrl
      ? `${home.repoWebUrl.replace(/\/+$/, "")}${blob}${home.defaultBranch ?? "main"}/${notes}`
      : null;
  return [
    `Hạng mục AI SDLC ${ref} “${item.title}” đã xong trên xDev Hive: ${url}`,
    "",
    `- ${prs.size} PR đã merge; ${total.requirements} requirement, đã làm ${total.done}%, đã kiểm ${total.verified}%.`,
    `- Release notes: ${link ?? notes ?? "chế độ này không có release notes"}`,
  ].join("\n");
}

type Lessons = Extract<SdlcReportInput, { kind: "lessons" }>["data"];

/**
 * Bài học của retro thành đề xuất trên bản hiện tại (tài liệu chưa có thì đề xuất tạo mới, base 0). Chỉ nhận key tài liệu
 * của dự án trong hạng mục để agent không đề xuất vào tài liệu của nơi khác.
 */
export async function proposeLessons(
  tx: Tx,
  item: SdlcItemRow,
  run: { runId: string; projectId: string },
  data: Lessons,
): Promise<{ proposalId: string; key: string; baseVersion: number }> {
  const home = await loadProject(tx, item.projectId);
  const key = data.key ?? `project/${home?.key ?? ""}/constitution`;
  const members = await activeItemProjects(tx, item.id);
  const keys: string[] = [];
  for (const m of members) {
    const p = await loadProject(tx, m.projectId);
    if (p) keys.push(p.key);
  }
  if (!keys.some((k) => key.startsWith(`project/${k}/`)))
    throw new BadRequestError(
      "SDLC_LESSONS_KEY",
      `Bài học chỉ đề xuất vào tài liệu của dự án trong hạng mục (project/<${keys.join("|")}>/…).`,
    );
  const principal: Principal = { kind: "run", runId: run.runId, projectId: run.projectId };
  let base = 0;
  let title: string | undefined;
  try {
    const current = await getDoc(tx, principal, { key });
    base = current.version;
    title = current.title;
  } catch (e) {
    if (!(e instanceof NotFoundError)) throw e;
  }
  const proposal = await createProposal(tx, principal, {
    kind: "doc",
    key,
    title: title ?? "Constitution",
    content: data.content,
    baseVersion: base,
    reason: `Retro ${sdlcItemRef(item.number)}: ${data.reason}`.slice(0, 500),
  });
  await startReview(tx, proposal.id, {});
  return { proposalId: proposal.id, key, baseVersion: base };
}
