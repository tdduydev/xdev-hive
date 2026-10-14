import { describe, expect, it } from "vitest";
import {
  classifyRepoFile,
  commonDir,
  contentHash,
  copyHeader,
  readmeIndex,
  retryDelayMs,
  stripCopyHeader,
  syncBranch,
  syncCommitMessage,
  syncRef,
  withCopyHeader,
} from "./sync.ts";

describe("nhánh và tham chiếu", () => {
  it("dự án chính dùng <NNN>, repo khác thêm key dự án chính", () => {
    expect(syncRef({ number: 12, homeKey: "pay", isHome: true })).toBe("012");
    expect(syncRef({ number: 12, homeKey: "pay", isHome: false })).toBe("pay-012");
    expect(syncBranch({ number: 12, slug: "hoan-tien", homeKey: "pay", isHome: true })).toBe("hive/sdlc/012-hoan-tien");
    expect(syncBranch({ number: 12, slug: "hoan-tien", homeKey: "pay", isHome: false })).toBe(
      "hive/sdlc/pay-012-hoan-tien",
    );
  });
});

describe("bản sao contract", () => {
  it("dòng đầu theo cú pháp comment của định dạng; JSON không có comment", () => {
    expect(copyHeader("openapi", "payment-api")).toBe("# Bản sao do xDev Hive đồng bộ từ payment-api; sửa trên hub.");
    expect(copyHeader("proto", "p")).toMatch(/^\/\/ /);
    expect(copyHeader("markdown", "p")).toMatch(/^<!-- .* -->$/);
    expect(copyHeader("jsonschema", "p")).toBeNull();
    expect(withCopyHeader("{}\n", "jsonschema", "p")).toBe("{}\n");
  });

  it("bỏ dòng đầu của hub khi đọc lại, giữ nguyên khi người sửa đã xoá nó", () => {
    const body = "openapi: 3.1.0\n";
    expect(stripCopyHeader(withCopyHeader(body, "openapi", "pay"))).toBe(body);
    expect(stripCopyHeader(body)).toBe(body);
  });
});

describe("so hash file trong repo", () => {
  const baseline = "# Spec\n";
  const row = {
    kind: "source" as const,
    repoHash: null,
    syncedHash: contentHash(baseline),
    baselineHash: contentHash(baseline),
  };

  it("chưa từng thấy file thì là PR chưa merge; đã thấy rồi mất là bị xoá", () => {
    expect(classifyRepoFile(row, null).state).toBe("unseen");
    expect(classifyRepoFile({ ...row, repoHash: "x" }, null).state).toBe("deleted");
  });

  it("giống bản hub đã ghi hoặc baseline thì không đề xuất (chặn vòng lặp hub → repo → hub)", () => {
    expect(classifyRepoFile(row, baseline).state).toBe("match");
    expect(classifyRepoFile({ ...row, repoHash: contentHash(baseline) }, baseline).state).toBe("unchanged");
  });

  it("sửa một dòng là đổi; đọc lại cùng nội dung không đề xuất lần hai", () => {
    const edited = "# Spec\nThêm một dòng.\n";
    expect(classifyRepoFile(row, edited)).toMatchObject({ state: "changed", content: edited });
    expect(classifyRepoFile({ ...row, repoHash: contentHash(edited) }, edited).state).toBe("unchanged");
  });

  it("bản sao: so phần sau dòng đầu với baseline của contract nguồn", () => {
    const body = "openapi: 3.1.0\n";
    const copy = { kind: "copy" as const, repoHash: null, syncedHash: null, baselineHash: contentHash(body) };
    expect(classifyRepoFile(copy, withCopyHeader(body, "openapi", "pay")).state).toBe("match");
    const edited = withCopyHeader("openapi: 3.1.1\n", "openapi", "pay");
    expect(classifyRepoFile(copy, edited)).toMatchObject({ state: "changed", content: "openapi: 3.1.1\n" });
  });
});

describe("commit và README", () => {
  it("commit có trailer hạng mục và Co-authored-by không trùng", () => {
    const msg = syncCommitMessage({
      ref: "012",
      title: "Hoàn tiền",
      itemId: "item-1",
      docs: [
        { name: "Đặc tả", version: 2 },
        { name: "Kế hoạch", version: 1 },
      ],
      coAuthors: [
        { name: "An", email: "an@x.vn" },
        { name: "An", email: "AN@x.vn" },
        { name: "", email: "binh@x.vn" },
      ],
    });
    expect(msg.split("\n")).toEqual([
      "docs(sdlc): 012 Hoàn tiền — Đặc tả v2, Kế hoạch v1",
      "",
      "Hive-Sdlc-Item: item-1",
      "Co-authored-by: An <an@x.vn>",
      "Co-authored-by: binh@x.vn <binh@x.vn>",
    ]);
  });

  it("thư mục chung của file; file rải rác thì không có", () => {
    expect(commonDir(["specs/pay-012-a/plan-web.md", "specs/pay-012-a/contracts/x.yaml"])).toBe("specs/pay-012-a");
    expect(commonDir(["a/x.md", "b/y.md"])).toBeNull();
    expect(commonDir(["README.md"])).toBeNull();
  });

  it("README mục lục link tương đối tới file trong thư mục", () => {
    const text = readmeIndex({
      ref: "pay-012",
      title: "Hoàn tiền",
      homeKey: "pay",
      projectKey: "web",
      dir: "specs/pay-012-a",
      docs: [{ name: "Kế hoạch (web)", path: "specs/pay-012-a/plan-web.md", version: 3 }],
      link: "https://hive.x/sdlc/pay/012",
    });
    expect(text).toContain("- [Kế hoạch (web)](plan-web.md) — v3");
    expect(text).toContain("dự án chính pay");
    expect(text).toContain("https://hive.x/sdlc/pay/012");
  });
});

describe("lịch thử lại", () => {
  it("6 lần trong khoảng một giờ rồi dừng", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => (retryDelayMs(n) ?? 0) / 60_000)).toEqual([1, 2, 5, 10, 20, 30]);
    expect(retryDelayMs(7)).toBeNull();
  });
});
