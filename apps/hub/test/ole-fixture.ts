// Dựng file OLE (MS-CFB bản 3, sector 512 byte) đủ nhỏ để test, không cần file Word thật trong repo.

const SECTOR = 512;
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;

export interface OleNode {
  name: string;
  /** Có `children` là storage, không có là stream. */
  data?: Uint8Array;
  children?: OleNode[];
}

interface Flat {
  node: OleNode;
  type: number;
  child: number;
  right: number;
  start: number;
  size: number;
}

export function buildOle(nodes: OleNode[]): Buffer {
  const flat: Flat[] = [
    { node: { name: "Root Entry" }, type: 5, child: NOSTREAM, right: NOSTREAM, start: ENDOFCHAIN, size: 0 },
  ];
  const place = (children: OleNode[]): number => {
    const ids = children.map((node) => {
      flat.push({ node, type: node.children ? 1 : 2, child: NOSTREAM, right: NOSTREAM, start: ENDOFCHAIN, size: 0 });
      return flat.length - 1;
    });
    // Cây đỏ đen suy biến thành một chuỗi anh em bên phải: hợp lệ với bộ đọc, đơn giản cho test.
    ids.forEach((id, i) => {
      const entry = flat[id] as Flat;
      entry.right = ids[i + 1] ?? NOSTREAM;
      if (entry.node.children) entry.child = place(entry.node.children);
    });
    return ids[0] ?? NOSTREAM;
  };
  (flat[0] as Flat).child = place(nodes);

  const sectorsOf = (bytes: number) => Math.ceil(bytes / SECTOR);
  const dirSectors = sectorsOf(flat.length * 128);
  const streams = flat.filter((entry) => entry.type === 2);
  const other = dirSectors + streams.reduce((n, entry) => n + sectorsOf(entry.node.data?.length ?? 0), 0);
  let fatSectors = 1;
  while (fatSectors * (SECTOR / 4) < fatSectors + other) fatSectors++;
  if (fatSectors > 109) throw new Error("File OLE test cần DIFAT, chưa hỗ trợ.");

  const fat: number[] = Array.from({ length: fatSectors }, () => FATSECT);
  const chain = (count: number): number => {
    const first = fat.length;
    for (let i = 0; i < count; i++) fat.push(i === count - 1 ? ENDOFCHAIN : fat.length + 1);
    return count === 0 ? ENDOFCHAIN : first;
  };
  const dirStart = chain(dirSectors);
  const data: Buffer[] = [];
  for (const entry of streams) {
    const bytes = entry.node.data ?? new Uint8Array();
    entry.size = bytes.length;
    entry.start = chain(sectorsOf(bytes.length));
    const padded = Buffer.alloc(sectorsOf(bytes.length) * SECTOR);
    padded.set(bytes);
    data.push(padded);
  }

  const header = Buffer.alloc(SECTOR);
  Buffer.from("d0cf11e0a1b11ae1", "hex").copy(header, 0);
  header.writeUInt16LE(0x3e, 0x18);
  header.writeUInt16LE(3, 0x1a);
  header.writeUInt16LE(0xfffe, 0x1c);
  header.writeUInt16LE(9, 0x1e);
  header.writeUInt16LE(6, 0x20);
  header.writeUInt32LE(fatSectors, 0x2c);
  header.writeUInt32LE(dirStart, 0x30);
  header.writeUInt32LE(4096, 0x38);
  header.writeUInt32LE(ENDOFCHAIN, 0x3c);
  header.writeUInt32LE(ENDOFCHAIN, 0x44);
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i < fatSectors ? i : FREESECT, 0x4c + i * 4);

  const fatBytes = Buffer.alloc(fatSectors * SECTOR, 0xff);
  fat.forEach((next, i) => {
    fatBytes.writeUInt32LE(next, i * 4);
  });

  const dir = Buffer.alloc(dirSectors * SECTOR);
  flat.forEach((entry, i) => {
    const at = i * 128;
    const name = Buffer.from(`${entry.node.name}\0`, "utf16le");
    name.copy(dir, at);
    dir.writeUInt16LE(name.length, at + 64);
    dir[at + 66] = entry.type;
    dir[at + 67] = 1;
    dir.writeUInt32LE(NOSTREAM, at + 68);
    dir.writeUInt32LE(entry.right, at + 72);
    dir.writeUInt32LE(entry.child, at + 76);
    dir.writeUInt32LE(entry.start, at + 116);
    dir.writeUInt32LE(entry.size, at + 120);
  });
  return Buffer.concat([header, fatBytes, dir, ...data]);
}

/** Luồng `WordDocument` có FIB Word 97 (`wIdent` 0xA5EC), dài hơn ngưỡng mini stream. */
export function wordStream(options: { encrypted?: boolean; ident?: number } = {}): Buffer {
  const stream = Buffer.alloc(4608);
  stream.writeUInt16LE(options.ident ?? 0xa5ec, 0);
  stream.writeUInt16LE(0x00c1, 2);
  stream.writeUInt16LE(options.encrypted ? 0x0100 : 0, 0x0a);
  return stream;
}

/** File `.doc` tối thiểu như Word 97-2003 lưu: `WordDocument` và `1Table` ngay dưới gốc. */
export function oleDoc(options: { encrypted?: boolean } = {}): Buffer {
  return buildOle([
    { name: "WordDocument", data: wordStream(options) },
    { name: "1Table", data: Buffer.alloc(64) },
  ]);
}

/** docx có mật khẩu: Office bọc gói OOXML đã mã hoá trong OLE (MS-OFFCRYPTO). */
export function encryptedOoxml(): Buffer {
  return buildOle([
    { name: "EncryptionInfo", data: Buffer.alloc(200, 1) },
    { name: "EncryptedPackage", data: Buffer.alloc(1024, 2) },
  ]);
}
