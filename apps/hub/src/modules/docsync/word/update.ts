import { mergeBlocks, normalizeDoc } from "@xdev-hive/contracts";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { recordAudit } from "../../audit/index.ts";
import { DocSecretError, getDoc, type Principal, readerFor, saveDoc } from "../../knowledge/index.ts";
import { BadRequestError, ConflictError, NotFoundError, type Tx } from "../../platform/index.ts";
import { markOrphanAssets } from "../asset-orphans.ts";
import { docLocation, relativeFrom } from "../assets.ts";
import { queueHomePush } from "../push.ts";
import type { DocSyncDeps } from "../routes/deps.ts";
import { docConflicts, docWordImportFiles } from "../schema.ts";
import { assetsDirOf, attachImages, FileFailure, stripFrontMatter } from "./attach.ts";
import { frontMatter } from "./postprocess.ts";
import { canManage, docKeyOf, loadWordTarget } from "./shared.ts";
import { stageProposal } from "./staging.ts";
import type { WordImportFileRow } from "./tools.ts";

/*
 * Cập nhật tài liệu từ bản Word mới (US3, FR-024…FR-026, plan.md mục 8). Gốc là Markdown của lần nhập hoặc gắn gần
 * nhất, hai bên là bản hiện tại trên hub và bản vừa chuyển. Hợp theo khối như hợp với repo; chồng nhau thì ghi xung
 * đột `origin = 'word'` để màn xung đột sẵn có xử lý, không ghi đè phần đã sửa trên hub.
 */

// Như IMAGE_LINK của postprocess.ts; link tải EMF/WMF (Q10) cũng trỏ vào thư mục ảnh nên chuẩn cùng.
const IMAGE_LINK = /(!\[[^\]]*\]\()([^()\s]+)(\))/g;
const DOWNLOAD_LINK = /((?<!!)\[[^\]]*\]\()((?:[^()\s]*\/)?[0-9a-f]{12}\.(?:emf|wmf|emz|wmz))(\))/g;
const nameOf = (target: string) => target.slice(target.lastIndexOf("/") + 1);

interface Normalized {
  text: string;
  /** Tên ảnh → đích link gốc (lần đầu gặp). */
  targets: Map<string, string>;
}

/**
 * Link ảnh chỉ còn tên ảnh, xuống dòng LF. Bản chuyển chưa có đường dẫn (link là tên băm), tài liệu trên hub trỏ tới
 * thư mục ảnh của nhà, tài liệu gắn từ `srs2md` trỏ `assets/` của module: không chuẩn thì mọi ảnh thành chỗ sửa trên hub.
 */
function normalizeLinks(markdown: string): Normalized {
  const targets = new Map<string, string>();
  const rename = (_all: string, open: string, target: string, close: string) => {
    const name = nameOf(target);
    if (!targets.has(name)) targets.set(name, target);
    return `${open}${name}${close}`;
  };
  const text = markdown.replace(/\r\n?/g, "\n").replace(IMAGE_LINK, rename).replace(DOWNLOAD_LINK, rename);
  return { text, targets };
}

function splitFront(content: string): { front: string; body: string } {
  const lf = content.replace(/\r\n?/g, "\n");
  const body = stripFrontMatter(lf);
  return { front: lf.slice(0, lf.length - body.length), body };
}

export interface UpdateInput {
  /** Markdown của lần nhập hoặc gắn trước (còn front matter của lần chuyển). */
  base: string;
  /** Nội dung hiện tại trên hub. */
  current: string;
  /** Markdown vừa chuyển. */
  markdown: string;
  title: string;
  fileName: string;
  sha256: string;
  confidential: boolean;
  /** Tên các ảnh của bản vừa chuyển. */
  images: ReadonlySet<string>;
  /** null khi tài liệu chưa có đường dẫn trong nhà: link ảnh mới giữ là tên ảnh. */
  docPath: string | null;
  assetsDir: string;
}

export interface UpdatePlan {
  /** Kết quả hợp; có xung đột thì các khối chồng nhau giữ bản trên hub. */
  content: string;
  conflicts: number;
  /** Gốc và bản Word cùng dạng với bản trên hub, để màn xung đột so ba bản. */
  base: string;
  word: string;
  /** Ảnh của bản mới mà kết quả trỏ vào thư mục ảnh của nhà: cần ghi vào nhà khi hợp sạch. */
  used: Set<string>;
  /** Như `used` nhưng theo bản Word: cần ghi khi có xung đột, vì người giải quyết có thể chọn bản Word. */
  wordUsed: Set<string>;
}

