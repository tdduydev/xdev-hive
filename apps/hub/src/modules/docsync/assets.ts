import { type DocAsset, type DocResolvedLink, type DocSummary, docAsset, docKey } from "@xdev-hive/contracts";
import { and, asc, eq, gt, inArray, or } from "drizzle-orm";
import type pg from "pg";
import type { Auth } from "../identity/index.ts";
import { getDoc, listDocs, type Principal } from "../knowledge/index.ts";
import {
  BadRequestError,
  type BlobStore,
  ConflictError,
  createPostgresBlobStore,
  type DocStorageLimits,
  ForbiddenError,
  loadDocStorageLimits,
  NotFoundError,
  type Tx,
  withTenant,
} from "../platform/index.ts";
import { type GitProvider, listConnections } from "../scm/index.ts";
import { ORG_HEADER, requireOrgRole, requireTeamRole, tokenOrgMismatch } from "../tenancy/index.ts";
import { isLfsPath, parseGitattributes } from "./content.ts";
import { type HomeRow, homeProvider } from "./homes.ts";
import { keyFromPath, matchesHome, type PathHome, pathFromKey, resolveRelative } from "./paths.ts";
import { queuePush } from "./queues.ts";
import type { DocSyncDeps } from "./routes/deps.ts";
import { docAssets, docHomes, docRepoFiles } from "./schema.ts";

type AssetRow = typeof docAssets.$inferSelect;
export type AssetDeps = DocSyncDeps & {
  auth?: Auth | undefined;
  /** Test thay giới hạn nhỏ để không phải gửi file hàng chục MB. */
  limits?: DocStorageLimits | undefined;
  blobStore?: BlobStore | undefined;
  /** File tới cỡ này đọc hết vào bộ nhớ khi tải xuống; lớn hơn thì stream. */
  downloadBufferBytes?: number | undefined;
};
/** Vị trí của tài liệu trong repo: nhà chứa nó và đường dẫn file (đã đồng bộ, hoặc dự kiến khi chưa đẩy lần nào). */
export interface DocLocation {
  home: HomeRow;
  path: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Phần đầu multipart (ranh giới, tên trường, docKey) không tính vào file; chừa rộng để không chặn nhầm file vừa ngưỡng.
const MULTIPART_OVERHEAD = 64 * 1024;
const BUFFER_MAX_BYTES = 4 * 1024 ** 2;
const STREAM_IDLE_MS = 60_000;
// Trình duyệt hiện SVG/HTML như trang web cùng origin với hub; luôn ép tải về và chặn script nếu ai đó mở thẳng.
const ACTIVE_TYPES = new Set(["image/svg+xml", "text/html", "application/xhtml+xml", "text/xml", "application/xml"]);
const assetNotFound = () => new NotFoundError("DOCSYNC_ASSET_NOT_FOUND", "Không tìm thấy file đính kèm.");
const noHome = () =>
  new BadRequestError("DOCSYNC_NO_HOME", "Tài liệu chưa thuộc kho tài liệu nào nên chưa đính kèm file được.");

// ---- Vị trí tài liệu và đường dẫn ----------------------------------------------------------------------------------

function pathHome(home: HomeRow, key: string): PathHome | null {
  if (home.scope === "org") return { scope: "org", root: home.root, include: home.include, exclude: home.exclude };
  const projectKey = /^project\/([a-z0-9-]+)\//.exec(key)?.[1];
  return projectKey
    ? { scope: "project", projectKey, root: home.root, include: home.include, exclude: home.exclude }
    : null;
}

export async function docLocation(tx: Tx, doc: Pick<DocSummary, "id" | "key" | "scope">): Promise<DocLocation | null> {
  const [synced] = await tx
    .select({ home: docHomes, path: docRepoFiles.repoPath })
    .from(docRepoFiles)
    .innerJoin(docHomes, eq(docHomes.id, docRepoFiles.homeId))
    .where(eq(docRepoFiles.docId, doc.id));
  if (synced) return synced;
  // Tài liệu tạo trên hub chưa đẩy lần nào: đường dẫn sẽ có ở lô đẩy tới, tính như push.ts.
  const [home] = await tx
    .select()
    .from(docHomes)
    .where(doc.scope.projectId ? eq(docHomes.projectId, doc.scope.projectId) : eq(docHomes.scope, "org"));
  const target = home && pathHome(home, doc.key);
  if (!home || !target) return null;
  try {
    return { home, path: pathFromKey(doc.key, target) };
  } catch {
    return null;
  }
}

/** Thư mục gốc của phạm vi tài liệu trong nhà: `docs` của dự án, `org` hoặc `teams/<slug>` của repo tổ chức. */
function homeDir(home: HomeRow, key: string): string {
  const root = home.root.replace(/\/+$/, "");
  if (home.scope === "project") return root;
  const team = /^team\/([a-z0-9-]+)\//.exec(key)?.[1];
  return [root, team ? `teams/${team}` : "org"].filter(Boolean).join("/");
}

export function relativeFrom(docPath: string, target: string): string {
  const from = docPath.split("/").slice(0, -1);
  const to = target.split("/");
  let same = 0;
  while (same < from.length && same < to.length - 1 && from[same] === to[same]) same++;
  return [...from.slice(same).map(() => ".."), ...to.slice(same)].join("/");
}

/** Tên file an toàn cho repo: bỏ dấu, chữ thường, giữ đuôi. Ảnh dán không có tên thật thì đặt theo giờ (plan.md mục 8). */
export function assetFileName(name: string, mediaType: string, now = new Date()): string {
  const base = name.split(/[\\/]/).at(-1)?.trim() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = (dot > 0 ? base.slice(dot + 1) : "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const slug = stem
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 80);
  if (slug && slug !== "image" && slug !== "blob") return ext ? `${slug}.${ext}` : slug;
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\..*$/, "");
  const fallbackExt =
    ext ||
    mediaType
      .split("/")[1]
      ?.split(/[+;]/)[0]
      ?.replace(/[^a-z0-9]/g, "") ||
    "bin";
  return `${mediaType.startsWith("image/") || !slug ? "image" : slug}-${stamp}.${fallbackExt}`;
}

