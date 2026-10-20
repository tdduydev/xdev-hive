// Đọc thư mục của file OLE (MS-CFB) đủ để biết đó là Word 97-2003 hay file Office có mật khẩu. Dữ liệu do người dùng
// gửi nên mọi chuỗi sector và cây thư mục đều có giới hạn; gặp chỗ sai thì trả "corrupt" thay vì ném lỗi đọc.

export const OLE_SIGNATURE = Buffer.from("d0cf11e0a1b11ae1", "hex");

/** Thư mục Word thật chỉ vài sector; 256 đủ cho cả file có nhiều đối tượng nhúng mà vẫn chặn được chuỗi vòng. */
const MAX_DIR_SECTORS = 256;
/** Số mục thư mục tối đa được duyệt trong cây con của gốc. */
const MAX_ENTRIES = 4096;
const ENDOFCHAIN = 0xfffffffe;
const MAXREGSECT = 0xfffffffa;
const HEADER_DIFAT = 109;
const NOSTREAM = 0xffffffff;
// Word 97 trở đi và Word 6/95 (MS-DOC FibBase.wIdent).
const WORD_IDENTS = new Set([0xa5ec, 0xa5dc]);
const FIB_ENCRYPTED = 0x0100;

/** Giống `BlobReader` của magic.ts; khai báo lại để hai file không import vòng. */
interface OleReader {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export type OleKind = "doc" | "encrypted" | "other" | "corrupt";

class Corrupt extends Error {}

const fail = (): never => {
  throw new Corrupt();
};

export function isOle(prefix: Uint8Array): boolean {
  return prefix.length >= 8 && Buffer.from(prefix.buffer, prefix.byteOffset, 8).equals(OLE_SIGNATURE);
}

/**
 * - `encrypted`: có luồng `EncryptedPackage` (docx/xlsx/pptx có mật khẩu) hoặc Word 97 bật cờ `fEncrypted`;
 * - `doc`: có luồng `WordDocument` với FIB hợp lệ;
 * - `other`: OLE hợp lệ khác (xls, ppt, msg);
 * - `corrupt`: không phải OLE hoặc cấu trúc hỏng.
 */
export async function oleKind(reader: OleReader): Promise<OleKind> {
  try {
    return await readKind(reader);
  } catch (error) {
    if (error instanceof Corrupt) return "corrupt";
    throw error;
  }
}

async function readKind(reader: OleReader): Promise<OleKind> {
  if (reader.size < 512) return "corrupt";
  const header = Buffer.from(await reader.read(0, 512));
  if (header.length < 512 || !header.subarray(0, 8).equals(OLE_SIGNATURE)) return "corrupt";
  const major = header.readUInt16LE(0x1a);
  const shift = header.readUInt16LE(0x1e);
  if (!((major === 3 && shift === 9) || (major === 4 && shift === 12))) return "corrupt";
  const sectorSize = 1 << shift;
  const perFat = sectorSize / 4;
  const fatSectors = header.readUInt32LE(0x2c);
  const firstDir = header.readUInt32LE(0x30);
  const miniCutoff = header.readUInt32LE(0x38);
  const firstDifat = header.readUInt32LE(0x44);
  const difatSectors = header.readUInt32LE(0x48);
  const sectorCount = Math.ceil((reader.size - 512) / sectorSize);
  if (fatSectors > Math.ceil(sectorCount / perFat) + 1 || difatSectors > sectorCount) return "corrupt";

  const offsetOf = (sector: number): number => {
    if (sector > MAXREGSECT || sector >= sectorCount) fail();
    return (sector + 1) * sectorSize;
  };
  const read = async (offset: number, length: number): Promise<Buffer> => {
    if (offset + length > reader.size) fail();
    const bytes = Buffer.from(await reader.read(offset, length));
    if (bytes.length !== length) fail();
    return bytes;
  };

  // Chỉ đọc những sector DIFAT cần cho các mục FAT được hỏi tới, không nạp cả bảng FAT của file lớn.
  const difatChain: number[] = [];
  const fatSectorAt = async (index: number): Promise<number> => {
    if (index >= fatSectors) fail();
    if (index < HEADER_DIFAT) return header.readUInt32LE(0x4c + index * 4);
    const perDifat = perFat - 1;
    const page = Math.floor((index - HEADER_DIFAT) / perDifat);
    if (page >= difatSectors) fail();
    while (difatChain.length <= page) {
      const previous = difatChain.at(-1);
      const next =
        previous === undefined ? firstDifat : (await read(offsetOf(previous) + perDifat * 4, 4)).readUInt32LE(0);
      if (difatChain.includes(next)) fail();
      offsetOf(next);
      difatChain.push(next);
    }
    const sector = difatChain[page] ?? fail();
    return (await read(offsetOf(sector) + ((index - HEADER_DIFAT) % perDifat) * 4, 4)).readUInt32LE(0);
  };
  const nextSector = async (sector: number): Promise<number> => {
    const fat = await fatSectorAt(Math.floor(sector / perFat));
    return (await read(offsetOf(fat) + (sector % perFat) * 4, 4)).readUInt32LE(0);
  };

  const dirChain: number[] = [];
  const seen = new Set<number>();
  for (let sector = firstDir; sector !== ENDOFCHAIN; sector = await nextSector(sector)) {
    if (seen.has(sector) || dirChain.length >= MAX_DIR_SECTORS) fail();
    offsetOf(sector);
    seen.add(sector);
    dirChain.push(sector);
  }
  const perDir = sectorSize / 128;
  const entryAt = async (id: number) => {
    const sector = dirChain[Math.floor(id / perDir)] ?? fail();
    const entry = await read(offsetOf(sector) + (id % perDir) * 128, 128);
    const nameLength = entry.readUInt16LE(64);
    if (nameLength > 64 || nameLength % 2 !== 0) fail();
    return {
      name: entry.toString("utf16le", 0, Math.max(0, nameLength - 2)),
      type: entry[66],
      left: entry.readUInt32LE(68),
      right: entry.readUInt32LE(72),
      child: entry.readUInt32LE(76),
      start: entry.readUInt32LE(116),
      size: entry.readUInt32LE(120),
    };
  };

  const root = await entryAt(0);
  if (root.type !== 5) return "corrupt";
  // Chỉ xét luồng nằm ngay dưới gốc: file Excel nhúng trong slide cũng có `WordDocument`, nhưng ở trong một storage con.
  const streams = new Map<string, Awaited<ReturnType<typeof entryAt>>>();
  const visited = new Set<number>();
  const stack = root.child === NOSTREAM ? [] : [root.child];
  while (stack.length > 0) {
    const id = stack.pop() ?? fail();
    if (visited.has(id) || visited.size >= MAX_ENTRIES) fail();
    visited.add(id);
    const entry = await entryAt(id);
    if (entry.type === 2) streams.set(entry.name.toUpperCase(), entry);
    else if (entry.type !== 1) fail();
    for (const sibling of [entry.left, entry.right]) if (sibling !== NOSTREAM) stack.push(sibling);
  }

  if (streams.has("ENCRYPTEDPACKAGE")) return "encrypted";
  const word = streams.get("WORDDOCUMENT");
  if (!word) return "other";
  // FIB nằm đầu luồng. Luồng nhỏ hơn ngưỡng mini stream thì không thể chứa một tài liệu Word thật.
  if (word.size < Math.max(miniCutoff, 32)) return "corrupt";
  const fib = await read(offsetOf(word.start), 12);
  if (!WORD_IDENTS.has(fib.readUInt16LE(0))) return "corrupt";
  return fib.readUInt16LE(0x0a) & FIB_ENCRYPTED ? "encrypted" : "doc";
}
