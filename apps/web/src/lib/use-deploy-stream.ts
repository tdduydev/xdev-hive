import type { DeployState, DeployStep, RunLogChunk } from "@xdev-hive/contracts";
import { LogBuffer } from "@xdev-hive/contracts/run-log";
import { useEffect, useRef, useState } from "react";
import type { StreamStatus } from "@/lib/use-run-stream.ts";

/**
 * Địa chỉ SSE của lần triển khai (apps/hub delivery/stream-route.ts). Như luồng của run: EventSource không đặt được
 * header nên tổ chức đi bằng tham số `org`; nối lại thì trình duyệt tự gửi Last-Event-ID.
 */
export function deployStreamUrl(orgId: string, deployId: string): string {
  return `/api/v1/deploys/${encodeURIComponent(deployId)}/stream?org=${encodeURIComponent(orgId)}`;
}

/** Trạng thái và các bước hub gửi mỗi khi đổi (sự kiện `steps`). */
export interface DeploySnapshot {
  state: DeployState;
  steps: DeployStep[];
}

interface DeployLogFrame {
  id: number;
  bytes: string;
  createdAt: string;
}

/**
 * Đoạn log của lần triển khai không có `attempt` và `offset` như của run; điền giá trị cố định để dùng chung
 * `LogBuffer` (giải mã UTF-8 theo luồng, bỏ đoạn đã nhận khi hub phát lại).
 */
export function toLogChunk(frame: DeployLogFrame): RunLogChunk {
  return { id: frame.id, attempt: 1, offset: 0, bytes: frame.bytes, createdAt: frame.createdAt };
}

/** Khung không đọc được (hub mới thêm trường, proxy cắt giữa chừng) thì bỏ qua thay vì làm vỡ trang. */
export function parseFrame<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export interface DeployStream {
  log: string;
  /** Null tới khi hub gửi khung `steps` đầu tiên. */
  snapshot: DeploySnapshot | null;
  status: StreamStatus;
  /** Mở lại luồng sau khi lỗi. */
  retry: () => void;
}

/**
 * Log và các bước của lần triển khai qua SSE của hub. `onChange` gọi mỗi khi trạng thái đổi và khi luồng kết thúc, để
 * trang tải lại lần triển khai (phiên bản, health, giờ kết thúc nằm trong deploys.get).
 */
export function useDeployStream(orgId: string, deployId: string, onChange: () => void): DeployStream {
  const [log, setLog] = useState("");
  const [snapshot, setSnapshot] = useState<DeploySnapshot | null>(null);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [attempt, setAttempt] = useState(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    // `attempt` chỉ để effect chạy lại khi bấm thử lại; mở lại thì nhận lại từ đầu với buffer mới.
    void attempt;
    const buffer = new LogBuffer();
    setLog("");
    setSnapshot(null);
    setStatus("connecting");
    const source = new EventSource(deployStreamUrl(orgId, deployId), { withCredentials: true });
    let frame = 0;
    const flushLog = () => {
      frame = 0;
      setLog(buffer.toString());
    };
    source.onopen = () => setStatus("live");
    source.addEventListener("steps", (e) => {
      const next = parseFrame<DeploySnapshot>((e as MessageEvent<string>).data);
      if (!next) return;
      setSnapshot(next);
      onChangeRef.current();
    });
    source.addEventListener("log", (e) => {
      const chunk = parseFrame<DeployLogFrame>((e as MessageEvent<string>).data);
      if (chunk && buffer.append([toLogChunk(chunk)]) && !frame) frame = requestAnimationFrame(flushLog);
    });
    source.addEventListener("end", () => {
      source.close();
      if (frame) cancelAnimationFrame(frame);
      flushLog();
      setStatus("ended");
      onChangeRef.current();
    });
    source.onerror = () => {
      // CONNECTING là trình duyệt đang tự nối lại; CLOSED là bỏ hẳn (hub trả lỗi HTTP).
      setStatus(source.readyState === EventSource.CLOSED ? "error" : "connecting");
    };
    return () => {
      source.close();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [orgId, deployId, attempt]);

  return { log, snapshot, status, retry: () => setAttempt((n) => n + 1) };
}
