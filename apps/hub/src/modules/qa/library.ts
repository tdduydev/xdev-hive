import { createHash } from "node:crypto";
import {
  capParseErrors,
  normalizeTestCase,
  type ParsedAreaCase,
  parseTestArea,
  type TestParseError,
} from "@xdev-hive/contracts";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Tx } from "../platform/index.ts";
import { qaAreas, qaCases, qaCaseVersions } from "./schema.ts";
import { addCaseStatusRows } from "./status.ts";

// Áp dụng file khu vào thư viện (T021, data-model "qa_cases"). Chạy trong tx lưu tài liệu, nên file lỗi không bao giờ
// để lại thư viện nửa cũ nửa mới. Chỉ throw khi lỗi DB: lỗi nội dung được ghi vào `parse_errors` để người sửa thấy.

export interface AreaFile {
  projectId: string;
  docId: string;
  docKey: string;
  docVersion: number;
  content: string;
}

export type ApplyAreaResult =
  | { status: "applied"; areaId: string }
  /** `areaId` null khi file chưa có khu nào để ghi lỗi: khu mới mà dòng `#` sai hoặc mã khu đã có chủ. */
  | { status: "rejected"; areaId: string | null; errors: TestParseError[] };

type AreaRow = typeof qaAreas.$inferSelect;

function inserted(rows: Array<{ id: string }>): string {
  const [row] = rows;
  if (!row) throw new Error("Không ghi được thư viện test case.");
  return row.id;
}

/** Băm phiên bản (FR-007): cùng nội dung chuẩn hoá thì cùng hash dù đổi thứ tự trong file. */
export const testCaseHash = (c: ParsedAreaCase): string =>
  createHash("sha256")
    .update(JSON.stringify(normalizeTestCase(c)))
    .digest("hex");

export async function applyAreaFile(tx: Tx, file: AreaFile): Promise<ApplyAreaResult> {
  const parsed = parseTestArea(file.content);
  const [own] = await tx.select().from(qaAreas).where(eq(qaAreas.docId, file.docId));
  const header = parsed.area;
  const errors = [...parsed.errors];

  // Khu đang giữ mã ở dòng `#`. Khu không còn tài liệu (tài liệu bị xoá) thì file mới nhận lại, cùng TC cũ.
  let holder: AreaRow | undefined = own?.code === header?.code ? own : undefined;
  let codeTaken = false;
  if (header && !holder) {
    [holder] = await tx
      .select()
      .from(qaAreas)
      .where(and(eq(qaAreas.projectId, file.projectId), eq(qaAreas.code, header.code)));
    if (holder?.docId) {
      errors.push({
        line: header.line,
        message: `Mã khu \`${header.code}\` đã dùng ở \`${holder.docKey}\`. Chọn mã khu khác.`,
      });
      holder = undefined;
      codeTaken = true;
    }
  }

  const existing =
    parsed.cases.length && !codeTaken
      ? await tx
          .select()
          .from(qaCases)
          .where(
            and(
              eq(qaCases.projectId, file.projectId),
              inArray(
                qaCases.code,
                parsed.cases.map((c) => c.code),
              ),
            ),
          )
      : [];
  const byCode = new Map(existing.map((c) => [c.code, c]));
  // Mã TC không bao giờ chuyển khu (FR-006): khu mới thì mọi mã đã có đều thuộc khu khác.
  for (const c of parsed.cases) {
    const old = byCode.get(c.code);
    if (!old || old.areaId === holder?.id) continue;
    errors.push({
      line: c.line,
      message:
        old.state === "active"
          ? `Dòng ${c.line}: mã \`${c.code}\` đã có ở khu khác.`
          : `Dòng ${c.line}: mã \`${c.code}\` đã dùng trước đây, chọn số khác.`,
    });
  }

  if (errors.length || !header)
    return reject(tx, file, { own, holder, create: codeTaken ? null : header }, capParseErrors(errors));

  // Đổi mã khu là khu mới: khu cũ thành lưu trữ, nhả tài liệu cho khu mới.
  if (own && own.id !== holder?.id) await archiveArea(tx, own.id, { releaseDoc: true });

  const applied = {
    name: header.name,
    docId: file.docId,
    docKey: file.docKey,
    parsedVersion: file.docVersion,
    parseErrors: [],
    errorsVersion: null,
    archivedAt: null,
    updatedAt: sql`now()`,
  };
  let areaId: string;
  if (holder) {
    areaId = holder.id;
    await tx.update(qaAreas).set(applied).where(eq(qaAreas.id, areaId));
  } else
    areaId = inserted(
      await tx
        .insert(qaAreas)
        .values({ ...applied, orgId: sql`hive.ctx_org()`, projectId: file.projectId, code: header.code })
        .returning({ id: qaAreas.id }),
    );

  const added: Array<{ caseId: string; projectId: string; areaId: string }> = [];
  for (const c of parsed.cases) {
    const content = normalizeTestCase(c);
    const hash = testCaseHash(c);
    const fields = { ...content, line: c.line, contentHash: hash, state: "active", retiredAt: null };
    const old = byCode.get(c.code);
    let caseId: string;
    let version: number;
    if (!old) {
      version = 1;
      caseId = inserted(
        await tx
          .insert(qaCases)
          .values({ ...fields, orgId: sql`hive.ctx_org()`, projectId: file.projectId, areaId, code: c.code, version })
          .returning({ id: qaCases.id }),
      );
      added.push({ caseId, projectId: file.projectId, areaId });
    } else {
      caseId = old.id;
      version = old.contentHash === hash ? old.version : old.version + 1;
      await tx
        .update(qaCases)
        .set({ ...fields, version, updatedAt: sql`now()` })
        .where(eq(qaCases.id, old.id));
      if (version === old.version) continue;
    }
    await tx
      .insert(qaCaseVersions)
      .values({ caseId, version, orgId: sql`hive.ctx_org()`, content, docVersion: file.docVersion });
  }
  await retireCases(
    tx,
    areaId,
    parsed.cases.map((c) => c.code),
  );
  await addCaseStatusRows(tx, added);
  return { status: "applied", areaId };
}