const withSuffix = (path: string, sha256: string) => {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  const suffix = `-${sha256.slice(0, 8)}`;
  return dot > slash + 1 ? `${path.slice(0, dot)}${suffix}${path.slice(dot)}` : `${path}${suffix}`;
};

// ---- Quyền ----------------------------------------------------------------------------------------------------------

/** Đính kèm là một phần của đề xuất sửa tài liệu: cần quyền đề xuất như knowledge (`authorize(propose)`). */
async function requirePropose(tx: Tx, userId: string, doc: DocSummary): Promise<void> {
  if (doc.scope.teamId) await requireTeamRole(tx, userId, doc.scope.teamId, "member");
}

/** Href trong markdown và HTML nhúng; không cần parser đầy đủ vì chỉ dùng để biết tài liệu có trỏ tới file hay không. */
export function linkHrefs(content: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\]\(\s*<([^>\n]+)>/g,
    /\]\(\s*([^)\s]+)/g,
    /^\s{0,3}\[[^\]\n]+\]:\s*<?([^\s>]+)>?/gm,
    /\b(?:src|href)\s*=\s*["']([^"'\n]+)["']/gi,
  ];
  for (const pattern of patterns) for (const match of content.matchAll(pattern)) if (match[1]) found.add(match[1]);
  return [...found];
}

function linkedPaths(content: string, docPath: string): Set<string> {
  const paths = new Set<string>();
  for (const href of linkHrefs(content)) {
    const target = safeRelative(docPath, href);
    if (target) paths.add(target.path);
  }
  return paths;
}

function safeRelative(docPath: string, href: string) {
  try {
    return resolveRelative(docPath, href);
  } catch {
    return null;
  }
}

/**
 * Được đọc đính kèm khi đọc được tài liệu chủ, hoặc tài liệu `via` cùng nhà có link tới nó (file nhập từ repo không có
 * chủ, nhiều tài liệu dùng chung). Không chỉ dựa vào "cùng nhà": repo tổ chức chứa tài liệu của nhiều đội.
 */
async function readableAsset(tx: Tx, principal: Principal, asset: AssetRow, via?: string): Promise<boolean> {
  const readable = await listDocs(tx, principal, {});
  if (asset.ownerDocId && readable.some((d) => d.id === asset.ownerDocId)) return true;
  if (!via) return false;
  const doc = readable.find((d) => d.key === via);
  if (!doc) return false;
  const location = await docLocation(tx, doc);
  if (location?.home.id !== asset.homeId) return false;
  const { content } = await getDoc(tx, principal, { key: doc.key });
  return linkedPaths(content, location.path).has(asset.repoPath);
}

