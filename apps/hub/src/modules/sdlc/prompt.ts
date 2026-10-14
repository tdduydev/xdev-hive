import { type SdlcStep, sdlcItemRef } from "@xdev-hive/contracts";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { loadProject } from "../catalog/index.ts";
import { requirementsOf } from "../knowledge/index.ts";
import type { Tx } from "../platform/index.ts";
import { requirementSources } from "./breakdown.ts";
import { sdlcArtifacts, sdlcItemProjects, sdlcItems, sdlcItemTasks } from "./schema.ts";

/** Hình dạng `codereview` cần (`ReviewSpecContext`); khai lại ở đây vì sdlc không import codereview. */
export interface ReviewSpec {
  item: string;
  requirements: { id: string; text: string; acceptance: string[] }[];
  docs: { name: string; docKey: string; version: number }[];
}

/*
 * Prompt của bước agent (D6): `step.prompt` của chế độ là Markdown có biến; hub điền biến bằng ngữ cảnh của hạng mục rồi
 * nối phần luật chung (ghi file nào, hỏi thế nào, không commit). Tài liệu không dán vào prompt mà nằm sẵn trong worktree
 * (seed), để prompt ngắn và agent đọc bằng công cụ đọc file như mọi file khác của repo.
 */

/** Thư mục seed của hub trong worktree tạm: tóm tắt repo tham gia, bản nháp tài liệu của repo khác. */
export const SEED_DIR = ".hive/sdlc";

export interface PromptOutput {
  name: string;
  /** Đường dẫn trong worktree của run (repo dự án chính). */
  path: string;
  sections: string[];
  /** Dự án giữ file khi khác dự án chính; null: file của chính repo này. */
  projectKey: string | null;
}

export interface PromptContextDoc {
  name: string;
  path: string;
  state: "baseline" | "draft";
  version: number | null;
}

export interface PromptProject {
  key: string;
  role: "home" | "participant";
  /** File tóm tắt repo đã seed; null khi không đọc được repo. */
  digestPath: string | null;
  /** Repo của worktree; bỏ trống là dự án chính (converge chạy trên repo của từng dự án). */
  worktree?: boolean | undefined;
}

export interface PromptContract {
  name: string;
  path: string;
  provider: string;
  consumers: string[];
  approved: boolean;
}

export interface StepPromptInput {
  item: { number: number; slug: string; title: string; idea: string; size: string; createdAt: Date };
  phaseName: string;
  step: Pick<SdlcStep, "action" | "prompt" | "maxQuestions" | "skill">;
  outputs: PromptOutput[];
  context: PromptContextDoc[];
  answers: { text: string; answer: string }[];
  feedback: string | null;
  projects: PromptProject[];
  contracts: PromptContract[];
}

const CONSTITUTION =
  "Đọc nguyên tắc của repo nếu có: `.specify/memory/constitution.md`, `AGENTS.md`, `CLAUDE.md`, `docs/decisions.md`. Không có file nào thì theo cách làm đang thấy trong code.";

function artifactsBlock(input: StepPromptInput): string {
  const lines: string[] = [];
  if (input.outputs.length) {
    lines.push("Tài liệu bước này phải ghi (ghi đè đúng đường dẫn, giữ tiêu đề mục):");
    for (const o of input.outputs) {
      const where = o.projectKey ? ` (tài liệu của dự án ${o.projectKey}, hub đưa về repo đó)` : "";
      const sections = o.sections.length ? `; mục bắt buộc: ${o.sections.join(", ")}` : "";
      lines.push(`- ${o.name} → \`${o.path}\`${where}${sections}`);
    }
  }
  if (input.context.length) {
    if (lines.length) lines.push("");
    lines.push("Tài liệu đã có trong worktree (đọc trước khi viết):");
    for (const c of input.context) {
      const state = c.state === "baseline" ? `bản đã duyệt v${c.version ?? "?"}` : "bản nháp đang soạn";
      lines.push(`- ${c.name}: \`${c.path}\` (${state})`);
    }
  }
  if (input.contracts.length) {
    if (lines.length) lines.push("");
    lines.push("Contract liên repo của hạng mục:");
    for (const c of input.contracts) {
      const state = c.approved ? "đã duyệt, phải theo" : "chưa duyệt";
      lines.push(`- ${c.name}: \`${c.path}\` (${c.provider} cung cấp cho ${c.consumers.join(", ")}; ${state})`);
    }
  }
  return lines.length ? lines.join("\n") : "Chưa có tài liệu nào.";
}