/** Hợp ba bên, hàm thuần. Front matter tách riêng: tiêu đề do hub giữ, `word.sha256` luôn theo bản mới. */
export function planUpdate(input: UpdateInput): UpdatePlan {
  const hub = splitFront(input.current);
  const base = normalizeLinks(stripFrontMatter(input.base));
  const mine = normalizeLinks(hub.body);
  const theirs = normalizeLinks(stripFrontMatter(input.markdown));
  const merged = mergeBlocks(base.text, mine.text, theirs.text);
  // Front matter do bước nhập sinh (có `word:`) thì dựng lại; của nơi khác (`srs2md`) thì giữ nguyên.
  const ours = /^word:[ \t]*$/m.test(hub.front);
  const front = ours
    ? frontMatter({
        title: input.title,
        file: input.fileName,
        sha256: input.sha256,
        confidential: input.confidential || /^confidential:[ \t]*true[ \t]*$/m.test(hub.front),
      })
    : hub.front;
  const restore = (text: string, used: Set<string>) => {
    const relink = (all: string, open: string, target: string, close: string) => {
      if (target.includes("/")) return all;
      // Tài liệu đang trỏ ảnh này ở đâu thì giữ đúng chỗ đó; ảnh mới của bản Word vào thư mục ảnh của nhà.
      const known = mine.targets.get(target);
      if (known !== undefined) return `${open}${known}${close}`;
      if (input.docPath && input.images.has(target)) {
        used.add(target);
        return `${open}${relativeFrom(input.docPath, `${input.assetsDir}/${target}`)}${close}`;
      }
      return all;
    };
    return text.replace(IMAGE_LINK, relink).replace(DOWNLOAD_LINK, relink);
  };
  const used = new Set<string>();
  const wordUsed = new Set<string>();
  return {
    content: front + restore(merged.content, used),
    conflicts: merged.conflicts,
    base: hub.front + restore(base.text, new Set()),
    word: front + restore(theirs.text, wordUsed),
    used,
    wordUsed,
  };
}

/** Lần nhập hoặc gắn gần nhất của tài liệu: gốc của lần cập nhật này. */
async function previousImport(tx: Tx, docId: string, fileId: string) {
  const [row] = await tx
    .select({ markdown: docWordImportFiles.markdown, sha256: docWordImportFiles.sha256 })
    .from(docWordImportFiles)
    .where(
      and(
        eq(docWordImportFiles.docId, docId),
        eq(docWordImportFiles.state, "done"),
        ne(docWordImportFiles.id, fileId),
        sql`${docWordImportFiles.markdown} is not null`,
      ),
    )
    .orderBy(desc(docWordImportFiles.updatedAt))
    .limit(1);
  return row?.markdown == null ? null : { markdown: row.markdown, sha256: row.sha256 };
}

async function markUnchanged(tx: Tx, file: WordImportFileRow, docId: string): Promise<void> {
  await tx
    .update(docWordImportFiles)
    .set({ state: "skipped", docId, docVersion: null, error: null, updatedAt: new Date() })
    .where(eq(docWordImportFiles.id, file.id));
}

/**
 * Lượt `update` (plan.md mục 8): job chuyển gọi sau khi file `ready`. Cùng SHA-256 với lần trước thì `skipped`
 * ("Không có gì thay đổi", FR-025). Không thì thử hợp để xem trước: `linkMatches` true là hợp sạch, false là có chỗ
 * chồng nhau. Chưa có lần nhập trước thì để nguyên, bước tạo báo lỗi.
 */
export async function prepareUpdate(tx: Tx, file: WordImportFileRow): Promise<void> {
  if (file.markdown == null) return;
  const target = await loadWordTarget(tx, file.importId);
  const docId = target.imp.updateDocId;
  if (target.imp.mode !== "update" || !docId) return;
  const base = await previousImport(tx, docId, file.id);
  if (!base) return;
  if (base.sha256 === file.sha256) return markUnchanged(tx, file, docId);
  const { rows } = await tx.execute<{ content: string }>(sql`
    select v.content from hive.docs d
    join hive.doc_versions v on v.doc_id = d.id and v.version = d.current_version
    where d.id = ${docId}`);
  const current = rows[0]?.content;
  if (current === undefined) return;
  const { conflicts } = mergeBlocks(
    normalizeLinks(stripFrontMatter(base.markdown)).text,
    normalizeLinks(stripFrontMatter(current)).text,
    normalizeLinks(stripFrontMatter(file.markdown)).text,
  );
  await tx
    .update(docWordImportFiles)
    .set({ linkMatches: conflicts === 0, updatedAt: new Date() })
    .where(eq(docWordImportFiles.id, file.id));
}

/**
 * Bước tạo của lượt `update`: hợp ba bên rồi lưu nguồn `word`, hoặc ghi xung đột `origin = 'word'`. Có xung đột thì
 * file vẫn `done` (không có `doc_version`): bản Word này thành gốc của lần cập nhật sau, phần chồng nhau nằm ở màn xung
 * đột. Lỗi của riêng file (ảnh hỏng, bí mật chưa xác nhận) ghi vào file, như bước tạo.
 */
