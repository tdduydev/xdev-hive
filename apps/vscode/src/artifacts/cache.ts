import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CACHE_LIMIT = 200 * 1024 * 1024;
export const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

// Một hàng đợi giữ việc xoá khi đăng xuất đứng sau mọi lần ghi còn đang chạy.
export class ArtifactCache {
  private touched = 0;
  private queue: Promise<unknown> = Promise.resolve();
  readonly root: string;
  private readonly limit: number;
  constructor(root: string, limit = CACHE_LIMIT) {
    this.root = root;
    this.limit = limit;
  }

  private run<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action);
    this.queue = next.catch(() => {});
    return next;
  }

  get(key: string): Promise<string | null> {
    return this.run(async () => {
      const path = join(this.root, sha256(key));
      try {
        const entry = JSON.parse(await readFile(path, "utf8")) as { value: string; digest: string };
        if (typeof entry.value !== "string" || sha256(entry.value) !== entry.digest) return null;
        this.touched = Math.max(Date.now(), this.touched + 1);
        const now = new Date(this.touched);
        await utimes(path, now, now);
        return entry.value;
      } catch {
        return null;
      }
    });
  }

  put(key: string, value: string): Promise<void> {
    return this.run(async () => {
      const data = JSON.stringify({ value, digest: sha256(value) });
      if (Buffer.byteLength(data) > this.limit) return;
      await mkdir(this.root, { recursive: true });
      const path = join(this.root, sha256(key));
      await writeFile(path, data, { mode: 0o600 });
      this.touched = Math.max(Date.now(), this.touched + 1);
      const now = new Date(this.touched);
      await utimes(path, now, now);
      const files = await Promise.all(
        (await readdir(this.root)).map(async (name) => {
          const path = join(this.root, name);
          return { path, ...(await stat(path)) };
        }),
      );
      let total = files.reduce((sum, file) => sum + file.size, 0);
      for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
        if (total <= this.limit) break;
        await rm(file.path, { force: true });
        total -= file.size;
      }
    });
  }

  clear(): Promise<void> {
    return this.run(() => rm(this.root, { recursive: true, force: true }));
  }
}
