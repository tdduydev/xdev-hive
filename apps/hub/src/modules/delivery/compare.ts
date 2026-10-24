import type { DeployCompare, DeployVersion } from "@xdev-hive/contracts";
import { and, desc, eq, lte, ne } from "drizzle-orm";
import { type Tx, withTenant } from "../platform/index.ts";
import { GitProviderError } from "../scm/index.ts";
import {
  type CiActor,
  type CiDeps,
  ciProject,
  requirePool,
  type ScmTarget,
  scmDomainError,
  scmTarget,
} from "./ci/feed.ts";
import { deliveryOutbound } from "./clients/outbound.ts";
import { deployNotFound, loadLocatedDeploy } from "./deploys/board.ts";
import { requireTeamPermission } from "./environments.ts";
import { deploys } from "./schema.ts";

const COMMIT_LIMIT = 100;
const revision = (v: DeployVersion) => v.commit || v.revision || v.tag;

/** Không giữ transaction trong lúc nguồn Git có thể chậm hoặc không trả lời. */
export async function prepareDeployCompare(tx: Tx, deps: CiDeps, userId: string, id: string) {
  const row = await loadLocatedDeploy(tx, id);
  if (!row) throw deployNotFound();
  await requireTeamPermission(tx, userId, row.teamId, "ci.view", deployNotFound);
  const project = await ciProject(tx, userId, row.projectId, "ci.view");
  const d = row.deploy;
  // Khi xem lại lịch sử, không lấy một bản thành công sau lúc lần này bắt đầu làm mốc.
  const [previous] = await tx
    .select({ version: deploys.version })
    .from(deploys)
    .where(
      and(
        eq(deploys.targetId, d.targetId),
        eq(deploys.state, "succeeded"),
        ne(deploys.id, d.id),
        lte(deploys.finishedAt, d.startedAt ?? d.createdAt),
      ),
    )
    .orderBy(desc(deploys.finishedAt), desc(deploys.createdAt), desc(deploys.id))
    .limit(1);
  const comparison: DeployCompare = { from: previous?.version ?? null, to: d.version, commits: [], incomplete: true };
  if (
    !comparison.from ||
    !revision(comparison.from) ||
    !revision(comparison.to) ||
    !deliveryOutbound() ||
    !deps.providerFactory ||
    !deps.masterKey
  )
    return { comparison, target: null };
  try {
    return { comparison, target: await scmTarget(tx, deps, project) };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "SCM_CONNECTION_MISSING")
      return { comparison, target: null };
    throw error;
  }
}

export async function readDeployCompare(comparison: DeployCompare, target: ScmTarget | null): Promise<DeployCompare> {
  const from = comparison.from && revision(comparison.from);
  const to = revision(comparison.to);
  if (!from || !to || !target || !deliveryOutbound()) return comparison;
  try {
    const result = await target.provider.compare(target.ref, from, to);
    let incomplete = result.incomplete || result.commits.length > COMMIT_LIMIT;
    const commits: DeployCompare["commits"] = [];
    for (const c of result.commits.slice(0, COMMIT_LIMIT)) {
      // Hợp đồng đòi giờ thật: bỏ dòng thiếu giờ thay vì gán một thời điểm giả cho người duyệt.
      if (!c.authoredAt || !Number.isFinite(Date.parse(c.authoredAt))) {
        incomplete = true;
        continue;
      }
      commits.push({
        sha: c.sha,
        title: c.title.split("\n", 1)[0] ?? "",
        author: c.author ?? "Không rõ tác giả",
        at: new Date(c.authoredAt).toISOString(),
      });
    }
    return { ...comparison, commits, incomplete };
  } catch (error) {
    if (error instanceof GitProviderError && (error.code === "unauthorized" || error.code === "forbidden"))
      throw scmDomainError(error, target, "đọc commit");
    return { ...comparison, commits: [], incomplete: true };
  }
}

export async function compareDeploy(deps: CiDeps, actor: CiActor, id: string): Promise<DeployCompare> {
  const { comparison, target } = await withTenant(requirePool(deps), actor, (tx) =>
    prepareDeployCompare(tx, deps, actor.userId, id),
  );
  return readDeployCompare(comparison, target);
}
