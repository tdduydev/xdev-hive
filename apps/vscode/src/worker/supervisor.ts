import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { log } from "@/lib/log.ts";
import type { Binary } from "@/worker/bin.ts";
import type { WorkerStatus } from "@/worker/ipc.ts";

export type State = "Probe" | "Missing" | "Idle" | "Starting" | "Owned" | "Stopping" | "External" | "Error";
export type SupervisorOptions = {
  find: () => Promise<Binary | undefined>;
  status: () => Promise<WorkerStatus>;
  registered: () => Promise<boolean>;
  autoStart: () => boolean;
  allowed: () => boolean;
  launch?: (path: string) => ChildProcessWithoutNullStreams;
  stopTimeoutMs?: number;
  startTimeoutMs?: number;
};

export class WorkerSupervisor extends EventEmitter {
  state: State = "Probe";
  status: WorkerStatus | undefined;
  binary: Binary | undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  private busy = false;
  private disposed = false;
  private paused = false;
  private interval: ReturnType<typeof setInterval> | undefined;
  private stopping: Promise<void> | undefined;

  private readonly options: SupervisorOptions;
  constructor(options: SupervisorOptions) {
    super();
    this.options = options;
  }

  private set(state: State): void {
    this.state = state;
    this.emit("change");
  }

  watch(): void {
    this.interval ??= setInterval(() => {
      void this.probe();
    }, 15_000);
    this.interval.unref();
    void this.probe();
  }

  async probe(): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true;
    try {
      if (this.child) {
        try {
          this.status = await this.options.status();
          if (!this.disposed) this.emit("change");
        } catch {
          /* Lỗi IPC không tước quyền sở hữu handle tiến trình. */
        }
        return;
      }
      this.binary = await this.options.find();
      if (this.disposed) return;
      try {
        this.status = await this.options.status();
        if (!this.disposed) this.set("External");
        return;
      } catch (error) {
        // Worker cũ vẫn giữ khoá: lỗi giao thức không có nghĩa là không có worker.
        if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          log(String(error));
          this.set("Error");
          return;
        }
        this.status = undefined;
      }
      if (this.disposed) return;
      this.set(this.binary ? "Idle" : "Missing");
      if (
        this.binary &&
        !this.paused &&
        this.options.autoStart() &&
        this.options.allowed() &&
        (await this.options.registered())
      ) {
        if (!this.disposed && !this.paused && this.options.allowed()) this.launch();
      }
    } catch (error) {
      if (!this.disposed) this.set("Error");
      log(String(error));
    } finally {
      this.busy = false;
    }
  }

  async start(): Promise<void> {
    this.paused = false;
    await this.probe();
    if (this.state !== "Idle" || !this.binary || this.disposed || !this.options.allowed()) return;
    if (!(await this.options.registered())) throw new Error("Máy chưa đăng ký với Hive");
    if (!this.child && !this.disposed && !this.paused && this.options.allowed()) this.launch();
  }

  private launch(): void {
    if (!this.binary || this.child) return;
    this.set("Starting");
    const child = (
      this.options.launch ??
      ((path) =>
        spawn(path, ["run", "--owner", "vscode", "--status-json", "--stdin-control"], {
          shell: false,
          windowsHide: true,
        }))
    )(this.binary.path);
    this.child = child;
    let buffer = "";
    let ready = false;
    const startup = setTimeout(() => {
      log("Worker không khởi động đúng hạn");
      void this.stop().then(() => {
        if (!this.disposed) this.set("Error");
      });
    }, this.options.startTimeoutMs ?? 30_000);
    child.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      if (buffer.length > 65536) {
        buffer = "";
        return;
      }
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const status = JSON.parse(line);
          if (!ready && typeof status.status === "string") {
            ready = true;
            clearTimeout(startup);
            if (this.state === "Starting") this.set("Owned");
          }
        } catch {
          /* stdout có thể lẫn dòng chữ của CLI cũ. */
        }
        end = buffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (data: Buffer) => log(data.toString()));
    child.stdin.on("error", () => {
      /* Worker có thể thoát trước khi đọc stop. */
    });
    child.once("error", (error) => {
      clearTimeout(startup);
      if (this.child === child) {
        this.child = undefined;
        this.set("Error");
      }
      log(String(error));
    });
    child.once("exit", (code) => {
      clearTimeout(startup);
      if (this.child !== child) return;
      this.child = undefined;
      const stopping = this.state === "Stopping";
      this.set(code === 4 ? "External" : stopping || code === 0 ? "Idle" : "Error");
    });
  }

  stop(): Promise<void> {
    this.paused = true;
    if (this.stopping) return this.stopping;
    const child = this.child;
    // Quyền sở hữu chỉ đến từ handle spawn của cửa sổ này, không đến từ owner trong IPC.
    if (!child) return Promise.resolve();
    this.set("Stopping");
    this.stopping = new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), this.options.stopTimeoutMs ?? 10_000);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      child.once("exit", done);
      child.once("close", done);
      child.stdin.end("stop\n");
    }).finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.interval);
    await this.stop();
    this.removeAllListeners();
  }
}
