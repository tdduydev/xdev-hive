import { DatabaseSync } from "node:sqlite";

export type LegacyRow = Record<string, unknown>;
export interface LegacySource {
  memories: LegacyRow[];
  docs: LegacyRow[];
  versions: LegacyRow[];
  assets: LegacyRow[];
  authorEmails: Map<string, string>;
}

/** Chỉ đọc các cột tri thức; không đọc blob, vector, mật khẩu hay bảng vận hành. */
export function readLegacySource(path: string): LegacySource {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("BEGIN");
    const read = (table: string, required: string[], optional: string[]) => {
      const columns = new Set(
        db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((r) => r.name),
      );
      if (required.some((c) => !columns.has(c))) throw new Error("SQLite thiếu cột tri thức bắt buộc.");
      const fields = [...required, ...optional.filter((c) => columns.has(c))];
      return db.prepare(`SELECT ${fields.join(", ")} FROM ${table}`).all() as LegacyRow[];
    };
    const memories = read(
      "memory",
      ["id", "project", "kind", "content", "author", "status", "created_at"],
      ["files", "superseded_by", "on_behalf"],
    );
    const docs = read(
      "docs",
      ["key", "scope", "project", "title", "content", "version", "updated_by", "updated_at"],
      ["removed_at", "folder", "parent", "paths"],
    );
    const versions = read("doc_versions", ["key", "version", "content", "author", "note", "created_at"], []);
    const assets = read(
      "doc_assets",
      ["id", "doc_key", "name", "type", "size", "uploaded_by", "created_at"],
      ["sha256", "stored"],
    );
    const authorEmails = new Map<string, string>();
    const userColumns = new Set(
      db
        .prepare("PRAGMA table_info(hub_users)")
        .all()
        .map((r) => r.name),
    );
    if (userColumns.has("username")) {
      const fields = ["username", ...["id", "email"].filter((c) => userColumns.has(c))];
      for (const row of db.prepare(`SELECT ${fields.join(", ")} FROM hub_users`).all()) {
        const email = String(row.email ?? row.username);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
        authorEmails.set(String(row.username), email);
        if (row.id != null) authorEmails.set(String(row.id), email);
      }
    }
    return { memories, docs, versions, assets, authorEmails };
  } finally {
    db.close();
  }
}
