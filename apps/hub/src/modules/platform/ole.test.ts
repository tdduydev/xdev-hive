import { describe, expect, it } from "vitest";
import { buildOle, encryptedOoxml, oleDoc, wordStream } from "../../../test/ole-fixture.ts";
import { oleKind } from "./ole.ts";

const kind = (data: Uint8Array) =>
  oleKind({
    size: data.length,
    read: async (offset, length) => {
      if (offset < 0 || offset + length > data.length) throw new Error("Đọc vượt file.");
      return data.subarray(offset, offset + length);
    },
  });

// Mục thư mục thứ i nằm ở sector 1 (sau sector FAT) của file dựng bằng buildOle.
const dirEntry = (i: number) => 512 * 2 + i * 128;

describe("đọc thư mục OLE", () => {
  it("nhận .doc qua luồng WordDocument và FIB", async () => {
    expect(await kind(oleDoc())).toBe("doc");
    expect(await kind(buildOle([{ name: "WordDocument", data: wordStream({ ident: 0xa5dc }) }]))).toBe("doc");
  });

  it("nhận file có mật khẩu: EncryptedPackage hoặc cờ fEncrypted của Word 97", async () => {
    expect(await kind(encryptedOoxml())).toBe("encrypted");
    expect(await kind(oleDoc({ encrypted: true }))).toBe("encrypted");
  });

  it("OLE khác không phải Word, kể cả khi WordDocument nằm trong storage nhúng", async () => {
    expect(await kind(buildOle([{ name: "Workbook", data: Buffer.alloc(4096) }]))).toBe("other");
    const embedded = buildOle([
      { name: "PowerPoint Document", data: Buffer.alloc(600) },
      { name: "MBD0001", children: [{ name: "WordDocument", data: wordStream() }] },
    ]);
    expect(await kind(embedded)).toBe("other");
  });

  it("OLE hỏng thì không phải Word", async () => {
    expect(await kind(Buffer.alloc(100))).toBe("corrupt");
    expect(await kind(oleDoc().subarray(0, 512))).toBe("corrupt");

    const badIdent = buildOle([{ name: "WordDocument", data: wordStream({ ident: 0x1234 }) }]);
    expect(await kind(badIdent)).toBe("corrupt");
    const tiny = buildOle([{ name: "WordDocument", data: Buffer.alloc(100) }]);
    expect(await kind(tiny)).toBe("corrupt");

    const longName = Buffer.from(oleDoc());
    longName.writeUInt16LE(66, dirEntry(1) + 64);
    expect(await kind(longName)).toBe("corrupt");

    // Mục anh em trỏ về chính nó: cây thư mục có vòng.
    const loop = Buffer.from(oleDoc());
    loop.writeUInt32LE(1, dirEntry(1) + 72);
    expect(await kind(loop)).toBe("corrupt");

    // Chuỗi FAT của thư mục trỏ về chính nó.
    const fatLoop = Buffer.from(oleDoc());
    fatLoop.writeUInt32LE(1, 512 + 4);
    expect(await kind(fatLoop)).toBe("corrupt");

    const outside = Buffer.from(oleDoc());
    outside.writeUInt32LE(9999, dirEntry(1) + 116);
    expect(await kind(outside)).toBe("corrupt");

    const badShift = Buffer.from(oleDoc());
    badShift.writeUInt16LE(12, 0x1e);
    expect(await kind(badShift)).toBe("corrupt");

    const hugeFat = Buffer.from(oleDoc());
    hugeFat.writeUInt32LE(0xffffff, 0x2c);
    expect(await kind(hugeFat)).toBe("corrupt");
  });

  it("chặn chuỗi thư mục dài quá giới hạn", async () => {
    const streams = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `S${i}`, data: new Uint8Array() }));
    expect(await kind(buildOle(streams(1000)))).toBe("other");
    const many = buildOle(streams(1100));
    expect(await kind(many)).toBe("corrupt");
  });
});
