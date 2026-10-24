import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { createPool, type Tx, withTenant } from "../platform/index.ts";
import { type AreaFile, applyAreaFile, archiveAreaDoc } from "./library.ts";

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const app = createPool(db.appUrl);

let orgId: string;
let userId: string;
let projectId: string;
let docNo = 0;

const asOrg = <T>(run: (tx: Tx) => Promise<T>) => withTenant(app, { orgId, userId }, run);

async function newDoc(): Promise<{ docId: string; docKey: string }> {
  const docId = randomUUID();
  docNo += 1;
  const docKey = `org/test-cases/khu-${docNo}`;
  await admin.query(
    "insert into hive.docs (id, org_id, key, title, current_version, updated_by_user_id) values ($1, $2, $3, 'Khu', 1, $4)",
    [docId, orgId, docKey, userId],
  );
  return { docId, docKey };
}

const tc = (code: string, name = `Ca ${code}`, extra = "") => `### ${code} ${name}

- Ưu tiên: P1
- Loại: tay
- Yêu cầu: FR-001${extra}

| # | Thao tác | Kết quả mong đợi |
|---|---|---|
| 1 | Mở trang | Thấy trang |
`;
const area = (code: string, ...cases: string[]) => `# ${code} Khu ${code}\n\n${cases.join("\n")}`;

async function apply(doc: { docId: string; docKey: string }, content: string, docVersion = 1) {
  const file: AreaFile = { projectId, ...doc, docVersion, content };
  return asOrg((tx) => applyAreaFile(tx, file));
}

async function cases(areaCode: string) {
  const { rows } = await admin.query(
    `select c.code, c.name, c.state, c.version, c.labels, c.retired_at is not null as retired_at,
            (select count(*)::int from hive.qa_case_versions v where v.case_id = c.id) as versions,
            exists (select 1 from hive.qa_case_status s where s.case_id = c.id) as status_row
       from hive.qa_cases c join hive.qa_areas a on a.id = c.area_id
      where a.project_id = $1 and a.code = $2 order by c.code`,
    [projectId, areaCode],
  );
  return rows;
}

async function areaRow(code: string) {
  const { rows } = await admin.query(
    `select code, name, doc_id, doc_key, parsed_version, parse_errors, errors_version, archived_at is not null as archived
       from hive.qa_areas where project_id = $1 and code = $2`,
    [projectId, code],
  );
  return rows[0];
}

beforeAll(async () => {
  const org = await seedOrg(admin, `qa-library-${randomUUID().slice(0, 8)}`);
  orgId = org.orgId;
  userId = org.user("owner");
  const scm = randomUUID();
  await admin.query(
    "insert into hive.scm_connections (id, org_id, kind, name, secret_enc, created_by) values ($1, $2, 'gitlab', 'gl', 'fixture', $3)",
    [scm, orgId, userId],
  );
  projectId = (
    await admin.query(
      `insert into hive.projects (org_id, team_id, system_id, key, name, scm_connection_id, scm_kind, repo_mode,
         repo_owner, repo_name, settings, idempotency_key, created_by)
       values ($1, $2, $3, 'billing', 'billing', $4, 'gitlab', 'existing', 'xdev-team', 'billing', '{}', $5, $6)
       returning id`,
      [orgId, org.teamId, org.systemId, scm, randomUUID(), userId],
    )
  ).rows[0].id as string;
});

afterAll(async () => {
  await app.end();
  await admin.end();
});

