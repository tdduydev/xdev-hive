import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "../platform/index.ts";
import { linkHrefs } from "./assets.ts";
import { resolveRelative } from "./paths.ts";
import { docAssets, docHomes } from "./schema.ts";

/*
 * Dọn ảnh mồ côi (spec 019 FR-026, plan.md mục 8). Cập nhật tài liệu từ Word có thể bỏ hẳn một ảnh; ảnh tên kiểu hash
 * (`<12 hex>.<đuôi>`, do bước nhập Word đặt) không còn tài liệu nào của nhà trỏ tới thì chuyển `pending_delete`, lô đẩy
 * kế tiếp xoá nó khỏi repo (push.ts). Ảnh `image-<thời điểm>` do editor tải lên và mọi file khác không bao giờ bị đụng:
 * người dùng đặt chúng có chủ ý, hub không biết chỗ nào ngoài hub còn dùng.
 */

type Home = typeof docHomes.$inferSelect;
type AssetRow = typeof docAssets.$inferSelect;

const HASHED_NAME = /^(?:(.*)\/)?[0-9a-f]{12}\.[a-z0-9]+$/;
const trimSlashes = (s: string) => s.replace(/^\/+|\/+$/g, "");

/**
 * Thư mục ảnh của nhà: `<root>/<assetsDir>` với nhà dự án, `<root>/org/<assetsDir>` hoặc `<root>/teams/<đội>/<assetsDir>`
 * với nhà tổ chức (như `assetsDirOf` của word/commit.ts).
 */
function isImageDir(home: Home, dir: string): boolean {
  const root = trimSlashes(home.root);
  let rest = dir;
  if (root) {
    if (dir !== root && !dir.startsWith(`${root}/`)) return false;
    rest = dir.slice(root.length + 1);
  }
  const parts = rest ? rest.split("/") : [];
  if (home.scope === "org") {
    if (parts[0] === "org") parts.splice(0, 1);
    else if (parts[0] === "teams" && /^[a-z0-9-]+$/.test(parts[1] ?? "")) parts.splice(0, 2);
    else return false;
  }
  return parts.join("/") === trimSlashes(home.assetsDir);
}

export function isHashedImage(home: Home, repoPath: string): boolean {
  const match = HASHED_NAME.exec(repoPath);
  return match !== null && isImageDir(home, match[1] ?? "");
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * Trong `candidates`, những ảnh vẫn có tài liệu của nhà trỏ tới. Tài liệu chưa có dòng `doc_repo_files` (tạo trên hub,
 * bị loại trừ khỏi nhà) không biết đường dẫn nên so theo tên file: giữ nhầm một ảnh an toàn hơn xoá nhầm.
 */
async function referenced(tx: Tx, homeId: string, candidates: AssetRow[]): Promise<Set<string>> {
  const names = [...new Set(candidates.map((a) => baseName(a.repoPath)))];
  const wanted = new Set(candidates.map((a) => a.repoPath));
  const found = new Set<string>();
  const nameArray = sql`array[${sql.join(
    names.map((n) => sql`${n}`),
    sql`, `,
  )}]::text[]`;
  const { rows: located } = await tx.execute<{ path: string; content: string }>(sql`
    select f.repo_path as path, v.content
      from hive.doc_repo_files f
      join hive.docs d on d.id = f.doc_id
      join hive.doc_versions v on v.doc_id = d.id and v.version = d.current_version
     where f.home_id = ${homeId}
       and exists (select 1 from unnest(${nameArray}) n where strpos(v.content, n) > 0)
  `);
  for (const { path, content } of located)
    for (const href of linkHrefs(content)) {
      let target: ReturnType<typeof resolveRelative> = null;
      try {
        target = resolveRelative(path, href);
      } catch {}
      if (target && wanted.has(target.path)) found.add(target.path);
    }
  const { rows: unplaced } = await tx.execute<{ content: string }>(sql`
    select v.content
      from hive.docs d
      join hive.doc_versions v on v.doc_id = d.id and v.version = d.current_version
     where not exists (select 1 from hive.doc_repo_files f where f.doc_id = d.id)
       and exists (select 1 from unnest(${nameArray}) n where strpos(v.content, n) > 0)
  `);
  const hrefNames = new Set(
    unplaced.flatMap(({ content }) => linkHrefs(content).map((h) => baseName(h.split(/[?#]/)[0] ?? ""))),
  );
  for (const a of candidates) if (hrefNames.has(baseName(a.repoPath))) found.add(a.repoPath);
  return found;
}

/**
 * Ảnh hash của nhà không còn tài liệu nào trỏ tới thì chuyển `pending_delete`. Gọi sau khi lưu tài liệu, trong cùng
 * giao dịch, để lần lưu và việc đánh dấu cùng thành hoặc cùng huỷ. Trả về số ảnh vừa đánh dấu. Ảnh `pending_push` chưa
 * nằm trong repo nên để lô đẩy ghi lên đã; lần dọn sau mới xoá (đánh dấu nó thì `restoreReferencedAssets` không biết
 * trả về trạng thái nào).
 */
export async function markOrphanAssets(tx: Tx, homeId: string): Promise<number> {
  const [home] = await tx.select().from(docHomes).where(eq(docHomes.id, homeId));
  if (!home) return 0;
  const rows = await tx
    .select()
    .from(docAssets)
    .where(and(eq(docAssets.homeId, homeId), eq(docAssets.state, "available")));
  const candidates = rows.filter((a) => isHashedImage(home, a.repoPath));
  if (!candidates.length) return 0;
  const used = await referenced(tx, homeId, candidates);
  const orphans = candidates.filter((a) => !used.has(a.repoPath));
  if (!orphans.length) return 0;
  await tx
    .update(docAssets)
    .set({ state: "pending_delete", updatedAt: new Date() })
    .where(
      inArray(
        docAssets.id,
        orphans.map((a) => a.id),
      ),
    );
  return orphans.length;
}

/**
 * Ảnh đang chờ xoá mà giữa lúc đó có tài liệu trỏ tới (lưu từ nơi khác, gắn lại ảnh) thì trả về `available`. Lô đẩy
 * gọi trước khi xoá: xoá nhầm một ảnh còn dùng làm vỡ tài liệu, còn giữ thừa chỉ tốn một file.
 */
export async function restoreReferencedAssets(tx: Tx, homeId: string): Promise<number> {
  const pending = await tx
    .select()
    .from(docAssets)
    .where(and(eq(docAssets.homeId, homeId), eq(docAssets.state, "pending_delete")));
  if (!pending.length) return 0;
  const used = await referenced(tx, homeId, pending);
  const revived = pending.filter((a) => used.has(a.repoPath));
  if (!revived.length) return 0;
  await tx
    .update(docAssets)
    .set({ state: "available", updatedAt: new Date() })
    .where(
      inArray(
        docAssets.id,
        revived.map((a) => a.id),
      ),
    );
  return revived.length;
}
