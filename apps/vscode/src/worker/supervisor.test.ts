import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { type SupervisorOptions, WorkerSupervisor } from "@/worker/supervisor.ts";

const supervisors: WorkerSupervisor[] = [];
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((s) => s.dispose()));
  vi.useRealTimers();
});
function setup(overrides: Partial<SupervisorOptions> = {}) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn(() => {
    child.emit("exit", null, "SIGKILL");
    return true;
  });
  child.stdin.on("data", (data) => {
    if (data.toString() === "stop\n") queueMicrotask(() => child.emit("exit", 0));
  });
  const options: SupervisorOptions = {
    find: async () => ({ path: "/fake-worker", version: "0.2.16" }),
    status: async () => {
      throw Object.assign(new Error("chưa chạy"), { code: "ENOENT" });
    },
    registered: async () => true,
    autoStart: () => false,
    allowed: () => true,
    launch: vi.fn(() => child),
    ...overrides,
  };
  const supervisor = new WorkerSupervisor(options);
  supervisors.push(supervisor);
  return { supervisor, child, options };
}

it("binary thoát mã 4 chuyển sang External", async () => {
  const { supervisor } = setup({ launch: () => spawn(process.execPath, ["-e", "process.exit(4)"]) });
  await supervisor.start();
  await vi.waitFor(() => expect(supervisor.state).toBe("External"));
});
it("status-json đầu tiên xác lập Owned, stop đi qua stdin", async () => {
  const { supervisor, child } = setup();
  const stop = vi.spyOn(child.stdin, "end");
  await supervisor.start();
  child.stdout.emit("data", Buffer.from('{"status":"on'));
  child.stdout.emit("data", Buffer.from('line"}\n'));
  expect(supervisor.state).toBe("Owned");
  await supervisor.stop();
  expect(stop).toHaveBeenCalledWith("stop\n");
  expect(child.kill).not.toHaveBeenCalled();
  expect(supervisor.state).toBe("Idle");
});
it.each(["desktop", "vscode", "cli"] as const)("không stop worker bên ngoài có owner %s", async (owner) => {
  const { supervisor, child, options } = setup({
    status: async () => ({
      state: "online",
      hubConnected: true,
      registered: true,
      machineId: "m",
      version: "0.2.16",
      runs: 1,
      owner,
    }),
  });
  const stop = vi.spyOn(child.stdin, "end");
  await supervisor.start();
  await supervisor.stop();
  await supervisor.dispose();
  expect(supervisor.state).toBe("External");
  expect(options.launch).not.toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();
  expect(child.kill).not.toHaveBeenCalled();
});
it("kill sau thời hạn khi child không đọc stop", async () => {
  vi.useFakeTimers();
  const { supervisor, child } = setup({ stopTimeoutMs: 100 });
  child.stdin.removeAllListeners("data");
  await supervisor.start();
  const stopping = supervisor.stop();
  await vi.advanceTimersByTimeAsync(100);
  await stopping;
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
});
it("không tự chạy khi chưa đăng ký, không tin cậy hoặc autoStart tắt", async () => {
  for (const override of [{ registered: async () => false }, { allowed: () => false }, { autoStart: () => false }]) {
    const { supervisor, options } = setup({ autoStart: () => true, ...override });
    await supervisor.probe();
    expect(options.launch).not.toHaveBeenCalled();
  }
});
it("chuyển External sang Owned sau khi mất socket và autoStart bật", async () => {
  const status = vi
    .fn()
    .mockResolvedValueOnce({ owner: "desktop" })
    .mockRejectedValue(Object.assign(new Error("chưa chạy"), { code: "ENOENT" }));
  const { supervisor, child } = setup({ status, autoStart: () => true });
  await supervisor.probe();
  expect(supervisor.state).toBe("External");
  await supervisor.probe();
  child.stdout.emit("data", Buffer.from('{"status":"online"}\n'));
  expect(supervisor.state).toBe("Owned");
});
it("dispose trong lúc dò không spawn muộn", async () => {
  let resolve!: () => void;
  const gate = new Promise<void>((r) => {
    resolve = r;
  });
  const { supervisor, options } = setup({
    find: async () => {
      await gate;
      return { path: "/fake", version: "0.2.16" };
    },
    autoStart: () => true,
  });
  const probing = supervisor.probe();
  await supervisor.dispose();
  resolve();
  await probing;
  expect(options.launch).not.toHaveBeenCalled();
});
it("chạy child thật, nhận status và dừng êm", async () => {
  const { supervisor } = setup({
    launch: () =>
      spawn(process.execPath, [
        "-e",
        'process.stdout.write(JSON.stringify({status:"online"})+"\\n"); process.stdin.on("data", d => { if(d.toString().trim()==="stop") process.exit(0); });',
      ]),
  });
  await supervisor.start();
  await vi.waitFor(() => expect(supervisor.state).toBe("Owned"));
  await supervisor.stop();
  expect(supervisor.state).toBe("Idle");
});