export async function commitUpdate(
  tx: Tx,
  deps: DocSyncDeps,
  principal: Principal,
  file: WordImportFileRow,
): Promise<void> {
  if (file.markdown == null) return;
  const target = await loadWordTarget(tx, file.importId);
  const docId = target.imp.updateDocId;
  const key = await docKeyOf(tx, docId);
  if (!docId || !key) throw new NotFoundError("DOC_NOT_FOUND", "Không tìm thấy tài liệu cần cập nhật.");
  if (!(await canManage(tx, await readerFor(tx, principal), key))) {
    await stageProposal(tx, principal, file);
    return;
  }
  const base = await previousImport(tx, docId, file.id);
  if (!base)
    throw new BadRequestError(
      "WORD_IMPORT_NO_BASE",
      "Tài liệu chưa nhập hay gắn với file Word nào. Gắn tài liệu với file Word trước khi cập nhật.",
    );
  if (base.sha256 === file.sha256) return markUnchanged(tx, file, docId);
  const [open] = await tx
    .select({ id: docConflicts.id })
    .from(docConflicts)
    .where(and(eq(docConflicts.docId, docId), eq(docConflicts.state, "open")));
  if (open)
    throw new ConflictError(
      "DOCSYNC_CONFLICT_OPEN",
      "Tài liệu đang có xung đột chưa giải quyết. Giải quyết xung đột rồi cập nhật lại từ Word.",
    );

  const doc = await getDoc(tx, principal, { key });
  const { home } = target;
  const location = await docLocation(tx, doc);
  const plan = planUpdate({
    base: base.markdown,
    current: doc.content,
    markdown: file.markdown,
    title: doc.title,
    fileName: file.fileName,
    sha256: file.sha256,
    confidential: target.imp.confidential,
    images: new Set(file.images.map((image) => image.name)),
    docPath: location && location.home.id === home.id ? location.path : null,
    assetsDir: assetsDirOf(home, key),
  });
  const images = (used: Set<string>) => file.images.filter((image) => used.has(image.name));

  // withTenant đã mở transaction nên dùng savepoint tay, như commit.ts: lỗi của file không làm hỏng việc ghi lỗi.
  await tx.execute(sql`savepoint word_update_file`);
  try {
    let docVersion: number | null = null;
    if (plan.conflicts > 0) {
      await attachImages(tx, home, images(plan.wordUsed), docId, key);
      await tx.insert(docConflicts).values({
        orgId: home.orgId,
        homeId: home.id,
        docId,
        baseVersion: doc.version,
        hubVersion: doc.version,
        origin: "word",
        repoCommit: null,
        repoContent: plan.word,
        baseContent: plan.base,
      });
    } else if (normalizeDoc(plan.content) !== normalizeDoc(doc.content)) {
      const saved = await saveDoc(
        tx,
        principal,
        {
          key,
          title: doc.title,
          content: plan.content,
          baseVersion: doc.version,
          // File có bí mật chỉ tới được bước này khi người nhập đã xác nhận (commit.ts).
          acknowledgeSecrets: file.state === "blocked_secret",
        },
        { source: "word" },
      );
      docVersion = saved.version;
      await attachImages(tx, home, images(plan.used), docId, key);
      await markOrphanAssets(tx, home.id);
      await queueHomePush(tx, deps.jobs, home);
    }
    await recordAudit(tx, {
      action: "docs.word_update",
      targetType: "doc",
      targetId: docId,
      data: {
        importId: target.imp.id,
        fileId: file.id,
        docKey: key,
        sha256: file.sha256,
        conflicts: plan.conflicts,
        version: docVersion,
      },
    });
    await tx
      .update(docWordImportFiles)
      .set({
        state: "done",
        error: null,
        findings: [],
        linkMatches: plan.conflicts === 0,
        docId,
        docVersion,
        updatedAt: new Date(),
      })
      .where(eq(docWordImportFiles.id, file.id));
    await tx.execute(sql`release savepoint word_update_file`);
  } catch (error) {
    await tx.execute(sql`rollback to savepoint word_update_file`);
    if (error instanceof FileFailure)
      await tx
        .update(docWordImportFiles)
        .set({ error: error.error, updatedAt: new Date() })
        .where(eq(docWordImportFiles.id, file.id));
    else if (error instanceof DocSecretError)
      await tx
        .update(docWordImportFiles)
        .set({
          state: "blocked_secret",
          error: null,
          findings: error.findings.map((f) => ({ kind: f.kind, line: f.line })),
          updatedAt: new Date(),
        })
        .where(eq(docWordImportFiles.id, file.id));
    else throw error;
  }
}
