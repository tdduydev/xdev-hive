import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, gzip, constants as zlibConstants } from "node:zlib";
import {
  buildCsp,
  buildFrameDocument,
  buildPublicPage,
  FRAME_TYPES,
  type FrameTheme,
  type FrameType,
  type LibManifest,
  publicPageHeaders,
} from "@xdev-hive/artifacts-runtime";
import { LIB_DIST_DIR, readLibManifest } from "@xdev-hive/artifacts-runtime/node";
import type { ArtifactType } from "@xdev-hive/contracts";
import { and, eq, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type pg from "pg";
import { ConflictError, createPostgresBlobStore, ForbiddenError, type Tx, withTenant } from "../platform/index.ts";
import { artifactError, type Reader } from "./access.ts";
import { blobTypeOf, isBlobType } from "./blob-types.ts";
import { artifactPolicyOf } from "./limits.ts";
import { countView, PublicViewLog, publicTarget, resolvePublicLink } from "./public-links.ts";
import {
  clientIp,
  type PublicRateLimiter,
  parseTrustedProxies,
  publicRateLimiter,
  type TrustedProxies,
  type Verdict,
} from "./rate-limit.ts";
import { artifactPreviews, artifacts } from "./schema.ts";
import { artifactFor, compileFor } from "./service.ts";
import { FRAME_TICKET_TTL_SEC, type FrameTicket, signFrameTicket, verifyFrameTicket } from "./ticket.ts";
import { checkContent, versionRow } from "./versions.ts";

/*
 * Khung cách ly trên host của hub (plan.md D4–D7, FR-070…FR-073). `/_artifact/*` không có phiên người dùng: không đọc
 * cookie hay `Authorization` (cùng host nên trình duyệt vẫn gửi cookie, ta bỏ qua), mọi quyền đến từ vé đã ký. Tài liệu
 * khung chạy trong `iframe sandbox="allow-scripts"` với origin mờ, CSP chỉ cho nạp thư viện từ `/_artifact/lib/`.
 */

/** Thư mục thư viện mà app desktop phục vụ qua giao thức `hive-artifact` (D17); app đổi host nếu nền tảng khác. */
export const APP_LIB_BASE = "hive-artifact://localhost/lib/";

const PREVIEW_TTL = sql`now() + interval '10 minutes'`;
/** Bản xem trước còn hạn tối đa mỗi người: soạn liên tục sinh nhiều bản, giữ dung lượng bị chiếm có trần. */
const PREVIEWS_PER_USER = 20;

export interface FrameDeps {
  /** Khoá vé (`frameTicketKey`); không có khi hub thiếu `HIVE_MASTER_KEY`, lúc đó không cấp hay nhận vé. */
  frameKey?: Buffer | undefined;
  /** URL công khai của hub: URL khung và nguồn thư viện trong CSP dựng từ đây. */
  publicUrl: string;
}

const frameUrlOf = (publicUrl: string, ticket: string) => new URL(`/_artifact/frame/${ticket}`, publicUrl).href;
const blobBaseOf = (publicUrl: string) => new URL("/_artifact/blob/", publicUrl).href;
export const hubLibBase = (publicUrl: string) => new URL("/_artifact/lib/", publicUrl).href;

const isFrameType = (type: ArtifactType): type is FrameType => (FRAME_TYPES as readonly string[]).includes(type);

function assertFrameType(type: ArtifactType): asserts type is FrameType {
  if (!isFrameType(type)) throw artifactError("ARTIFACT_TYPE_DISABLED", "Loại artifact này không mở trong khung.");
}

function requireKey(deps: FrameDeps): Buffer {
  if (!deps.frameKey)
    throw new ConflictError(
      "ARTIFACT_FRAME_UNAVAILABLE",
      "Hub chưa đặt HIVE_MASTER_KEY nên chưa mở được khung artifact.",
    );
  return deps.frameKey;
}

/** Đọc manifest thư viện một lần; chưa dựng thì lần sau đọc lại (dựng xong không phải khởi động lại hub). */
export function libManifestLoader(libDir: string = LIB_DIST_DIR): () => LibManifest | null {
  let cached: LibManifest | null = null;
  return () => {
    if (cached) return cached;
    try {
      cached = readLibManifest(libDir);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }
    return cached;
  };
}

/** Phiên bản xem được trong khung: còn nội dung hoặc tệp (chưa xoá vì bí mật) và artifact không nằm trong thùng rác. */
async function framedVersion(tx: Tx, reader: Reader, input: { id: string; version: number }) {
  const row = await artifactFor(tx, reader, input.id);
  if (row.deletedAt) throw artifactError("ARTIFACT_NOT_FOUND", "Artifact đang ở thùng rác. Khôi phục trước khi xem.");
  assertFrameType(row.type);
  const v = await versionRow(tx, row.id, input.version);
  if (!v) throw artifactError("ARTIFACT_NOT_FOUND", "Không tìm thấy phiên bản này.");
  if (v.tombstonedAt || (v.content === null && !v.blobId))
    throw artifactError("ARTIFACT_NOT_FOUND", "Phiên bản này đã bị xoá vì chứa bí mật.");
  return { row: { ...row, type: row.type }, v };
}

/** `artifacts.frameUrl`: vé ≤ 5 phút cho đúng một phiên bản người gọi đọc được. */
export async function frameUrl(
  tx: Tx,
  reader: Reader,
  input: { id: string; version: number; theme: FrameTheme },
  deps: FrameDeps,
): Promise<{ url: string; expiresAt: string }> {
  const { row, v } = await framedVersion(tx, reader, input);
  const { ticket, expiresAt } = signFrameTicket(requireKey(deps), {
    o: row.orgId,
    a: row.id,
    v: v.version,
    t: input.theme,
  });
  return { url: frameUrlOf(deps.publicUrl, ticket), expiresAt: expiresAt.toISOString() };
}

/**
 * `artifacts.frameDocument`: tài liệu khung đã dựng cho app desktop đệm và mở offline (D17), để app không phải chép
 * `buildFrameDocument` sang Rust. Thư viện trỏ vào giao thức của app, không phải hub, vì lúc mở có thể không có mạng.
 */
export async function frameDocument(
  tx: Tx,
  reader: Reader,
  input: { id: string; version: number; theme: FrameTheme },
  manifest: () => LibManifest | null,
): Promise<{ html: string; csp: string }> {
  const { row, v } = await framedVersion(tx, reader, input);
  // App đệm tài liệu khung để mở offline; tệp ảnh/PDF cần vé còn hạn từ hub nên không đệm được theo cách này.
  if (isBlobType(row.type) || v.content === null)
    throw new ConflictError("ARTIFACT_FRAME_UNAVAILABLE", "Ảnh và PDF chỉ xem được khi có kết nối tới hub.");
  const libs = manifest();
  if (!libs) throw new ConflictError("ARTIFACT_FRAME_UNAVAILABLE", "Hub chưa có bộ thư viện của khung artifact.");
  return {
    html: buildFrameDocument({
      type: row.type,
      content: v.content,
      compiled: v.compiled,
      compileError: v.compileError,
      theme: input.theme,
      manifest: libs,
      libBase: APP_LIB_BASE,
    }),
    csp: buildCsp({ libBase: APP_LIB_BASE }),
  };
}

/**
 * `artifacts.preview` (D14): nội dung chưa lưu vào bảng tạm 10 phút rồi cấp vé `p:`, vì nội dung quá dài cho URL và khung
 * phải nạp bằng URL (D4). Cùng kiểm như khi lưu: loại bật, cỡ, bí mật (chặn, audit ở lớp router), biên dịch `react`.
 */
export async function createPreview(
  tx: Tx,
  reader: Reader,
  input: { type: ArtifactType; content: string; theme: FrameTheme },
  deps: FrameDeps,
): Promise<{ url: string; expiresAt: string; compileError: string | null }> {
  if (reader.kind !== "user") throw new ForbiddenError("FORBIDDEN", "Chỉ người dùng xem trước được.");
  const { userId } = reader;
  const key = requireKey(deps);
  const policy = await artifactPolicyOf(tx);
  assertFrameType(input.type);
  if (isBlobType(input.type)) throw artifactError("ARTIFACT_TYPE_DISABLED", "Ảnh và PDF không có bản xem trước.");
  checkContent(policy, input.type, { content: input.content, compiled: { compiled: null, compileError: null } }, null);
  const compiled = await compileFor(input.type, input.content);
  await tx.execute(sql`
    delete from hive.artifact_previews where id in (
      select id from hive.artifact_previews where user_id = ${userId}
      order by expires_at desc offset ${PREVIEWS_PER_USER - 1}
    )`);
  const [row] = await tx
    .insert(artifactPreviews)
    .values({
      orgId: sql`hive.ctx_org()`,
      userId,
      type: input.type,
      content: input.content,
      compiled: compiled.compiled,
      expiresAt: PREVIEW_TTL,
    })
    .returning({ id: artifactPreviews.id, orgId: artifactPreviews.orgId });
  if (!row) throw new Error("Không lưu được bản xem trước.");
  const { ticket, expiresAt } = signFrameTicket(key, { o: row.orgId, p: row.id, t: input.theme });
  return {
    url: frameUrlOf(deps.publicUrl, ticket),
    expiresAt: expiresAt.toISOString(),
    compileError: compiled.compileError,
  };
}

// ---- Route HTTP ----------------------------------------------------------------------------------------------------

export interface FrameRoutesDeps extends FrameDeps {
  /** Không có khi chạy test đơn vị không cần database; lúc đó chỉ phục vụ thư viện. */
  pool?: pg.Pool | undefined;
  /** Thư mục `dist/lib` của `@xdev-hive/artifacts-runtime`. */
  libDir?: string | undefined;
  /** Mặc định đọc `HIVE_TRUSTED_PROXIES`. */
  trustedProxies?: TrustedProxies | undefined;
  /** Mặc định 60/phút mỗi IP, 600/phút mỗi link (D22); test truyền bộ riêng để không dính lượt của ca khác. */
  rateLimiter?: PublicRateLimiter | undefined;
  viewLog?: PublicViewLog | undefined;
  /** Địa chỉ kết nối; mặc định lấy từ socket của `@hono/node-server`, test giả bằng hàm này. */
  remoteAddress?: ((c: Context) => string | undefined) | undefined;
}

/** FR-071: header chung của mọi phản hồi khung, kể cả trang lỗi. */
const FRAME_HEADERS = {
  "Cross-Origin-Resource-Policy": "same-site",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

/** Khung là origin mờ nên `<img>` và `fetch` của nó là yêu cầu chéo origin; `same-site` của FRAME_HEADERS sẽ chặn chúng. */
const CROSS_ORIGIN = {
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Access-Control-Allow-Origin": "*",
} as const;

const LIB_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".woff2": "font/woff2",
};
const COMPRESSIBLE = new Set([".css", ".js", ".mjs", ".json", ".map"]);

type Loaded = {
  type: FrameType;
  content: string;
  /** Ảnh và PDF: tệp trong kho file; khung đọc qua `/_artifact/blob/<vé>`. */
  blobId: string | null;
  compiled: string | null;
  compileError: string | null;
  preview: boolean;
  /** Vé `s`: phục vụ cho người ngoài nên không giữ cache, để link vừa thu hồi không còn mở được từ cache. */
  publicLink: boolean;
};

/** `null`: không có (vé trỏ tới thứ không tồn tại trong tổ chức của vé); `gone`: đã xoá hoặc đã bị xoá vì bí mật. */
async function loadFramed(tx: Tx, t: FrameTicket): Promise<Loaded | "gone" | null> {
  if ("p" in t) {
    const [p] = await tx
      .select()
      .from(artifactPreviews)
      .where(and(eq(artifactPreviews.id, t.p), sql`${artifactPreviews.expiresAt} > now()`));
    if (!p || !isFrameType(p.type) || isBlobType(p.type)) return null;
    let compileError: string | null = null;
    // Bảng xem trước không có cột lỗi biên dịch: `react` không có bản biên dịch nghĩa là biên dịch lỗi, dựng lại để có chữ lỗi.
    if (p.type === "react" && !p.compiled) {
      try {
        compileError = (await compileFor(p.type, p.content)).compileError;
      } catch (error) {
        compileError = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      type: p.type,
      content: p.content,
      blobId: null,
      compiled: p.compiled,
      compileError,
      preview: true,
      publicLink: false,
    };
  }
  // Vé của link công khai được kiểm lại link mỗi lần nạp (còn hạn, chưa thu hồi, chính sách bật…): vé sống 5 phút, link
  // có thể bị thu hồi trong khoảng đó. Mọi lý do đều là "không có" để không dò được link đã từng tồn tại.
  if (t.s) {
    const target = await publicTarget(tx, t.s);
    if (!target || target.artifactId !== t.a || target.version !== t.v || !isFrameType(target.type)) return null;
    await countView(tx, target.linkId);
    return {
      type: target.type,
      content: target.content ?? "",
      blobId: target.blobId,
      compiled: target.compiled,
      compileError: target.compileError,
      preview: false,
      publicLink: true,
    };
  }
  const [a] = await tx
    .select({ type: artifacts.type, deletedAt: artifacts.deletedAt })
    .from(artifacts)
    .where(eq(artifacts.id, t.a));
  if (!a || !isFrameType(a.type)) return null;
  if (a.deletedAt) return "gone";
  const v = await versionRow(tx, t.a, t.v);
  if (!v) return null;
  if (v.tombstonedAt || (v.content === null && !v.blobId)) return "gone";
  return {
    type: a.type,
    content: v.content ?? "",
    blobId: v.blobId,
    compiled: v.compiled,
    compileError: v.compileError,
    preview: false,
    publicLink: false,
  };
}

type BlobBody = { bytes: Uint8Array<ArrayBuffer>; mediaType: string };

/**
 * Tệp của một vé: cùng kiểm với `loadFramed` (link còn mở, artifact chưa vào thùng rác, phiên bản còn tệp) để vé của link
 * vừa thu hồi không đọc được tệp. Đọc hết trong transaction vì luồng của `BlobStore` chỉ sống trong đó; trần cỡ đã chặn
 * lúc tải lên (`maxBlobBytes`) nên gom vào bộ nhớ có giới hạn.
 */
async function loadBlob(tx: Tx, t: FrameTicket): Promise<BlobBody | "gone" | null> {
  if (!("a" in t)) return null;
  let blobId: string | null;
  if (t.s) {
    const target = await publicTarget(tx, t.s);
    if (!target || target.artifactId !== t.a || target.version !== t.v) return null;
    blobId = target.blobId;
  } else {
    const [a] = await tx.select({ deletedAt: artifacts.deletedAt }).from(artifacts).where(eq(artifacts.id, t.a));
    if (!a) return null;
    if (a.deletedAt) return "gone";
    const v = await versionRow(tx, t.a, t.v);
    if (!v) return null;
    if (v.tombstonedAt) return "gone";
    blobId = v.blobId;
  }
  if (!blobId) return null;
  const store = createPostgresBlobStore();
  const ref = await store.stat(tx, t.o, blobId);
  // Chỉ phục vụ loại đã qua kiểm magic bytes lúc tải lên; loại khác (SVG, zip…) không bao giờ ra khỏi route này.
  if (!ref || !blobTypeOf(ref.mediaType)) return null;
  const bytes = new Uint8Array(ref.size);
  let at = 0;
  for await (const chunk of await store.get(tx, t.o, blobId)) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return { bytes, mediaType: ref.mediaType };
}

function plain(status: 403 | 404 | 410 | 429 | 503, text: string, extra: Record<string, string> = {}): Response {
  return new Response(text, {
    status,
    headers: {
      ...FRAME_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      // Trang lỗi cũng có thể bị mở trực tiếp; không có lý do cho nó chạy gì.
      "Content-Security-Policy": "default-src 'none'; sandbox",
      ...extra,
    },
  });
}

const PUBLIC_NOT_FOUND_TEXT = "Liên kết không tồn tại hoặc đã hết hạn.";
const TOO_MANY_TEXT = "Quá nhiều yêu cầu. Thử lại sau.";

/**
 * Trang 404 của link công khai: một trang cho mọi lý do (mã sai, hết hạn, thu hồi, thùng rác, tombstone, chính sách tắt),
 * cùng nội dung và header, để người ngoài không phân biệt được link chưa từng có với link đã tắt (FR-142, SC-012).
 */
const PUBLIC_NOT_FOUND_PAGE = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Không tìm thấy</title><style>body{margin:0;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#fff;color:#18181b}main{max-width:640px;margin:0 auto;padding:4rem 1rem}h1{font-size:1.25rem;margin:0}@media (prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}}</style></head><body><main><h1>${PUBLIC_NOT_FOUND_TEXT}</h1></main></body></html>`;

function publicNotFound(): Response {
  return new Response(PUBLIC_NOT_FOUND_PAGE, {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

const tooMany = (verdict: Extract<Verdict, { ok: false }>) =>
  plain(429, TOO_MANY_TEXT, { "Retry-After": String(verdict.retryAfterSec), "X-Robots-Tag": "noindex, nofollow" });

/** Địa chỉ socket do `@hono/node-server` đặt vào `c.env`; không có (test, adapter khác) thì không biết IP. */
function socketAddress(c: Context): string | undefined {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress;
}

const VIEW_FLUSH_MS = 60_000;

/**
 * `/_artifact/frame/:ticket` và `/_artifact/lib/*`. Đăng ký trước SPA và trước `/rpc`, `/api` (FR-073); mọi đường khác
 * dưới `/_artifact/` trả 404 thay vì rơi vào `index.html` của web.
 */
export function frameRoutes(deps: FrameRoutesDeps): Hono {
  const app = new Hono();
  const libDir = resolve(deps.libDir ?? LIB_DIST_DIR);
  const manifest = libManifestLoader(libDir);
  const libBase = hubLibBase(deps.publicUrl);
  const trusted = deps.trustedProxies ?? parseTrustedProxies(process.env.HIVE_TRUSTED_PROXIES);
  const limiter = deps.rateLimiter ?? publicRateLimiter();
  const viewLog = deps.viewLog ?? new PublicViewLog();
  const remoteOf = deps.remoteAddress ?? socketAddress;
  const ipOf = (c: Context) => clientIp(remoteOf(c), c.req.header("x-forwarded-for"), trusted);
  const pool = deps.pool;
  if (pool) setInterval(() => void viewLog.flush(pool), VIEW_FLUSH_MS).unref();

  const blobBase = blobBaseOf(deps.publicUrl);

  app.get("/_artifact/frame/:ticket", async (c) => {
    const ticket = deps.frameKey ? verifyFrameTicket(deps.frameKey, c.req.param("ticket")) : null;
    if (!ticket) return plain(403, "Vé khung không hợp lệ hoặc đã hết hạn. Tải lại khung để nhận vé mới.");
    // Khung của link công khai do người ngoài mở nên chung hạn mức với trang `/s/`; vé khác cần người đã đăng nhập.
    const publicLink = "s" in ticket && ticket.s ? ticket.s : null;
    const ip = publicLink ? ipOf(c) : null;
    if (publicLink && ip) {
      const verdict = limiter.ip(ip);
      if (!verdict.ok) return tooMany(verdict);
      const perLink = limiter.link(publicLink);
      if (!perLink.ok) return tooMany(perLink);
    }
    if (!deps.pool) return plain(503, "Hub chưa nối database nên chưa mở được artifact.");
    const libs = manifest();
    if (!libs) return plain(503, "Hub chưa có bộ thư viện của khung artifact.");
    // Ngữ cảnh tổ chức lấy từ vé đã ký, không người dùng: RLS giữ truy vấn trong đúng tổ chức của vé.
    const found = await withTenant(deps.pool, { orgId: ticket.o }, (tx) => loadFramed(tx, ticket));
    if (found === null) return plain(404, publicLink ? PUBLIC_NOT_FOUND_TEXT : "Không tìm thấy artifact.");
    if (found === "gone") return plain(410, "Artifact hoặc phiên bản này đã bị xoá.");
    if (publicLink && ip && "a" in ticket)
      viewLog.record({ orgId: ticket.o, linkId: publicLink, artifactId: ticket.a, version: ticket.v, ip });
    const html = buildFrameDocument({
      type: found.type,
      content: found.content,
      compiled: found.compiled,
      compileError: found.compileError,
      theme: ticket.t,
      manifest: libs,
      libBase,
      // Cùng vé với khung: tệp sống đúng bằng đời khung và chịu cùng kiểm thu hồi.
      blobUrl: found.blobId ? `${blobBase}${c.req.param("ticket")}` : undefined,
    });
    return new Response(html, {
      status: 200,
      headers: {
        ...FRAME_HEADERS,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": buildCsp({ libBase, blobBase: found.blobId ? blobBase : undefined }),
        // Bản xem trước đổi theo từng lần gõ và có thể chứa thứ người dùng chưa định lưu; phiên bản thì bất biến nên
        // giữ trong cache riêng đúng bằng đời của vé.
        "Cache-Control":
          found.preview || found.publicLink ? "private, no-store" : `private, max-age=${FRAME_TICKET_TTL_SEC}`,
      },
    });
  });

  /*
   * Tệp của ảnh và PDF. Cùng vé với khung nên không có phiên người dùng; khung là origin mờ nên đọc bằng CORS `*`, an
   * toàn vì quyền nằm ở vé chứ không ở origin. Link công khai chung hạn mức IP/link với khung, không đếm thêm lượt xem
   * (khung đã đếm).
   */
  app.get("/_artifact/blob/:ticket", async (c) => {
    const ticket = deps.frameKey ? verifyFrameTicket(deps.frameKey, c.req.param("ticket")) : null;
    if (!ticket) return plain(403, "Vé không hợp lệ hoặc đã hết hạn. Tải lại khung để nhận vé mới.", CROSS_ORIGIN);
    const publicLink = "s" in ticket && ticket.s ? ticket.s : null;
    if (publicLink) {
      const verdict = limiter.ip(ipOf(c));
      if (!verdict.ok) return tooMany(verdict);
      const perLink = limiter.link(publicLink);
      if (!perLink.ok) return tooMany(perLink);
    }
    if (!deps.pool) return plain(503, "Hub chưa nối database nên chưa mở được artifact.", CROSS_ORIGIN);
    const found = await withTenant(deps.pool, { orgId: ticket.o }, (tx) => loadBlob(tx, ticket));
    if (found === null) return plain(404, publicLink ? PUBLIC_NOT_FOUND_TEXT : "Không tìm thấy tệp.", CROSS_ORIGIN);
    if (found === "gone") return plain(410, "Artifact hoặc phiên bản này đã bị xoá.", CROSS_ORIGIN);
    return new Response(found.bytes, {
      status: 200,
      headers: {
        ...FRAME_HEADERS,
        ...CROSS_ORIGIN,
        "Content-Type": found.mediaType,
        "Content-Length": String(found.bytes.length),
        // Mở thẳng URL này không có lý do chạy gì: tệp chỉ là dữ liệu cho khung.
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": publicLink ? "private, no-store" : `private, max-age=${FRAME_TICKET_TTL_SEC}`,
      },
    });
  });

  /*
   * Trang link công khai (D21, FR-143): trang tĩnh không script, nội dung nằm trong khung với vé `s` dựng ngay lúc trả
   * trang. Không đọc cookie hay `Authorization`; giới hạn IP đứng trước mọi truy vấn database để dò mã tốn hạn mức.
   */
  app.get("/_artifact/s/:token", async (c) => {
    const verdict = limiter.ip(ipOf(c));
    if (!verdict.ok) return tooMany(verdict);
    if (!deps.pool || !deps.frameKey) return plain(503, "Hub chưa sẵn sàng mở link công khai.");
    const key = deps.frameKey;
    const pool = deps.pool;
    const link = await resolvePublicLink(pool, c.req.param("token"));
    if (!link) return publicNotFound();
    const perLink = limiter.link(link.linkId);
    if (!perLink.ok) return tooMany(perLink);
    const target = await withTenant(pool, { orgId: link.orgId }, (tx) => publicTarget(tx, link.linkId));
    if (!target || !isFrameType(target.type)) return publicNotFound();
    // Trang không có script nên không biết người xem dùng nền tối; khung theo nền sáng như trang (trang tự đổi màu).
    const { ticket } = signFrameTicket(key, {
      o: link.orgId,
      a: target.artifactId,
      v: target.version,
      s: target.linkId,
      t: "light",
    });
    const url = frameUrlOf(deps.publicUrl, ticket);
    const html = buildPublicPage({
      title: target.title,
      type: target.type,
      version: target.version,
      expiresAt: target.expiresAt,
      frameUrl: url,
    });
    return new Response(html, {
      status: 200,
      headers: { ...publicPageHeaders({ frameUrl: url }), "Content-Type": "text/html; charset=utf-8" },
    });
  });

  // File thư viện không đổi trong suốt tiến trình (tên có phiên bản), nên chỉ nén một lần rồi giữ bản nén như /assets/.
  const compressed = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
  const brotli = promisify(brotliCompress);
  const gz = promisify(gzip);
  const encode = (encoding: "br" | "gzip", body: Buffer) =>
    (encoding === "br"
      ? brotli(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 } })
      : gz(body, { level: 9 })
    ).then((b) => new Uint8Array(b));

  app.get("/_artifact/lib/*", async (c) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.notFound();
    }
    const requested = resolve(libDir, `.${pathname.slice("/_artifact/lib".length)}`);
    if (!requested.startsWith(`${libDir}${sep}`)) return c.notFound();
    let body: Buffer;
    try {
      body = await readFile(requested);
    } catch {
      return c.notFound();
    }
    const ext = extname(requested);
    const headers: Record<string, string> = {
      "Content-Type": LIB_TYPES[ext] ?? "application/octet-stream",
      // Khung là origin mờ (`Origin: null`) nên nạp module là yêu cầu CORS; thư viện là mã công khai, không phụ thuộc
      // người gọi, nên `*` không lộ gì.
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    };
    if (!COMPRESSIBLE.has(ext) || body.length < 1024) return c.body(new Uint8Array(body), 200, headers);
    headers.Vary = "Accept-Encoding";
    const accept = c.req.header("accept-encoding") ?? "";
    const encoding = /\bbr\b/.test(accept) ? "br" : /\bgzip\b/.test(accept) ? "gzip" : null;
    if (!encoding) return c.body(new Uint8Array(body), 200, headers);
    const key = `${encoding}:${requested}`;
    let packed = compressed.get(key);
    if (!packed) {
      packed = encode(encoding, body);
      compressed.set(key, packed);
      packed.catch(() => compressed.delete(key));
    }
    return c.body(await packed, 200, { ...headers, "Content-Encoding": encoding });
  });

  app.all("/_artifact/*", () => plain(404, "Không tìm thấy."));
  return app;
}
