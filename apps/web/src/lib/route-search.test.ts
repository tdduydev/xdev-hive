import { describe, expect, it } from "vitest";
import {
  validateAuditSearch,
  validateMcpSearch,
  validateProposalsSearch,
  validateSkillSearch,
} from "@/lib/route-search.ts";

describe("route search", () => {
  it("returns an explicit undefined for an unknown tab so it overrides the raw value", () => {
    // Router gộp `{ ...thô, ...đã kiểm }`: thiếu khoá thì `tab=la` vẫn lọt tới trang.
    expect({ tab: "la", ...validateMcpSearch({ tab: "la" }) }).toEqual({ tab: undefined });
    expect(validateMcpSearch({ tab: "token" })).toEqual({ tab: "token" });
    expect(validateProposalsSearch({ tab: "tu-choi" })).toEqual({ tab: "tu-choi" });
    expect(validateSkillSearch({ tab: "phien-ban" }).tab).toBe("phien-ban");
    expect(validateSkillSearch({ tab: 1 }).tab).toBeUndefined();
  });

  it("keeps only valid audit filters and trims free text to the hub limit", () => {
    expect(
      validateAuditSearch({ range: 30, actorType: "run", source: "bogus", q: "x".repeat(250), action: "" }),
    ).toEqual({ range: 30, actorType: "run", q: "x".repeat(200) });
    expect(validateAuditSearch({ range: "7" })).toEqual({});
  });
});
