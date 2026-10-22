import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextProject } from "@/lib/context-sync.ts";
import {
  autoSyncActive,
  machineAutoSyncKeys,
  SCHEDULE_TICK_MS,
  setMachineAutoSync,
  syncHubContext,
  useHubContextSchedule,
} from "@/lib/hub-context.ts";
import { setLang } from "@/lib/i18n.ts";

const PROJECT_ID = "7f3c1b52-0a1e-4c0e-9d57-2f4c8f0b6a11";

// Mỗi test một khoá dự án: hẹn giờ nhớ lần thử gần nhất theo khoá trong cả tiến trình.
let seq = 0;
const project = (over: Partial<ContextProject> = {}): ContextProject => ({
  key: `p_${++seq}`,
  projectId: PROJECT_ID,
  folder: "/work/app",
  enabled: true,
  sourceTokens: 0,
  blockTokens: 0,
  targets: [],
  hub: null,
  autoSync: { enabled: false, minutes: 60, source: "machine" },
  ...over,
});

const memory = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "decision",
  status: "approved",
  content: `Nội dung ${id}`,
  files: [],
  scope: { type: "project", id: PROJECT_ID, name: "App" },
  author: { type: "user", id: "u1", name: "An" },
  createdAt: "2026-10-20T08:00:00.000Z",
  supersededBy: null,
  pinned: false,
  ...over,
});

type Call = { command: string; args: Record<string, unknown> };

interface Fake {
  /** Memory hub trả; hàm thì chạy mỗi lần gọi để giả lỗi mạng. */
  memories?: unknown[] | (() => unknown[]);
  /** Dự án sidecar trả sau `context_sync`; hàm thì nhận đối số để so khớp. */
  synced?: (args: Record<string, unknown>) => ContextProject;
  projects?: ContextProject[];
  failSync?: string;
  holdSync?: Promise<void>;
}

/** Lệnh Tauri giả: `hub_rpc` đóng gói như Rust, `context_*` như sidecar. */
function fakeTauri(fake: Fake) {
  const calls: Call[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T>(command: string, args: Record<string, unknown> = {}) => {
        calls.push({ command, args });
        if (command === "hub_rpc") {
          const memories = typeof fake.memories === "function" ? fake.memories() : (fake.memories ?? []);
          return { status: 200, contentType: "application/json", body: JSON.stringify({ json: memories }) } as T;
        }
        if (command === "context_status") return { projects: fake.projects ?? [] } as T;
        if (command === "context_sync") {
          await fake.holdSync;
          if (fake.failSync) throw fake.failSync;
          return (fake.synced?.(args) ?? project({ key: String(args.project) })) as T;
        }
        throw new Error(`Lệnh chưa giả: ${command}`);
      },
    },
  };
  return calls;
}

const syncs = (calls: Call[]) => calls.filter((c) => c.command === "context_sync");
const snapshotOf = (call: Call | undefined) =>
  call?.args.hub as { projectId: string; items: unknown[]; error?: string };

beforeEach(() => {
  setLang("vi");
  localStorage.clear();
});

afterEach(() => {
  delete window.__TAURI__;
  vi.useRealTimers();
});