// ---- Phân giải link (docAssets.resolve) -----------------------------------------------------------------------------

function assetUrl(orgId: string, asset: Pick<AssetRow, "id">, via: string): string {
  // <img src> không gửi được header tổ chức; tham số `org` thay header, `doc` cho phép đọc qua tài liệu có link tới file.
  return `/api/v1/docs/assets/${asset.id}?${new URLSearchParams({ org: orgId, doc: via })}`;
}

async function repoWebBase(tx: Tx, home: HomeRow): Promise<{ blob: (path: string) => string } | null> {
  const conn = (await listConnections(tx)).find((c) => c.id === home.connectionId);
  if (!conn) return null;
  const encode = (path: string) => path.split("/").map(encodeURIComponent).join("/");
  const repo = `${encodeURIComponent(home.owner).replace(/%2F/g, "/")}/${encodeURIComponent(home.name)}`;
  const branch = encode(home.branch);
  if (conn.kind === "gitlab") {
    const base = (conn.baseUrl ?? "https://gitlab.com").replace(/\/+$/, "");
    return { blob: (path) => `${base}/${repo}/-/blob/${branch}/${encode(path)}` };
  }
  // Kết nối GitHub Enterprise lưu URL API (`…/api/v3`); trang web nằm ở gốc host.
  const base = conn.baseUrl ? conn.baseUrl.replace(/\/+$/, "").replace(/\/api\/v3$/, "") : "https://github.com";
  return { blob: (path) => `${base}/${repo}/blob/${branch}/${encode(path)}` };
}

export async function resolveDocLinks(
  tx: Tx,
  principal: Principal,
  input: { docKey: string; hrefs: string[] },
): Promise<DocResolvedLink[]> {
  const doc = await getDoc(tx, principal, { key: docKey.parse(input.docKey) });
  const location = await docLocation(tx, doc);
  if (!location)
    return input.hrefs.map((href) => ({ kind: "missing", href, reason: "Tài liệu chưa thuộc kho tài liệu nào." }));
  const { home, path: docPath } = location;
  const targets = input.hrefs.map((href) => ({ href, target: safeRelative(docPath, href) }));
  const paths = [...new Set(targets.flatMap((t) => (t.target ? [t.target.path] : [])))];
  const [files, assets, readable, web] = await Promise.all([
    paths.length
      ? tx
          .select({ docId: docRepoFiles.docId, path: docRepoFiles.repoPath })
          .from(docRepoFiles)
          .where(and(eq(docRepoFiles.homeId, home.id), inArray(docRepoFiles.repoPath, paths)))
      : [],
    paths.length
      ? tx
          .select()
          .from(docAssets)
          .where(and(eq(docAssets.homeId, home.id), inArray(docAssets.repoPath, paths)))
      : [],
    listDocs(tx, principal, {}),
    repoWebBase(tx, home),
  ]);
  const fileByPath = new Map(files.map((f) => [f.path, f.docId]));
  const assetByPath = new Map(assets.map((a) => [a.repoPath, a]));
  const readableById = new Map(readable.map((d) => [d.id, d]));
  const readableKeys = new Set(readable.map((d) => d.key));
  const scope = pathHome(home, doc.key);

  return targets.map(({ href, target }): DocResolvedLink => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return { kind: "external", href, url: href };
    if (href.startsWith("#")) return { kind: "doc", href, key: doc.key };
    if (!target) return { kind: "missing", href, reason: "Link trỏ ra ngoài repo hoặc không hợp lệ." };
    const { path } = target;
    if (/\.md$/i.test(path)) {
      const linkedId = fileByPath.get(path);
      if (linkedId) {
        const linked = readableById.get(linkedId);
        return linked
          ? { kind: "doc", href, key: linked.key }
          : { kind: "missing", href, reason: "Không tìm thấy tài liệu hoặc bạn không có quyền đọc." };
      }
      // Tài liệu tạo trên hub chưa đẩy: chưa có doc_repo_files nhưng key suy từ đường dẫn đã có.
      let key: string | null = null;
      try {
        key = scope ? keyFromPath(path, scope) : null;
      } catch {}
      if (key && readableKeys.has(key)) return { kind: "doc", href, key };
      if (scope && matchesHome(path, scope))
        return { kind: "missing", href, reason: "Tài liệu được link chưa có trên hub." };
    } else {
      const asset = assetByPath.get(path);
      if (asset?.blobId) return { kind: "asset", href, assetId: asset.id, url: assetUrl(home.orgId, asset, doc.key) };
      if (asset?.state === "missing_lfs") return { kind: "missing", href, reason: "Thiếu đối tượng LFS." };
    }
    if (!web) return { kind: "missing", href, reason: "Không tìm thấy kết nối Git của kho tài liệu." };
    return { kind: "external", href, url: web.blob(path) + target.query + target.fragment };
  });
}

