import { describe, expect, it } from "vitest";
import type { DocSummary, SkillSummary } from "./knowledge.ts";
import { foldText, matchKnowledge } from "./knowledge-search.ts";

const scope = { level: "org" as const, teamId: null, projectId: null };
const by = { userId: "u1", runId: null };
const at = "2026-10-13T00:00:00.000Z";
const doc = (key: string, title: string): DocSummary => ({
  id: key,
  key,
  title,
  scope,
  version: 1,
  updatedAt: at,
  updatedBy: by,
});
const skill = (name: string, description: string): SkillSummary => ({
  id: name,
  name,
  description,
  scope,
  version: 1,
  updatedAt: at,
  updatedBy: by,
});

describe("matchKnowledge", () => {
  const docs = [doc("project/pay/prd-refund", "Hoàn tiền một phần"), doc("org/onboarding", "Nhập môn")];
  const skills = [skill("db-migration", "Đổi bảng bằng drizzle"), skill("release", "Phát hành bản desktop")];

  it("bỏ dấu và hoa thường, mọi từ phải khớp", () => {
    expect(foldText("Đổi BẢNG")).toBe("doi bang");
    const r = matchKnowledge("hoan tien", docs, skills);
    expect(r.docs.map((d) => d.key)).toEqual(["project/pay/prd-refund"]);
    expect(matchKnowledge("hoan onboarding", docs, skills).docs).toEqual([]);
  });

  it("khớp key, tên và mô tả skill", () => {
    expect(matchKnowledge("onboarding", docs, skills).docs).toHaveLength(1);
    expect(matchKnowledge("drizzle", docs, skills).skills.map((s) => s.name)).toEqual(["db-migration"]);
  });

  it("câu tìm rỗng thì không trả gì", () =>
    expect(matchKnowledge("  ", docs, skills)).toEqual({ docs: [], skills: [] }));
});