describe("syncHubContext", () => {
  it("kéo memory đã duyệt của dự án bằng hub_rpc rồi đưa nguyên danh sách cho context_sync", async () => {
    const calls = fakeTauri({
      memories: [memory("m1", { pinned: true }), memory("m2", { supersededBy: "m3" })],
      synced: (args) =>
        project({
          key: String(args.project),
          hub: {
            syncedAt: "2026-10-21T09:00:00.000Z",
            items: 1,
            omitted: { budget: 2, secret: 1 },
            lastError: null,
          },
        }),
    });
    const p = project();
    const out = await syncHubContext(p);

    const rpc = calls.find((c) => c.command === "hub_rpc");
    const query = new URL(`http://hub.local${rpc?.args.path}`).searchParams.get("data");
    expect(String(rpc?.args.path)).toMatch(/^\/rpc\/memory\/list/);
    expect(JSON.parse(String(query ?? rpc?.args.body)).json).toMatchObject({
      project: PROJECT_ID,
      status: "approved",
      limit: 200,
    });
    expect(JSON.stringify(rpc?.args)).not.toContain("hive_pat_");

    const call = syncs(calls)[0];
    expect(call?.args.project).toBe(p.key);
    expect(snapshotOf(call).projectId).toBe(PROJECT_ID);
    expect(snapshotOf(call).items).toEqual([
      expect.objectContaining({ id: "m1", kind: "decision", pinned: true, content: "Nội dung m1", supersededBy: null }),
      expect.objectContaining({ id: "m2", pinned: false, supersededBy: "m3" }),
    ]);
    expect(snapshotOf(call).error).toBeUndefined();
    expect(out).toMatchObject({
      items: 1,
      omitted: { budget: 2, secret: 1 },
      syncedAt: "2026-10-21T09:00:00.000Z",
      error: null,
    });
  });

  it("hub lỗi hay mất mạng: vẫn gọi context_sync với lỗi để sidecar giữ bản cũ và ghi lỗi", async () => {
    const calls = fakeTauri({
      memories: () => {
        throw "Không kết nối được hub.";
      },
      synced: (args) =>
        project({
          key: String(args.project),
          hub: {
            syncedAt: "2026-10-20T09:00:00.000Z",
            items: 3,
            omitted: { budget: 0, secret: 0 },
            lastError: "Không kết nối được hub.",
          },
        }),
    });
    const out = await syncHubContext(project());
    expect(snapshotOf(syncs(calls)[0])).toEqual({ projectId: PROJECT_ID, items: [], error: expect.any(String) });
    expect(out.error).toBe("Không kết nối được hub.");
    expect(out.items).toBe(3);
    expect(out.project).not.toBeNull();
  });

  it("context_sync không chạy được thì trả lỗi, không ném", async () => {
    fakeTauri({ memories: [], failSync: "Bộ tối ưu đang chạy." });
    const out = await syncHubContext(project());
    expect(out).toMatchObject({ project: null, error: "Bộ tối ưu đang chạy." });
  });

  it("thư mục chưa gắn dự án hub: báo bằng chữ của app, không gọi hub", async () => {
    const calls = fakeTauri({});
    const out = await syncHubContext(project({ projectId: null }));
    expect(out.error).toMatch(/chưa gắn với dự án/);
    expect(calls).toHaveLength(0);
  });

  it("hai lần gọi cùng lúc cho một dự án dùng chung một lần chạy", async () => {
    let release = () => {};
    const calls = fakeTauri({ holdSync: new Promise<void>((resolve) => (release = resolve)) });
    const p = project();
    const first = syncHubContext(p);
    const second = syncHubContext(p);
    expect(second).toBe(first);
    release();
    await first;
    expect(syncs(calls)).toHaveLength(1);
    // Xong rồi thì lần sau chạy lại bình thường.
    await syncHubContext(p);
    expect(syncs(calls)).toHaveLength(2);
  });
});

describe("công tắc tự đồng bộ của máy", () => {
  it("nhớ theo khoá dự án và bỏ khi tắt", () => {
    expect(machineAutoSyncKeys()).toEqual([]);
    expect(setMachineAutoSync("a", true)).toEqual(["a"]);
    expect(setMachineAutoSync("b", true)).toEqual(["a", "b"]);
    expect(setMachineAutoSync("a", false)).toEqual(["b"]);
    expect(machineAutoSyncKeys()).toEqual(["b"]);
  });

  it("chính sách bật thì luôn bật; không thì theo công tắc của máy", () => {
    const policy = project({ autoSync: { enabled: true, minutes: 30, source: "policy" } });
    const machine = project();
    expect(autoSyncActive(policy, [])).toBe(true);
    expect(autoSyncActive(machine, [])).toBe(false);
    expect(autoSyncActive(machine, [machine.key])).toBe(true);
  });

  it("dữ liệu lưu hỏng thì coi như tắt", () => {
    localStorage.setItem("hive.context.autosync", "{không phải json");
    expect(machineAutoSyncKeys()).toEqual([]);
  });
});