/** Link gãy của các tài liệu mình đọc được trong nhà, cho màn trạng thái (FR-025). */
export async function listBrokenLinks(
  tx: Tx,
  principal: Principal,
  homeId: string,
  limit = 500,
): Promise<Array<{ docKey: string; href: string; reason: string }>> {
  const readable = await listDocs(tx, principal, {});
  const broken: Array<{ docKey: string; href: string; reason: string }> = [];
  for (const doc of readable) {
    if (broken.length >= limit) break;
    const location = await docLocation(tx, doc);
    if (location?.home.id !== homeId) continue;
    const { content } = await getDoc(tx, principal, { key: doc.key });
    const hrefs = linkHrefs(content).filter((h) => !/^[a-z][a-z0-9+.-]*:/i.test(h) && !h.startsWith("//"));
    if (!hrefs.length) continue;
    for (const link of await resolveDocLinks(tx, principal, { docKey: doc.key, hrefs }))
      if (link.kind === "missing") broken.push({ docKey: doc.key, href: link.href, reason: link.reason });
  }
  return broken.slice(0, limit);
}

// ---- Danh sách (docAssets.list) -------------------------------------------------------------------------------------

function assetView(row: AssetRow): DocAsset {
  return docAsset.parse(row);
}

export async function listDocAssets(
  tx: Tx,
  principal: Principal,
  input: { homeId: string; docKey?: string | undefined; cursor?: string | undefined; limit: number },
): Promise<{ items: DocAsset[]; nextCursor: string | null }> {
  if (input.cursor !== undefined && !UUID.test(input.cursor))
    throw new BadRequestError("DOCSYNC_INVALID_CURSOR", "Con trỏ danh sách đính kèm không hợp lệ.");
  const readable = await listDocs(tx, principal, {});
  const owners = readable.map((d) => d.id);
  let linked: string[] = [];
  if (input.docKey) {
    const doc = await getDoc(tx, principal, { key: docKey.parse(input.docKey) });
    const location = await docLocation(tx, doc);
    if (location?.home.id !== input.homeId) return { items: [], nextCursor: null };
    linked = [...linkedPaths(doc.content, location.path)];
    owners.splice(0, owners.length, doc.id);
  }
  if (!owners.length && !linked.length) return { items: [], nextCursor: null };
  const rows = await tx
    .select()
    .from(docAssets)
    .where(
      and(
        eq(docAssets.homeId, input.homeId),
        or(
          owners.length ? inArray(docAssets.ownerDocId, owners) : undefined,
          linked.length ? inArray(docAssets.repoPath, linked) : undefined,
        ),
        input.cursor ? gt(docAssets.id, input.cursor) : undefined,
      ),
    )
    .orderBy(asc(docAssets.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  return { items: page.map(assetView), nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null };
}

/** Đính kèm theo đường dẫn tương đối từ một tài liệu, cho tool MCP `doc_asset_get` (FR-039) và route tải theo path. */
export async function findDocAsset(
  tx: Tx,
  principal: Principal,
  input: { docKey: string; path: string },
): Promise<DocAsset> {
  const doc = await getDoc(tx, principal, { key: docKey.parse(input.docKey) });
  const location = await docLocation(tx, doc);
  const target = location && safeRelative(location.path, input.path);
  if (!location || !target) throw assetNotFound();
  const [asset] = await tx
    .select()
    .from(docAssets)
    .where(and(eq(docAssets.homeId, location.home.id), eq(docAssets.repoPath, target.path)));
  if (!asset || !(await readableAsset(tx, principal, asset, doc.key))) throw assetNotFound();
  return assetView(asset);
}

// ---- Route Hono: tải lên, tải xuống ---------------------------------------------------------------------------------

type HttpError = ForbiddenError | NotFoundError | ConflictError | BadRequestError;
const STATUS: Array<[new (...args: never[]) => HttpError, number, string]> = [
  [BadRequestError, 400, "BAD_REQUEST"],
  [ForbiddenError, 403, "FORBIDDEN"],
  [NotFoundError, 404, "NOT_FOUND"],
  [ConflictError, 409, "CONFLICT"],
];

/** Cùng dạng lỗi với oRPC (`data.code`) để web và desktop đọc lỗi tải file như mọi lỗi khác của hub. */
function errorResponse(error: unknown): Response {
  for (const [type, status, code] of STATUS) {
    if (error instanceof type) {
      const extra = error instanceof ConflictError ? error.data : undefined;
      return Response.json(
        { defined: false, code, status, message: error.message, data: { ...extra, code: error.code } },
        { status },
      );
    }
  }
  throw error;
}

const reply = (status: number, message: string, code?: string) =>
  Response.json({ defined: false, code: code ?? "BAD_REQUEST", status, message }, { status });

async function session(deps: AssetDeps, request: Request) {
  const found = deps.auth ? await deps.auth.api.getSession({ headers: request.headers }) : null;
  if (!found) return { error: reply(401, "Chưa đăng nhập.", "UNAUTHORIZED") } as const;
  if (!deps.pool)
    return { error: reply(500, "Hub chưa cấu hình HIVE_DATABASE_URL.", "INTERNAL_SERVER_ERROR") } as const;
  const orgId = request.headers.get(ORG_HEADER) ?? new URL(request.url).searchParams.get("org");
  if (!orgId || !UUID.test(orgId)) return { error: reply(400, `Chưa chọn tổ chức (header ${ORG_HEADER}).`) } as const;
  if (tokenOrgMismatch(found, orgId)) return { error: reply(401, "Chưa đăng nhập.", "UNAUTHORIZED") } as const;
  return { pool: deps.pool, ctx: { userId: found.user.id, orgId } } as const;
}

const lfsRules = (patterns: readonly string[]) => patterns.map((pattern) => ({ pattern, filter: "lfs" }));

/** Đọc `.gitattributes` ở đầu nhánh; chỉ gọi khi file vượt trần thường, để quyết định từ chối hay đẩy qua LFS. */
async function freshLfsPatterns(provider: GitProvider, home: HomeRow): Promise<string[] | null> {
  try {
    const ref = { owner: home.owner, name: home.name };
    const head = await provider.branchHead(ref, home.branch);
    if (!head) return null;
    const content = await provider.readFile(ref, ".gitattributes", head);
    return parseGitattributes(content ?? "")
      .filter((rule) => rule.filter === "lfs")
      .map((rule) => rule.pattern);
  } catch {
    // Không đọc được repo thì giữ mẫu đã lưu; người dùng vẫn nhận lỗi vượt trần rõ ràng.
    return null;
  }
}

function tooLarge(limit: number): BadRequestError & { limit: number } {
  const mb = Math.floor(limit / 1024 ** 2);
  return Object.assign(
    new BadRequestError(
      "DOCSYNC_ASSET_TOO_LARGE",
      `File vượt giới hạn ${mb} MB. Hãy bật Git LFS cho loại file này trong .gitattributes của repo rồi tải lại.`,
    ),
    { limit },
  );
}

/**
 * POST /api/v1/docs/assets (multipart: `docKey`, `file`). Lưu vào kho file, ghi đính kèm `pending_push` và xếp lô đẩy;
 * markdown chèn `relativePath` trả về. Đi qua Hono vì oRPC không hợp với thân request lớn.
 */
export async function handleAssetUpload(deps: AssetDeps, request: Request): Promise<Response> {
  const auth = await session(deps, request);
  if ("error" in auth) return auth.error;
  const limits = deps.limits ?? loadDocStorageLimits();
  const ceiling = Math.max(limits.assetMaxBytes, limits.importMaxBytes);
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > ceiling + MULTIPART_OVERHEAD) return errorResponse(tooLarge(ceiling));
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return reply(400, "Thân request phải là multipart/form-data có trường docKey và file.");
  }
  const key = docKey.safeParse(form.get("docKey"));
  const file = form.get("file");
  if (!key.success || !(file instanceof File)) return reply(400, "Thiếu docKey hợp lệ hoặc file cần tải lên.");
  const principal: Principal = { kind: "user", userId: auth.ctx.userId };
  const blobStore = deps.blobStore ?? createPostgresBlobStore({ limits, ...(deps.jobs ? { jobs: deps.jobs } : {}) });
  const mediaType = file.type || "application/octet-stream";
  const name = assetFileName(file.name, mediaType);

  try {
    const prepared = await withTenant(auth.pool, auth.ctx, async (tx) => {
      await requireOrgRole(tx, auth.ctx.userId, "member");
      const doc = await getDoc(tx, principal, { key: key.data });
      await requirePropose(tx, auth.ctx.userId, doc);
      const location = await docLocation(tx, doc);
      if (!location) throw noHome();
      const path = [homeDir(location.home, doc.key), location.home.assetsDir.replace(/^\/+|\/+$/g, ""), name]
        .filter(Boolean)
        .join("/");
      const lfs = isLfsPath(path, lfsRules(location.home.lfsPatterns));
      const needsCheck = !lfs && file.size > limits.assetMaxBytes;
      const provider =
        needsCheck && deps.masterKey ? await homeProvider(tx, deps, location.home.connectionId) : undefined;
      return { doc, location, path, lfs, needsCheck, provider };
    });
    let { lfs } = prepared;
    let patterns: string[] | null = null;
    if (prepared.needsCheck && prepared.provider) {
      // Gọi provider ngoài transaction: không giữ kết nối database trong lúc chờ GitHub/GitLab.
      patterns = await freshLfsPatterns(prepared.provider, prepared.location.home);
      if (patterns) lfs = isLfsPath(prepared.path, lfsRules(patterns));
    }
    if (!lfs && file.size > limits.assetMaxBytes) throw tooLarge(limits.assetMaxBytes);

    const saved = await withTenant(auth.pool, auth.ctx, async (tx) => {
      const { doc, location } = prepared;
      if (patterns) await tx.update(docHomes).set({ lfsPatterns: patterns }).where(eq(docHomes.id, location.home.id));
      let blob: Awaited<ReturnType<BlobStore["put"]>>;
      try {
        blob = await blobStore.put(tx, auth.ctx.orgId, file.stream() as AsyncIterable<Uint8Array>, mediaType, {
          filename: name,
          maxBytes: lfs ? ceiling : limits.assetMaxBytes,
        });
      } catch (error) {
        if (error instanceof BadRequestError && error.code === "BLOB_TOO_LARGE")
          throw tooLarge(lfs ? ceiling : limits.assetMaxBytes);
        if (error instanceof BadRequestError && error.code === "BLOB_STORAGE_QUOTA")
          throw new ConflictError("DOCSYNC_ORG_STORAGE_FULL", "Tổ chức đã dùng hết dung lượng kho file.", {
            limit: limits.orgStorageBytes,
          });
        throw error;
      }
      // Cùng tên mà khác nội dung thì thêm hậu tố hash ngắn (FR-030); cùng nội dung thì dùng lại dòng cũ.
      let path = prepared.path;
      for (const candidate of [prepared.path, withSuffix(prepared.path, blob.sha256)]) {
        path = candidate;
        const [existing] = await tx
          .select()
          .from(docAssets)
          .where(and(eq(docAssets.homeId, location.home.id), eq(docAssets.repoPath, candidate)))
          .for("update");
        if (!existing) break;
        if (existing.sha256 === blob.sha256 && existing.blobId) return { asset: existing, location, queued: false };
      }
      const [asset] = await tx
        .insert(docAssets)
        .values({
          orgId: auth.ctx.orgId,
          homeId: location.home.id,
          repoPath: path,
          blobId: blob.id,
          mediaType: blob.mediaType,
          size: blob.size,
          sha256: blob.sha256,
          lfs,
          state: "pending_push",
          ownerDocId: doc.id,
        })
        .onConflictDoNothing()
        .returning();
      if (!asset) throw new ConflictError("DOCSYNC_ASSET_EXISTS", "Đã có file khác cùng tên. Hãy đổi tên rồi tải lại.");
      if (deps.jobs) await queuePush(deps.jobs, { orgId: auth.ctx.orgId, homeId: location.home.id }, { tx });
      return { asset, location, queued: true };
    });
    return Response.json(
      { assetId: saved.asset.id, relativePath: relativeFrom(saved.location.path, saved.asset.repoPath) },
      { status: saved.queued ? 201 : 200 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

function contentDisposition(path: string, mediaType: string): string {
  const name = path.split("/").at(-1) ?? "file";
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const kind = ACTIVE_TYPES.has(mediaType) ? "attachment" : "inline";
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Stream blob trong một transaction withTenant còn mở tới khi gửi xong (BlobStore.get chỉ đọc được trong transaction).
 * Đọc theo nhịp client (pull), nên file lớn không nằm hết trong bộ nhớ. Client đứng yên quá lâu thì cắt stream để trả
 * kết nối database về pool.
 */
function tenantStream(
  pool: pg.Pool,
  ctx: { userId: string; orgId: string },
  open: (tx: Tx) => Promise<AsyncIterable<Uint8Array>>,
): Promise<ReadableStream<Uint8Array>> {
  return new Promise((resolve, reject) => {
    let finish!: () => void;
    const finished = new Promise<void>((done) => {
      finish = done;
    });
    let failed: (error: unknown) => void = reject;
    withTenant(pool, ctx, async (tx) => {
      const iterator = (await open(tx))[Symbol.asyncIterator]();
      let idle: NodeJS.Timeout | undefined;
      const end = () => {
        clearTimeout(idle);
        finish();
      };
      resolve(
        new ReadableStream<Uint8Array>({
          start(controller) {
            idle = setTimeout(() => {
              controller.error(new Error("Client không đọc file đính kèm."));
              end();
            }, STREAM_IDLE_MS);
          },
          async pull(controller) {
            idle?.refresh();
            try {
              const next = await iterator.next();
              if (next.done) {
                controller.close();
                end();
              } else controller.enqueue(next.value);
            } catch (error) {
              controller.error(error);
              end();
            }
          },
          async cancel() {
            end();
            await iterator.return?.();
          },
        }),
      );
      failed = () => end();
      await finished;
    }).catch((error) => failed(error));
  });
}

async function readAll(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * GET /api/v1/docs/assets/:id hoặc /api/v1/docs/assets?doc=<key>&path=<đường dẫn tương đối>. Tổ chức lấy từ header
 * hoặc tham số `org` vì thẻ <img> không đặt được header.
 */
export async function handleAssetDownload(deps: AssetDeps, request: Request, id?: string): Promise<Response> {
  const auth = await session(deps, request);
  if ("error" in auth) return auth.error;
  const params = new URL(request.url).searchParams;
  const via = params.get("doc") ?? undefined;
  const principal: Principal = { kind: "user", userId: auth.ctx.userId };
  const blobStore = deps.blobStore ?? createPostgresBlobStore();
  try {
    const asset = await withTenant(auth.pool, auth.ctx, async (tx) => {
      await requireOrgRole(tx, auth.ctx.userId, "member");
      if (id === undefined) {
        const path = params.get("path");
        if (!via || !path) throw new BadRequestError("DOCSYNC_ASSET_QUERY", "Cần tham số doc và path của file.");
        return findDocAsset(tx, principal, { docKey: via, path });
      }
      if (!UUID.test(id)) throw assetNotFound();
      const [row] = await tx.select().from(docAssets).where(eq(docAssets.id, id));
      if (!row || !(await readableAsset(tx, principal, row, via))) throw assetNotFound();
      return assetView(row);
    });
    const [row] = await withTenant(auth.pool, auth.ctx, (tx) =>
      tx.select({ blobId: docAssets.blobId }).from(docAssets).where(eq(docAssets.id, asset.id)),
    );
    if (!row?.blobId)
      throw new NotFoundError(
        "DOCSYNC_ASSET_MISSING",
        asset.state === "missing_lfs" ? "Thiếu đối tượng LFS." : "File chưa được lưu ở hub.",
      );
    const blobId = row.blobId;
    const etag = `"${asset.sha256}"`;
    const headers = new Headers({
      "Content-Type": asset.mediaType,
      "Content-Disposition": contentDisposition(asset.repoPath, asset.mediaType),
      "Cache-Control": "private, max-age=300",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    });
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    headers.set("Content-Length", String(asset.size));
    // File nhỏ (đa số ảnh) đọc hết rồi đóng transaction ngay; chỉ file lớn mới giữ kết nối trong lúc gửi.
    const body =
      asset.size <= (deps.downloadBufferBytes ?? BUFFER_MAX_BYTES)
        ? await withTenant(auth.pool, auth.ctx, async (tx) => readAll(await blobStore.get(tx, auth.ctx.orgId, blobId)))
        : await tenantStream(auth.pool, auth.ctx, (tx) => blobStore.get(tx, auth.ctx.orgId, blobId));
    return new Response(body, { status: 200, headers });
  } catch (error) {
    return errorResponse(error);
  }
}
