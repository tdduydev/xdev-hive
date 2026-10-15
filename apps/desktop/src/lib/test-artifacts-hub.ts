import type { Account } from "@/lib/account.ts";

export const HUB = "http://hub.test";

export const account: Account = {
  name: "An",
  email: "an@example.com",
  orgId: "0a0a0a0a-0000-4000-8000-000000000001",
  orgName: "Acme",
  orgRole: "member",
  teams: [{ id: "0a0a0a0a-0000-4000-8000-000000000002", name: "Core", role: "member" }],
};

type Reply = unknown | ((input: unknown) => unknown);

/**
 * Hub và Rust giả cho test màn Artifact và Leader: `hub_rpc` trả theo thủ tục trong đường dẫn, các lệnh
 * `artifact_cache_*` giữ bộ đệm trong bộ nhớ như Rust (T040). `up = false` là hub tắt: Rust báo lỗi chuỗi, không có
 * mã HTTP, đúng như khi mạng đứt.
 */
export function fakeArtifactsHub(replies: Record<string, Reply>) {
  const state = {
    up: true,
    /** Thủ tục đã gọi theo thứ tự, kèm input. */
    calls: [] as { path: string; input: unknown }[],
    cache: new Map<
      string,
      { id: string; version: number; detail: unknown; frames: Record<string, string>; savedAt: number }
    >(),
    replies,
  };
  const inputOf = (args: Record<string, unknown> | undefined): unknown => {
    try {
      if (typeof args?.body === "string" && args.body) return (JSON.parse(args.body) as { json?: unknown }).json;
      const data = new URL(`http://x${String(args?.path)}`).searchParams.get("data");
      return data ? (JSON.parse(data) as { json?: unknown }).json : undefined;
    } catch {
      return undefined;
    }
  };
  window.__TAURI__ = {
    core: {
      invoke: async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
        if (command === "account_status") return { hub: HUB, linked: true, account, error: null } as T;
        if (command === "artifact_cache_put") {
          const entry = args?.entry as {
            detail: { artifact: { id: string }; version: { version: number } };
            frame?: { theme: string; html: string };
          };
          const id = entry.detail.artifact.id;
          const version = entry.detail.version.version;
          const key = `${id}@${version}`;
          const old = state.cache.get(key);
          const frames = { ...old?.frames, ...(entry.frame ? { [entry.frame.theme]: entry.frame.html } : {}) };
          const saved = { id, version, detail: entry.detail, frames, savedAt: Date.parse("2026-10-14T04:00:00Z") };
          state.cache.set(key, saved);
          return {
            id,
            version,
            artifact: entry.detail.artifact,
            themes: Object.keys(frames),
            savedAt: saved.savedAt,
            sizeBytes: 1,
          } as T;
        }
        if (command === "artifact_cache_get") {
          const id = String(args?.id);
          const version = args?.version as number | null;
          const found = [...state.cache.values()]
            .filter((e) => e.id === id && (version === null || e.version === version))
            .sort((a, b) => b.version - a.version)[0];
          return (found ?? null) as T;
        }
        if (command === "artifact_cache_list")
          return [...state.cache.values()].map((e) => ({
            ...e,
            artifact: (e.detail as { artifact: unknown }).artifact,
            themes: Object.keys(e.frames),
            sizeBytes: 1,
          })) as T;
        if (command !== "hub_rpc") throw new Error(`lệnh chưa giả: ${command}`);
        if (!state.up) throw "Không kết nối được hub.";
        const path =
          String(args?.path)
            .replace(/^\/rpc\//, "")
            .split("?")[0] ?? "";
        const input = inputOf(args);
        state.calls.push({ path, input });
        const reply = state.replies[path];
        const body = typeof reply === "function" ? (reply as (i: unknown) => unknown)(input) : reply;
        return {
          status: body === undefined ? 404 : 200,
          contentType: "application/json",
          body: JSON.stringify(
            body === undefined
              ? { json: { defined: false, code: "NOT_FOUND", status: 404, message: "Không có." } }
              : { json: body },
          ),
        } as T;
      },
    },
  };
  return state;
}

export const ID_A = "00000000-0000-4000-8000-00000000000a";
export const ID_B = "00000000-0000-4000-8000-00000000000b";
export const THREAD = "00000000-0000-4000-8000-0000000000d1";
export const AT = "2026-10-14T03:42:00.000Z";

/** `ArtifactDetail` tối thiểu đủ cho `artifacts.get`. */
export function artifactDetail(
  over: {
    id?: string;
    title?: string;
    type?: "markdown" | "react" | "mermaid" | "html";
    content?: string;
    compileError?: string | null;
    owner?: boolean;
  } = {},
) {
  return {
    artifact: {
      id: over.id ?? ID_A,
      title: over.title ?? "Luồng hoàn tiền",
      type: over.type ?? "markdown",
      language: null,
      scope: "private",
      teamId: null,
      project: null,
      originProjectId: null,
      owner: { id: "u1", name: "An" },
      origin: "leader",
      latestVersion: 1,
      sizeBytes: 10,
      duplicatedFrom: null,
      deletedAt: null,
      createdAt: AT,
      updatedAt: AT,
    },
    version: {
      version: 1,
      sha256: "x",
      sizeBytes: 10,
      authorUser: null,
      authorRunId: null,
      origin: "leader",
      message: null,
      name: null,
      restoredFrom: null,
      hasCompileError: !!over.compileError,
      tombstonedAt: null,
      createdAt: AT,
      content: over.content ?? "# Tiêu đề",
      compileError: over.compileError ?? null,
    },
    access: { write: true, manage: over.owner ?? true, owner: over.owner ?? true },
  };
}

export const settings = {
  enabled: true,
  types: ["markdown", "react", "mermaid", "html"],
  scopes: ["private"],
  maxVersionBytes: 1_000_000,
  maxVersions: 200,
  publicLinks: { enabled: true, maxDays: 14 },
};