describe("useHubContextSchedule", () => {
  const OLD = "2026-10-20T00:00:00.000Z";
  const stale = (over: Partial<ContextProject> = {}) =>
    project({
      hub: { syncedAt: OLD, items: 1, omitted: { budget: 0, secret: 0 }, lastError: null },
      ...over,
    });

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-10-21T00:00:00.000Z") });
  });

  it("đến hạn khi mở thì kéo ngay, rồi chỉ kéo lại sau đúng chu kỳ của dự án", async () => {
    const p = stale();
    setMachineAutoSync(p.key, true);
    const calls = fakeTauri({ projects: [p] });
    const onSynced = vi.fn();
    const view = renderHook(() => useHubContextSchedule(true, onSynced));

    await vi.advanceTimersByTimeAsync(0);
    expect(syncs(calls)).toHaveLength(1);
    expect(onSynced).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS * 30);
    expect(syncs(calls)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS * 30);
    expect(syncs(calls)).toHaveLength(2);
    view.unmount();
    await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS * 120);
    expect(syncs(calls)).toHaveLength(2);
  });

  it("app-shell và màn Memory cùng hẹn giờ thì chỉ kéo một lần, màn Memory vẫn nhận dự án mới", async () => {
    const p = stale();
    setMachineAutoSync(p.key, true);
    const calls = fakeTauri({ projects: [p] });
    const onSynced = vi.fn();
    renderHook(() => useHubContextSchedule(true));
    renderHook(() => useHubContextSchedule(true, onSynced));

    await vi.advanceTimersByTimeAsync(0);
    expect(syncs(calls)).toHaveLength(1);
    expect(onSynced).toHaveBeenCalledTimes(1);
  });

  it("lần đồng bộ gần đây chưa đến hạn thì không kéo", async () => {
    const p = stale({
      hub: { syncedAt: "2026-10-20T23:30:00.000Z", items: 1, omitted: { budget: 0, secret: 0 }, lastError: null },
    });
    setMachineAutoSync(p.key, true);
    const calls = fakeTauri({ projects: [p] });
    renderHook(() => useHubContextSchedule(true));
    await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS * 10);
    expect(syncs(calls)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS * 20);
    expect(syncs(calls)).toHaveLength(1);
  });

  it("hub lỗi mãi thì cũng chỉ thử lại theo chu kỳ, không dội mỗi phút", async () => {
    const p = stale();
    setMachineAutoSync(p.key, true);
    const calls = fakeTauri({
      projects: [p],
      memories: () => {
        throw "Mất mạng.";
      },
    });
    renderHook(() => useHubContextSchedule(true));
    await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS * 50);
    expect(syncs(calls)).toHaveLength(1);
  });

  it("chính sách bật thì tự kéo dù công tắc máy tắt, theo chu kỳ của chính sách", async () => {
    const p = stale({ autoSync: { enabled: true, minutes: 15, source: "policy" } });
    const calls = fakeTauri({ projects: [p] });
    renderHook(() => useHubContextSchedule(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(syncs(calls)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS * 15);
    expect(syncs(calls)).toHaveLength(2);
  });

  it("công tắc tắt, dự án tắt hay chưa gắn hub thì không kéo", async () => {
    const off = stale();
    const disabled = stale({ enabled: false });
    const unbound = stale({ projectId: null });
    for (const p of [disabled, unbound]) setMachineAutoSync(p.key, true);
    const calls = fakeTauri({ projects: [off, disabled, unbound] });
    renderHook(() => useHubContextSchedule(true));
    await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS * 90);
    expect(syncs(calls)).toHaveLength(0);
  });

  it("chưa đăng nhập hub thì không đọc trạng thái, không kéo", async () => {
    const p = stale();
    setMachineAutoSync(p.key, true);
    const calls = fakeTauri({ projects: [p] });
    renderHook(() => useHubContextSchedule(false));
    await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS * 90);
    expect(calls).toHaveLength(0);
  });

  it("đọc trạng thái lỗi thì bỏ qua lượt đó và hẹn lượt sau", async () => {
    const p = stale();
    setMachineAutoSync(p.key, true);
    const calls = fakeTauri({ projects: [p] });
    const real = window.__TAURI__?.core.invoke;
    let broken = true;
    window.__TAURI__ = {
      core: {
        invoke: async <T>(command: string, args?: Record<string, unknown>) => {
          if (command === "context_status" && broken) throw "Sidecar chưa sẵn sàng.";
          return (await real?.(command, args)) as T;
        },
      },
    };
    renderHook(() => useHubContextSchedule(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(syncs(calls)).toHaveLength(0);
    broken = false;
    await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS);
    expect(syncs(calls)).toHaveLength(1);
  });
});
