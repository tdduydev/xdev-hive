import { describe, expect, it } from "vitest";
import { type DedupeCorpus, duplicateReason, findDuplicate, jaccard, tokens } from "./dedupe.ts";

const empty: DedupeCorpus = { skills: [], packNames: [], memories: [], rejected: [], pending: [] };

describe("tách từ và so tập từ", () => {
  it("bỏ dấu câu và từ dưới 3 ký tự, giữ chữ có dấu tiếng Việt", () => {
    expect([...tokens("Làm tròn, tiền-tệ: là gì?")].sort()).toEqual(["làm", "tiền", "tròn"].sort());
  });

  it("jaccard của hai tập rỗng là 0, giống nhau là 1", () => {
    expect(jaccard(new Set(), new Set(["abc"]))).toBe(0);
    expect(jaccard(new Set(["abc", "def"]), new Set(["abc", "def"]))).toBe(1);
  });
});

describe("findDuplicate", () => {
  const candidate = { name: "lam-tron-tien", description: "Làm tròn tiền theo đơn vị nhỏ nhất của loại tiền" };

  it("cùng tên không phân biệt hoa thường", () => {
    const hit = findDuplicate(candidate, { ...empty, skills: [{ name: "Lam-Tron-Tien", description: "khác hẳn" }] });
    expect(hit).toMatchObject({ kind: "skill", score: 1 });
  });

  it("tên khác nhưng mô tả gần giống thì trùng", () => {
    const hit = findDuplicate(candidate, {
      ...empty,
      skills: [{ name: "tien-te", description: "Làm tròn tiền theo đơn vị nhỏ nhất của loại tiền tệ" }],
    });
    expect(hit?.kind).toBe("skill");
    expect(hit && duplicateReason(hit)).toBe("đã có skill tien-te");
  });

  it("skill khác chủ đề thì không trùng", () => {
    expect(
      findDuplicate(candidate, {
        ...empty,
        skills: [{ name: "review-code", description: "Đọc diff kỹ trước khi duyệt" }],
      }),
    ).toBeNull();
  });

  it("trùng tên skill mặc định của Hive", () => {
    expect(findDuplicate(candidate, { ...empty, packNames: ["lam-tron-tien"] })).toMatchObject({ kind: "pack" });
  });

  it("mô tả nằm gọn trong một memory thì coi như đã có", () => {
    const hit = findDuplicate(
      { name: "migrate", description: "Luôn chạy db:generate rồi commit file SQL trong thư mục migrations" },
      {
        ...empty,
        memories: [
          {
            id: "m1",
            content: "Khi đổi bảng luôn chạy db:generate rồi commit file SQL trong thư mục migrations của hub.",
          },
        ],
      },
    );
    expect(hit).toMatchObject({ kind: "memory", ref: "m1" });
  });

  it("mô tả quá ngắn không kết luận trùng memory", () => {
    expect(
      findDuplicate({ name: "ab", description: "cd" }, { ...empty, memories: [{ id: "m", content: "ab cd ab cd" }] }),
    ).toBeNull();
  });

  it("đề xuất đã bị từ chối hoặc đang chờ thì trùng; sửa skill vẫn bị chặn bởi đề xuất bị từ chối", () => {
    const rejected = [{ name: "lam-tron-so-tien", description: "Làm tròn tiền theo đơn vị nhỏ nhất của loại tiền tệ" }];
    expect(findDuplicate(candidate, { ...empty, rejected })).toMatchObject({ kind: "rejected" });
    expect(findDuplicate(candidate, { ...empty, pending: rejected })).toMatchObject({ kind: "pending" });
    expect(findDuplicate(candidate, { ...empty, rejected }, { skipExisting: true })).toMatchObject({
      kind: "rejected",
    });
  });

  it("đề xuất sửa bỏ qua skill đã có (nó vốn sửa skill đó)", () => {
    const skills = [{ name: "lam-tron-tien", description: "Làm tròn tiền" }];
    expect(findDuplicate(candidate, { ...empty, skills }, { skipExisting: true })).toBeNull();
  });
});
