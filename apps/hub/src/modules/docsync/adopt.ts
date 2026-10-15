import { randomUUID } from "node:crypto";
import { docAdoptItem } from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/index.ts";
import { BadRequestError, ConflictError, type Jobs, type Tx } from "../platform/index.ts";
import { homeById, homeProvider, requireHomeManage } from "./homes.ts";
import { matchesHome, type PathHome, pathFromKey } from "./paths.ts";
import { queuePush } from "./queues.ts";
import type { DocSyncDeps } from "./routes/deps.ts";
import { pathHomeOf, repoRef } from "./scan.ts";
import { docRepoFiles, docSyncBatches } from "./schema.ts";

type Actor = { userId: string; orgId: string };
type DocAdoptItem = z.output<typeof docAdoptItem>;
type Candidate = { id: string; key: string; version: number };

const previewInput = z.object({
  homeId: z.uuid(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

const A = {
  exists: "Repo đã có file ở đường dẫn này; PR sẽ ghi đè.",
  outside: "Đường dẫn không khớp mẫu include/exclude của nhà; sau khi đưa vào sẽ không đồng bộ tiếp.",
} as const;

// Tài liệu thuộc phạm vi nhà, chưa gắn file repo nào. Bảng docs của knowledge chỉ được đọc ở đây.
async function unmappedDocs(tx: Tx, pathHome: PathHome, opts: { after?: string; keys?: string[]; limit?: number }) {
  const scope =
    pathHome.scope === "project"
      ? sql`starts_with(d.key, ${`project/${pathHome.projectKey}/`}) and not starts_with(d.key, ${`project/${pathHome.projectKey}/sdlc/`})`
      : sql`(starts_with(d.key, 'org/') or starts_with(d.key, 'team/'))`;
  const { rows } = await tx.execute<Candidate>(sql`
    select d.id, d.key, d.current_version as version from hive.docs d
     where d.archived_at is null and ${scope}
       and not exists (select 1 from hive.doc_repo_files f where f.doc_id = d.id)
       ${opts.after ? sql`and d.key > ${opts.after}` : sql``}
       ${opts.keys ? sql`and d.key in (select jsonb_array_elements_text(${JSON.stringify(opts.keys)}::jsonb))` : sql``}
     order by d.key
     ${opts.limit ? sql`limit ${opts.limit}` : sql``}`);
  return rows;
}

function adoptPath(key: string, pathHome: PathHome): string | null {
  try {
    return pathFromKey(key, pathHome);
  } catch {
    return null;
  }
}

/** Xem trước đường dẫn sẽ ghi vào repo cho tài liệu hub chưa có nhà (FR-011). */
export async function adoptPreview(
  tx: Tx,
  deps: DocSyncDeps,
  actor: Actor,
  input: z.input<typeof previewInput>,
): Promise<{ items: DocAdoptItem[]; nextCursor: string | null }> {
  const data = previewInput.parse(input);
  const home = await homeById(tx, data.homeId);
  await requireHomeManage(tx, actor.userId, home);
  const { pathHome, managed } = await pathHomeOf(tx, home, home);
  const rows = await unmappedDocs(tx, pathHome, {
    ...(data.cursor ? { after: data.cursor } : {}),
    limit: data.limit + 1,
  });
  const page = rows.slice(0, data.limit);
  let inRepo = new Set<string>();
  if (page.length) {
    const provider = await homeProvider(tx, deps, home.connectionId);
    const ref = repoRef(home);
    const head = await provider.branchHead(ref, home.branch);
    if (head) inRepo = new Set(await provider.listFiles(ref, head));
  }
  const items = page.flatMap((doc) => {
    const repoPath = adoptPath(doc.key, pathHome);
    if (!repoPath) return [];
    const warnings: string[] = [];
    const existsInRepo = inRepo.has(repoPath);
    if (existsInRepo) warnings.push(A.exists);
    if (!matchesHome(repoPath, pathHome, { sdlcPaths: managed, skillRoots: managed })) warnings.push(A.outside);
    return [docAdoptItem.parse({ key: doc.key, repoPath, existsInRepo, warnings })];
  });
  return { items, nextCursor: rows.length > data.limit ? (page.at(-1)?.key ?? null) : null };
}

/** Gắn tài liệu đã chọn với đường dẫn repo và xếp một lô PR riêng, không trộn với lô đồng bộ thường. */
export async function adopt(
  tx: Tx,
  jobs: Jobs,
  actor: Actor,
  input: { homeId: string; keys: string[] },
): Promise<{ batchId: string }> {
  const home = await homeById(tx, input.homeId);
  await requireHomeManage(tx, actor.userId, home);
  if (home.status === "paused")
    throw new ConflictError(
      "DOCSYNC_PAUSED",
      "Nhà tài liệu đang tạm dừng. Tiếp tục đồng bộ trước khi đưa tài liệu vào.",
    );
  const { pathHome } = await pathHomeOf(tx, home, home);
  const keys = [...new Set(input.keys)];
  const docs = await unmappedDocs(tx, pathHome, { keys });
  const byKey = new Map(docs.map((d) => [d.key, d]));
  const missing = keys.filter((k) => !byKey.has(k));
  if (missing.length)
    throw new BadRequestError(
      "DOCSYNC_ADOPT_KEY",
      `Tài liệu không thuộc nhà này hoặc đã gắn repo: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`,
    );
  const now = new Date();
  const rows = docs.map((doc) => {
    const repoPath = adoptPath(doc.key, pathHome);
    if (!repoPath) throw new BadRequestError("DOCSYNC_ADOPT_KEY", `Không tạo được đường dẫn repo cho ${doc.key}.`);
    return { orgId: actor.orgId, docId: doc.id, homeId: home.id, repoPath, state: "pending", updatedAt: now };
  });
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const inserted = await tx
      .insert(docRepoFiles)
      .values(chunk)
      .onConflictDoNothing()
      .returning({ id: docRepoFiles.id });
    if (inserted.length !== chunk.length)
      throw new ConflictError(
        "DOCSYNC_ADOPT_PATH",
        "Có đường dẫn repo đã gắn với tài liệu khác. Tải lại bản xem trước.",
      );
  }
  const id = randomUUID();
  await tx.insert(docSyncBatches).values({
    id,
    orgId: actor.orgId,
    homeId: home.id,
    mode: "pr",
    branch: `hive/docs-adopt-${id.slice(0, 8)}`,
    docVersions: docs.map((d) => ({ docId: d.id, version: d.version })),
  });
  await recordAudit(tx, {
    action: "doc.adopt",
    targetType: "doc_home",
    targetId: home.id,
    data: { batchId: id, keys: keys.length, sample: keys.slice(0, 20) },
  });
  await queuePush(jobs, { orgId: actor.orgId, homeId: home.id }, { tx });
  return { batchId: id };
}
