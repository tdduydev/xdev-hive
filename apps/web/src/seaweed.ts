// The hub's doc files in SeaweedFS (roadmap 23c), next to it in deploy/compose.yaml and reached on the compose network
// only: the filer's HTTP API, PUT the bytes at a path, GET them back, DELETE. Each file is named by its SHA-256, under
// <prefix>/<first two hex digits>/<sha>, so writing it again is harmless and the same bytes are kept once.
import { SHA256_HEX, type BlobStore } from "@xdev-hive/core";

export interface SeaweedOptions {
  /** The filer, e.g. http://seaweedfs:8888 (HIVE_SEAWEEDFS_URL). */
  url: string;
  /** The folder in the filer (HIVE_SEAWEEDFS_PREFIX). */
  prefix?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export function seaweedStore({ url, prefix = "/xdev-hive/doc-files", timeoutMs = 30_000, fetch: send = fetch }: SeaweedOptions): BlobStore {
  const base = new URL(url);
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error(`HIVE_SEAWEEDFS_URL must be http(s):// (got ${url})`);
  const root = `${base.origin}${base.pathname.replace(/\/+$/, "")}/${prefix.replace(/^\/+|\/+$/g, "")}`;
  const at = (sha: string) => {
    if (!SHA256_HEX.test(sha)) throw new Error(`not a SHA-256: ${sha}`);
    return `${root}/${sha.slice(0, 2)}/${sha}`;
  };
  const fail = async (what: string, res: Response) => new Error(`${what} ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`.trim());
  const call = (method: string, sha: string, init: RequestInit = {}) => send(at(sha), { ...init, method, signal: AbortSignal.timeout(timeoutMs) });

  return {
    name: "seaweedfs",
    where: base.origin,
    async put(sha, bytes, type) {
      const res = await call("PUT", sha, { body: bytes, headers: { "content-type": type || "application/octet-stream" } });
      if (!res.ok) throw await fail("PUT", res);
      await res.arrayBuffer().catch(() => undefined);
    },
    async get(sha) {
      const res = await call("GET", sha);
      if (res.status === 404) return null;
      if (!res.ok) throw await fail("GET", res);
      return new Uint8Array(await res.arrayBuffer());
    },
    async remove(sha) {
      const res = await call("DELETE", sha);
      if (!res.ok && res.status !== 404) throw await fail("DELETE", res);
    },
  };
}

/** HIVE_SEAWEEDFS_URL (+ HIVE_SEAWEEDFS_PREFIX): the store, or null when doc files stay in the database. */
export function seaweedFromEnv(env: NodeJS.ProcessEnv): BlobStore | null {
  const url = env.HIVE_SEAWEEDFS_URL?.trim();
  if (!url) return null;
  return seaweedStore({ url, ...(env.HIVE_SEAWEEDFS_PREFIX ? { prefix: env.HIVE_SEAWEEDFS_PREFIX } : {}) });
}
