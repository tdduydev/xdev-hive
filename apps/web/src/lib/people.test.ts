import { describe, expect, it } from "vitest";
import { emailDomain, initials } from "./people.ts";

describe("initials", () => {
  it.each([
    ["Trần Đức Duy", "TD"],
    ["Lê Hà", "LH"],
    ["  ngô   vy ", "NV"],
    ["Duy", "D"],
    ["Đặng", "Đ"],
  ])("%s → %s", (name, want) => expect(initials(name)).toBe(want));
  it("tên tổ hợp dấu (NFD) vẫn ra chữ có dấu", () => expect(initials("Ánh".normalize("NFD"))).toBe("Á"));
  it("không có tên thì dùng chữ đầu của email", () => expect(initials("", "duy@fpt.com")).toBe("D"));
  it("không có gì thì ?", () => expect(initials(" ")).toBe("?"));
});

describe("emailDomain", () => {
  it("lấy tên miền, chữ thường", () => expect(emailDomain(" Duy@FPT.com ")).toBe("fpt.com"));
  it("tên miền con", () => expect(emailDomain("a@mail.fpt.com.vn")).toBe("mail.fpt.com.vn"));
  it.each(["", "duy", "duy@", "@fpt.com", "duy@fpt", "duy@fpt.", "a b@fpt.com", "a@b@fpt.com"])(
    "%j không hợp lệ",
    (email) => expect(emailDomain(email)).toBeNull(),
  );
});
