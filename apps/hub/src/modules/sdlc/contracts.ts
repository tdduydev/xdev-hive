import {
  CONTRACT_FORMAT_EXT,
  type ContractFormat,
  type SdlcContractInput,
  type SdlcReportInput,
  sdlcContractInput,
} from "@xdev-hive/contracts";

/**
 * Phần thuần của contract liên repo (D23): kiểm bên cung cấp/bên dùng, đổi báo cáo của agent thành bản nháp, chọn đội
 * cho checkpoint, cảnh báo baseline mới. Phần đọc/ghi DB (`contracts.create|update`, `sdlc_artifacts`,
 * `sdlc_artifact_syncs`, tài liệu hub) nối vào đây sau khi T015 có `access.ts`/`phases.ts` và T004 có bảng.
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