// File lỗi giữ nguyên TC đang áp dụng (FR-004), chỉ ghi lỗi để editor và danh sách khu hiện ra.
async function reject(
  tx: Tx,
  file: AreaFile,
  {
    own,
    holder,
    create,
  }: { own: AreaRow | undefined; holder: AreaRow | undefined; create: { code: string; name: string } | null },
  errors: TestParseError[],
): Promise<ApplyAreaResult> {
  const failed = { docKey: file.docKey, parseErrors: errors, errorsVersion: file.docVersion, updatedAt: sql`now()` };
  if (own) {
    await tx.update(qaAreas).set(failed).where(eq(qaAreas.id, own.id));
    return { status: "rejected", areaId: own.id, errors };
  }
  if (holder) {
    await tx
      .update(qaAreas)
      .set({ ...failed, docId: file.docId })
      .where(eq(qaAreas.id, holder.id));
    return { status: "rejected", areaId: holder.id, errors };
  }
  if (!create) return { status: "rejected", areaId: null, errors };
  const areaId = inserted(
    await tx
      .insert(qaAreas)
      .values({
        ...failed,
        orgId: sql`hive.ctx_org()`,
        projectId: file.projectId,
        code: create.code,
        name: create.name,
        docId: file.docId,
      })
      .returning({ id: qaAreas.id }),
  );
  return { status: "rejected", areaId, errors };
}

async function retireCases(tx: Tx, areaId: string, keep: readonly string[]): Promise<void> {
  await tx
    .update(qaCases)
    .set({ state: "retired", retiredAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(qaCases.areaId, areaId),
        eq(qaCases.state, "active"),
        keep.length ? notInArray(qaCases.code, [...keep]) : undefined,
      ),
    );
}

async function archiveArea(tx: Tx, areaId: string, opts: { releaseDoc: boolean }): Promise<void> {
  await retireCases(tx, areaId, []);
  await tx
    .update(qaAreas)
    .set({ archivedAt: sql`now()`, updatedAt: sql`now()`, ...(opts.releaseDoc ? { docId: null } : {}) })
    .where(eq(qaAreas.id, areaId));
}

/** Tài liệu bị lưu trữ: mọi TC của khu ngừng dùng. Khôi phục thì gọi lại `applyAreaFile` với nội dung hiện tại. */
export async function archiveAreaDoc(tx: Tx, docId: string): Promise<void> {
  const [area] = await tx.select({ id: qaAreas.id }).from(qaAreas).where(eq(qaAreas.docId, docId));
  if (area) await archiveArea(tx, area.id, { releaseDoc: false });
}