function answersBlock(answers: StepPromptInput["answers"]): string {
  if (!answers.length) return "Chưa có câu trả lời nào cho câu hỏi của agent.";
  return [
    "Câu trả lời của người giao (ghi quyết định vào tài liệu, không hỏi lại):",
    ...answers.map((a, i) => `${i + 1}. ${a.text}\n   → ${a.answer}`),
  ].join("\n");
}

function feedbackBlock(feedback: string | null): string {
  return feedback?.trim()
    ? `Góp ý cần sửa trong lượt này:\n${feedback.trim()}`
    : "Không có góp ý của người duyệt ở lượt này.";
}

function projectsBlock(projects: PromptProject[]): string {
  const others = projects.filter((p) => p.role === "participant");
  const home = projects.find((p) => p.role === "home");
  if (!others.length) return `Hạng mục chỉ thuộc dự án ${home?.key ?? "chính"}.`;
  const repo = projects.find((p) => p.worktree) ?? home;
  return [
    repo && repo !== home
      ? `Dự án chính: ${home?.key ?? "?"}. Repo của worktree này: ${repo.key} (dự án tham gia). Dự án khác:`
      : `Dự án chính: ${home?.key ?? "?"} (repo của worktree này). Dự án tham gia:`,
    ...projects
      .filter((p) => p !== repo)
      .map((p) =>
        p.digestPath
          ? `- ${p.key}: tóm tắt repo ở \`${p.digestPath}\``
          : `- ${p.key}: hub chưa đọc được repo; hỏi bằng sdlc_ask nếu cần biết cấu trúc`,
      ),
  ].join("\n");
}

function rulesBlock(input: StepPromptInput): string {
  const asks =
    input.step.maxQuestions > 0
      ? `Chỗ chưa rõ mà đổi hướng làm thì gọi MCP \`sdlc_ask\` (tối đa ${input.step.maxQuestions} câu mỗi lượt, mỗi câu kèm phương án và đề xuất), vẫn ghi tài liệu với dấu \`[NEEDS CLARIFICATION: …]\` đúng chỗ; người trả lời xong hub sẽ chạy lượt mới.`
      : "Không hỏi lại người giao ở bước này; điều chưa rõ thì ghi vào phần giả định.";
  const output = input.outputs.length
    ? "Kết quả là các file tài liệu ở đường dẫn trên; hub đọc lại sau khi bạn thoát."
    : "Bước này không ghi file: báo kết quả bằng MCP `sdlc_report`.";
  return [
    "Luật của hub:",
    `- ${output}`,
    `- ${asks}`,
    "- Gọi MCP `sdlc_context` khi cần xem hạng mục, giai đoạn, câu hỏi và tài liệu của hạng mục.",
    "- Không sửa code, không commit, không đẩy nhánh; hub tự đưa tài liệu đã duyệt vào repo.",
  ].join("\n");
}

/** Điền biến của `step.prompt`; biến lạ giữ nguyên để người viết chế độ thấy và sửa. */
export function buildStepPrompt(input: StepPromptInput): string {
  const ref = sdlcItemRef(input.item.number);
  const vars: Record<string, string> = {
    idea: input.item.idea.trim(),
    artifacts: artifactsBlock(input),
    answers: answersBlock(input.answers),
    feedback: feedbackBlock(input.feedback),
    constitution: CONSTITUTION,
    projects: projectsBlock(input.projects),
    NNN: ref,
    slug: input.item.slug,
    date: input.item.createdAt.toISOString().slice(0, 10),
  };
  const body = input.step.prompt.replace(/\{([A-Za-z]+)\}/g, (all, name: string) => vars[name] ?? all);
  const head = `Hạng mục ${ref} · ${input.item.title} (cỡ ${input.item.size}) · giai đoạn ${input.phaseName} · bước ${input.step.action}.`;
  // Chế độ tự tạo có thể bỏ biến {artifacts}: không có danh sách file thì agent không biết ghi vào đâu.
  const missing = body.includes(vars.artifacts ?? "") ? "" : `\n\n${vars.artifacts}`;
  return `${head}\n\n${body}${missing}\n\n${rulesBlock(input)}`;
}

