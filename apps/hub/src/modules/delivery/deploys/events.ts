import type { DeployState, DeployVersion } from "@xdev-hive/contracts";
import { and, eq } from "drizzle-orm";
import { findProject } from "../../catalog/index.ts";
import type { Tx } from "../../platform/index.ts";
import type { DeliveryDeps } from "../deps.ts";
import { loadEnvironment, peopleOf } from "../environments.ts";
import { emitDeliveryEvent } from "../notifications.ts";
import { deployApprovals } from "../schema.ts";
import { deployNotFound, type LocatedDeploy, loadLocatedDeploy } from "./board.ts";

// Thông báo của lần triển khai, tách khỏi orchestrator để nơi nhận sự kiện từ worker (worker-jobs.ts) dùng được mà không
// vòng import qua bộ điều phối.

export async function locate(tx: Tx, id: string): Promise<LocatedDeploy> {
  const row = await loadLocatedDeploy(tx, id);
  if (!row) throw deployNotFound();
  return row;
}

// ---- Thông báo ------------------------------------------------------------------------------------------------------

export function versionLabel(v: DeployVersion): string {
  if (v.commit) return v.commit.slice(0, 8);
  if (v.tag) return v.tag;
  if (v.jenkinsBuild !== null) return `build #${v.jenkinsBuild}`;
  return v.image ?? v.revision ?? "bản mới";
}

export const deployLink = (deps: DeliveryDeps, id: string) =>
  deps.publicUrl ? `${deps.publicUrl.replace(/\/+$/, "")}/deploys/${id}` : null;

export async function describe(tx: Tx, row: LocatedDeploy) {
  const project = await findProject(tx, row.projectId);
  const env = await loadEnvironment(tx, row.environmentId);
  return { project: project?.name ?? "dự án", env: env?.name ?? "môi trường" };
}

const FINISH_TEXT: Partial<Record<DeployState, [string, string]>> = {
  succeeded: ["thành công", "Bản {v} đang chạy trên {env}."],
  failed: ["thất bại", "Bản {v} lỗi{step}. Xem log của lần triển khai."],
  failed_needs_review: ["cần xem lại", "Các bước của bản {v} đã chạy xong nhưng kiểm tra sức khoẻ không đạt."],
  unknown: [
    "không rõ kết quả",
    "Hive không đọc được máy chủ hay nguồn quá 15 phút khi triển khai bản {v}. Kiểm tra trên máy chủ trước khi chạy lại.",
  ],
  rejected: ["bị từ chối", "Bản {v} không được duyệt lên {env}. Xem lý do trong lần triển khai."],
  expired: [
    "hết hạn duyệt",
    "Bản {v} chờ duyệt quá hạn nên không triển khai lên {env}. Bấm triển khai lại nếu vẫn cần.",
  ],
};

/** started/succeeded/failed cho người bấm và người đã duyệt; `eventKey` ổn định nên job chạy lại không báo hai lần. */
export async function emitDeployEvent(tx: Tx, deps: DeliveryDeps, deployId: string, state: DeployState): Promise<void> {
  const row = await locate(tx, deployId);
  const d = row.deploy;
  if (d.origin !== "hive") return;
  const { project, env } = await describe(tx, row);
  const approvers = await tx
    .select({ userId: deployApprovals.userId })
    .from(deployApprovals)
    .where(and(eq(deployApprovals.deployId, d.id), eq(deployApprovals.decision, "approve")));
  const recipientIds = [d.requestedBy, ...approvers.map((a) => a.userId)].filter((id): id is string => id !== null);
  const v = versionLabel(d.version);
  let event: "deploy.started" | "deploy.succeeded" | "deploy.failed";
  let title: string;
  let body: string;
  if (state === "running") {
    const who = d.requestedBy ? ((await peopleOf(tx, [d.requestedBy])).get(d.requestedBy)?.name ?? "") : "";
    event = "deploy.started";
    title = `Đang triển khai ${project} lên ${env}`;
    body = `${who ? `${who} triển khai` : "Triển khai"} bản ${v} lên ${env}.`;
  } else {
    const [outcome, template] = FINISH_TEXT[state] ?? ["thất bại", "Bản {v} lỗi{step}."];
    const failedStep = d.steps.find((s) => s.state === "failed");
    event = state === "succeeded" ? "deploy.succeeded" : "deploy.failed";
    title = `Triển khai ${project} lên ${env} ${outcome}`;
    body = template
      .replace("{v}", v)
      .replace("{env}", env)
      .replace("{step}", failedStep ? ` ở bước ${failedStep.key}` : "");
  }
  await emitDeliveryEvent(
    tx,
    {
      orgId: d.orgId,
      event,
      title,
      body,
      systemId: row.systemId,
      eventKey: `deploy:${d.id}:${event}`,
      recipientIds,
      link: deployLink(deps, d.id),
    },
    deps.jobs,
  );
}