describe("applyAreaFile", () => {
  it("thêm mã mới với phiên bản 1, hàng phiên bản và hàng trạng thái rỗng", async () => {
    const doc = await newDoc();
    const result = await apply(doc, area("MOI", tc("TC-MOI-001"), tc("TC-MOI-002")));
    expect(result.status).toBe("applied");
    expect(await areaRow("MOI")).toMatchObject({
      name: "Khu MOI",
      doc_id: doc.docId,
      parsed_version: 1,
      parse_errors: [],
      archived: false,
    });
    expect(await cases("MOI")).toEqual([
      expect.objectContaining({ code: "TC-MOI-001", state: "active", version: 1, versions: 1, status_row: true }),
      expect.objectContaining({ code: "TC-MOI-002", state: "active", version: 1, versions: 1, status_row: true }),
    ]);
  });

  it("cùng khu: chỉ tăng phiên bản khi nội dung chuẩn hoá đổi", async () => {
    const doc = await newDoc();
    await apply(doc, area("SUA", tc("TC-SUA-001", "Tên cũ", "\n- Nhãn: b, a")));
    // Đổi thứ tự nhãn và thêm dòng trống không đổi nội dung.
    await apply(doc, area("SUA", `\n${tc("TC-SUA-001", "Tên cũ", "\n- Nhãn: a, b")}`), 2);
    expect(await cases("SUA")).toEqual([expect.objectContaining({ version: 1, versions: 1 })]);
    await apply(doc, area("SUA", tc("TC-SUA-001", "Tên mới", "\n- Nhãn: a, b")), 3);
    expect(await cases("SUA")).toEqual([
      expect.objectContaining({ name: "Tên mới", version: 2, versions: 2, labels: ["a", "b"] }),
    ]);
    expect((await areaRow("SUA")).parsed_version).toBe(3);
  });

  it("mã không còn trong file thì ngừng dùng, xuất hiện lại thì dùng tiếp", async () => {
    const doc = await newDoc();
    await apply(doc, area("NG", tc("TC-NG-001"), tc("TC-NG-002")));
    await apply(doc, area("NG", tc("TC-NG-001")), 2);
    expect((await cases("NG")).map((c) => [c.code, c.state, c.retired_at])).toEqual([
      ["TC-NG-001", "active", false],
      ["TC-NG-002", "retired", true],
    ]);
    await apply(doc, area("NG", tc("TC-NG-001"), tc("TC-NG-002")), 3);
    expect(await cases("NG")).toEqual([
      expect.objectContaining({ code: "TC-NG-001", state: "active", version: 1 }),
      expect.objectContaining({ code: "TC-NG-002", state: "active", version: 1, retired_at: false }),
    ]);
  });

  it("file lỗi giữ TC đang áp dụng, chỉ ghi lỗi; lưu đúng thì xoá lỗi", async () => {
    const doc = await newDoc();
    await apply(doc, area("LOI", tc("TC-LOI-001")));
    const bad = area("LOI", tc("TC-LOI-001", "Tên đổi"), "### TC-LOI-002 Thiếu bảng\n\n- Ưu tiên: P1\n");
    const result = await apply(doc, bad, 2);
    expect(result).toMatchObject({ status: "rejected" });
    expect(await cases("LOI")).toEqual([expect.objectContaining({ name: "Ca TC-LOI-001", version: 1 })]);
    const row = await areaRow("LOI");
    expect(row).toMatchObject({ parsed_version: 1, errors_version: 2 });
    expect(row.parse_errors.length).toBeGreaterThan(0);
    await apply(doc, area("LOI", tc("TC-LOI-001")), 3);
    expect(await areaRow("LOI")).toMatchObject({ parsed_version: 3, parse_errors: [], errors_version: null });
  });

  it("file mới có lỗi vẫn tạo khu để hiện lỗi", async () => {
    const doc = await newDoc();
    const result = await apply(doc, area("MOILOI", "### TC-MOILOI-001 Thiếu bảng\n\n- Ưu tiên: P1\n"));
    expect(result).toMatchObject({ status: "rejected", areaId: expect.any(String) });
    expect(await areaRow("MOILOI")).toMatchObject({ doc_id: doc.docId, parsed_version: null, errors_version: 1 });
    expect(await cases("MOILOI")).toEqual([]);
  });

  it("mã khu đã có ở file khác: từ chối và chỉ ra file đang giữ", async () => {
    const first = await newDoc();
    await apply(first, area("TRUNG", tc("TC-TRUNG-001")));
    const second = await newDoc();
    const result = await apply(second, area("TRUNG", tc("TC-TRUNG-002")));
    expect(result).toEqual({
      status: "rejected",
      areaId: null,
      errors: [{ line: 1, message: `Mã khu \`TRUNG\` đã dùng ở \`${first.docKey}\`. Chọn mã khu khác.` }],
    });
    expect((await cases("TRUNG")).map((c) => c.code)).toEqual(["TC-TRUNG-001"]);
  });

  it("đổi mã khu: khu cũ lưu trữ, TC cũ ngừng dùng, khu mới nhận tài liệu", async () => {
    const doc = await newDoc();
    await apply(doc, area("CU", tc("TC-CU-001")));
    await apply(doc, area("MOIDOI", tc("TC-MOIDOI-001")), 2);
    expect(await areaRow("CU")).toMatchObject({ doc_id: null, archived: true });
    expect(await cases("CU")).toEqual([expect.objectContaining({ state: "retired" })]);
    expect(await areaRow("MOIDOI")).toMatchObject({ doc_id: doc.docId, archived: false });
    // Mã cũ đã ngừng ở khu khác: dùng lại trong file mới bị từ chối (quy tắc 4), không phải "đã có" (quy tắc 3).
    const back = await apply(doc, area("MOIDOI", tc("TC-MOIDOI-001"), tc("TC-CU-001")), 3);
    expect(back.status).toBe("rejected");
  });

  it("mã TC ở khu khác: đang dùng và đã ngừng có thông báo riêng", async () => {
    // Chỉ dựng được bằng tay: bộ đọc bắt mã phải cùng khu với file, và mã khu không đổi chủ khi còn tài liệu.
    const doc = await newDoc();
    await apply(doc, area("KHAC", tc("TC-KHAC-001"), tc("TC-KHAC-002")));
    await apply(doc, area("KHAC", tc("TC-KHAC-001")), 2);
    const other = await newDoc();
    await apply(other, area("KHAC2", tc("TC-KHAC2-001")));
    await admin.query(
      `update hive.qa_cases set area_id = (select id from hive.qa_areas where project_id = $1 and code = 'KHAC2')
        where project_id = $1 and code in ('TC-KHAC-001', 'TC-KHAC-002')`,
      [projectId],
    );
    const result = await apply(doc, area("KHAC", tc("TC-KHAC-001"), tc("TC-KHAC-002")), 3);
    expect(result).toMatchObject({
      status: "rejected",
      errors: [
        { line: 3, message: "Dòng 3: mã `TC-KHAC-001` đã có ở khu khác." },
        { line: 13, message: "Dòng 13: mã `TC-KHAC-002` đã dùng trước đây, chọn số khác." },
      ],
    });
  });

  it("tài liệu xoá rồi: file mới cùng mã khu nhận lại khu và TC cũ", async () => {
    const doc = await newDoc();
    await apply(doc, area("XOA", tc("TC-XOA-001")));
    await admin.query("delete from hive.docs where id = $1", [doc.docId]);
    const next = await newDoc();
    expect((await apply(next, area("XOA", tc("TC-XOA-001")))).status).toBe("applied");
    expect(await areaRow("XOA")).toMatchObject({ doc_id: next.docId, archived: false });
    expect(await cases("XOA")).toEqual([expect.objectContaining({ state: "active", version: 1 })]);
  });

  it("lưu trữ tài liệu ngừng mọi TC, khôi phục đọc lại file", async () => {
    const doc = await newDoc();
    const content = area("LT", tc("TC-LT-001"), tc("TC-LT-002"));
    await apply(doc, content);
    await asOrg((tx) => archiveAreaDoc(tx, doc.docId));
    expect(await areaRow("LT")).toMatchObject({ doc_id: doc.docId, archived: true });
    expect((await cases("LT")).map((c) => c.state)).toEqual(["retired", "retired"]);
    await apply(doc, content, 2);
    expect(await areaRow("LT")).toMatchObject({ archived: false });
    expect((await cases("LT")).map((c) => c.state)).toEqual(["active", "active"]);
  });
});