/** Hạng mục, requirement và tài liệu đã duyệt mà task phải theo; dùng chung cho run code và run review của task. */
async function taskSpec(tx: Tx, taskId: string) {
  const [link] = await tx
    .select({
      itemId: sdlcItemTasks.itemId,
      projectId: sdlcItemTasks.projectId,
      requirementIds: sdlcItemTasks.requirementIds,
    })
    .from(sdlcItemTasks)
    .where(and(eq(sdlcItemTasks.taskId, taskId), eq(sdlcItemTasks.removed, false)));
  if (!link) return null;
  const [item] = await tx.select().from(sdlcItems).where(eq(sdlcItems.id, link.itemId));
  if (!item) return null;
  const members = await tx
    .select({ projectId: sdlcItemProjects.projectId })
    .from(sdlcItemProjects)
    .where(and(eq(sdlcItemProjects.itemId, item.id), isNull(sdlcItemProjects.removedAt)));
  const keys = new Map<string, string>();
  for (const m of members) keys.set(m.projectId, (await loadProject(tx, m.projectId))?.key ?? m.projectId);
  const artifacts = await tx
    .select()
    .from(sdlcArtifacts)
    .where(and(eq(sdlcArtifacts.itemId, item.id), inArray(sdlcArtifacts.approval, ["human", "auto", "reaffirmed"])));
  const names = new Map(item.mode.phases.flatMap((p) => p.artifacts.map((a) => [`${p.id}/${a.id}`, a.name])));
  const docs = artifacts
    .filter(
      (a) =>
        a.baselineVersion !== null &&
        (a.scope === "item" ||
          (a.scope === "project" && a.projectId === link.projectId) ||
          (a.scope === "contract" &&
            (a.projectId === link.projectId || a.consumerProjectIds.includes(link.projectId)))),
    )
    .map((a) => ({
      name:
        a.scope === "contract" ? `contract ${a.instance}` : (names.get(`${a.phaseId}/${a.artifactId}`) ?? a.artifactId),
      docKey: a.docKey,
      version: a.baselineVersion ?? 0,
      repo: keys.get(a.projectId) ?? "",
      repoPath: a.repoPath,
    }));
  return { item, requirementIds: link.requirementIds, docs };
}

/**
 * Ngữ cảnh spec cho prompt của run code task hạng mục (plan.md "Luồng" bước 6): tài liệu đã duyệt mà task phải theo,
 * requirement của task, contract dự án của task cung cấp hay dùng. Task không thuộc hạng mục: null, prompt như cũ.
 */
export async function specContextFor(tx: Tx, taskId: string): Promise<string | null> {
  const spec = await taskSpec(tx, taskId);
  if (!spec) return null;
  const { item, requirementIds, docs } = spec;
  const lines = [
    `Task thuộc hạng mục AI SDLC ${sdlcItemRef(item.number)} · ${item.title}. Làm đúng tài liệu đã duyệt dưới đây; chỗ tài liệu sai hay thiếu thì ghi vào báo cáo task_update, không tự đổi phạm vi.`,
  ];
  if (requirementIds.length) lines.push(`Requirement của task: ${requirementIds.join(", ")}.`);
  if (docs.length) {
    lines.push("Tài liệu (đọc bằng MCP doc_get theo key, hoặc file trong repo của dự án giữ tài liệu):");
    for (const d of docs)
      lines.push(`- ${d.name} v${d.version}: key \`${d.docKey}\`, repo ${d.repo} \`${d.repoPath}\``);
  }
  lines.push(
    "Báo kết quả bằng task_update kèm `checklist` (mục đã xong) và `evidence` (requirement đã làm, test đã chạy) để hub truy vết.",
  );
  return lines.join("\n");
}

/**
 * Ngữ cảnh spec cho checkpoint AI của review code (T085): reviewer chấm thay đổi theo câu chữ và tiêu chí của requirement
 * task nhận, không chỉ theo tiêu đề task. Câu chữ lấy từ bản baseline của tài liệu nguồn requirement.
 */
export async function reviewSpecFor(tx: Tx, taskId: string): Promise<ReviewSpec | null> {
  const spec = await taskSpec(tx, taskId);
  if (!spec) return null;
  const { item, requirementIds, docs } = spec;
  const d = item.mode.decomposition;
  const parsed =
    d && requirementIds.length
      ? (await requirementSources(tx, { kind: "user", userId: item.ownerUserId }, item, d)).flatMap((content) =>
          requirementsOf(content, d.requirementId),
        )
      : [];
  return {
    item: `${sdlcItemRef(item.number)} · ${item.title}`,
    requirements: requirementIds.map((id) => {
      const r = parsed.find((x) => x.id === id);
      return { id, text: r?.text ?? "", acceptance: r?.acceptance ?? [] };
    }),
    docs: docs.map(({ name, docKey, version }) => ({ name, docKey, version })),
  };
}
