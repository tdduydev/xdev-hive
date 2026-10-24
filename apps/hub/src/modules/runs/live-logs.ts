import { createRedactor, type Redactor, type RunLogChunk } from "@xdev-hive/contracts";

const TTL_MS = 5 * 60_000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_RUNS = 256;
const MAX_RUN_BYTES = 1024 * 1024;

interface LiveRun {
  attempt: number;
  seq: number;
  offset: number;
  touched: number;
  size: number;
  chunks: RunLogChunk[];
  redactor: Redactor;
  decoder: TextDecoder;
}

/** Chỉ ở RAM của tiến trình api để hive attach nối lại được trong thời gian ngắn; không chuyển output vào NOTIFY. */
export class LiveRunLogs {
  private readonly runs = new Map<string, LiveRun>();
  private id = Date.now() * 1000;

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  prune() {
    const now = this.now();
    for (const [id, run] of this.runs) if (now - run.touched >= TTL_MS) this.runs.delete(id);
    let bytes = [...this.runs.values()].reduce((n, run) => n + run.size, 0);
    for (const [id, run] of this.runs) {
      if (bytes <= MAX_BYTES && this.runs.size <= MAX_RUNS) break;
      bytes -= run.size;
      this.runs.delete(id);
    }
  }

  private append(run: LiveRun, text: string) {
    if (!text) return;
    const data = Buffer.from(text);
    for (let start = 0; start < data.length; start += 16 * 1024) {
      const chunk = data.subarray(start, start + 16 * 1024);
      run.chunks.push({
        id: ++this.id,
        attempt: run.attempt,
        offset: run.offset,
        bytes: chunk.toString("base64"),
        createdAt: new Date(this.now()).toISOString(),
      });
      run.offset += chunk.length;
      run.size += chunk.length;
    }
    while (run.size > MAX_RUN_BYTES && run.chunks.length > 1) {
      const removed = run.chunks.shift();
      if (removed) run.size -= Buffer.byteLength(removed.bytes, "base64");
    }
  }

  push(id: string, attempt: number, seq: number, bytes: string) {
    this.prune();
    let run = this.runs.get(id);
    if (!run || run.attempt !== attempt) {
      run = {
        attempt,
        seq: -1,
        offset: 0,
        touched: this.now(),
        size: 0,
        chunks: [],
        redactor: createRedactor([]),
        decoder: new TextDecoder(),
      };
      this.runs.set(id, run);
    }
    if (seq <= run.seq) return;
    run.seq = seq;
    run.touched = this.now();
    this.append(run, run.redactor.push(run.decoder.decode(Buffer.from(bytes, "base64"), { stream: true })));
    this.prune();
  }

  finish(id: string, attempt: number) {
    const run = this.runs.get(id);
    if (!run || run.attempt !== attempt) return;
    this.append(run, run.redactor.push(run.decoder.decode()) + run.redactor.flush());
  }

  after(id: string, after: number, limit: number): RunLogChunk[] {
    this.prune();
    return (
      this.runs
        .get(id)
        ?.chunks.filter((c) => c.id > after)
        .slice(0, limit) ?? []
    );
  }
}

export const liveRunLogs = new LiveRunLogs();
setInterval(() => liveRunLogs.prune(), 1000).unref();

/** Giá trị lồng nhau của báo cáo/sự kiện cũng có thể chứa thông báo lỗi, URL hay output của tool. */
export function redactRunData<T>(value: T): T {
  if (typeof value === "string") {
    const r = createRedactor([]);
    return (r.push(value) + r.flush()) as T;
  }
  if (Array.isArray(value)) return value.map(redactRunData) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, redactRunData(v)])) as T;
  }
  return value;
}
