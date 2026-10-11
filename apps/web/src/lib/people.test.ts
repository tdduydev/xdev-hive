import { describe, expect, it } from "vitest";
import { emailDomain, initials, matchesPerson } from "./people.ts";

describe("initials", () => {
  it.each([
    ["Trần Đức Duy", "TD"],
    ["Lê Hà", "LH"],
    ["  ngô   vy ", "NV"],
    ["Duy", "D"],
    ["Đặng", "Đ"],
  ])("%s → %s", (name, want) => expect(initials(name)).toBe(want));
  it("tên tổ hợp dấu (NFD) vẫn ra chữ có dấu", () => expect(initials("Ánh".normalize("NFD"))).toBe("Á"));
  it("không có tên thì dùng chữ đầu của email", () => expect(initials("", "duy@example.com")).toBe("D"));
  it("không có gì thì ?", () => expect(initials(" ")).toBe("?"));
});

describe("emailDomain", () => {
  it("lấy tên miền, chữ thường", () => expect(emailDomain(" Duy@example.com ")).toBe("example.com"));
  it("tên miền con", () => expect(emailDomain("a@mail.example.com.vn")).toBe("mail.example.com.vn"));
  it.each(["", "duy", "duy@", "@example.com", "duy@fpt", "duy@fpt.", "a b@example.com", "a@b@example.com"])(
    "%j không hợp lệ",
    (email) => expect(emailDomain(email)).toBeNull(),
  );
});

describe("matchesPerson", () => {
  const ha = { name: "Lê Hà", email: "ha.le@example.com" };
  it.each([
    ["", true],
    ["  ", true],
    ["ha", true],
    ["HÀ", true],
    ["le ha", true],
    ["example.com", true],
    ["minh", false],
  ])("%j → %s", (q, want) => expect(matchesPerson(ha, q)).toBe(want));
  it("đ khớp d", () => expect(matchesPerson({ name: "Trần Đức Duy", email: "duy@example.com" }, "duc")).toBe(true));
});
