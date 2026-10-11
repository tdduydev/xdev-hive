import type { RunEventView, RunLogChunk } from "@xdev-hive/contracts";
import { useEffect, useRef, useState } from "react";
import { LogBuffer, mergeEvents, runStreamUrl } from "./run-stream.ts";

/** connecting: đang mở. live: đang nhận. ended: run đã xong, hub đóng luồng. error: mất kết nối và không tự nối lại. */
export type StreamStatus = "connecting" | "live" | "ended" | "error";

export interface RunStream {
  events: RunEventView[];
  log: string;
  status: StreamStatus;
  /** Mở lại luồng sau khi lỗi. */
  retry: () => void;
}

/**
 * Sự kiện và log trực tiếp của run qua SSE của hub. Có sự kiện `state` thì gọi `onState` để trang tải lại run (trạng
 * thái, kết quả, chi phí nằm trong runs.get). EventSource tự nối lại khi rớt mạng; hub trả lỗi (401, 403, 404) thì
 * trình duyệt đóng hẳn luồng và trang hiện nút thử lại.
 */
export function useRunStream(orgId: string, runId: string, onState: () => void): RunStream {
  const [events, setEvents] = useState<RunEventView[]>([]);
  const [log, setLog] = useState("");
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [attempt, setAttempt] = useState(0);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;

  useEffect(() => {
    // Mở lại (đổi run, bấm thử lại) thì nhận lại từ đầu; buffer mới để không lẫn log của run trước. `attempt` chỉ để
    // effect chạy lại khi bấm thử lại.
    void attempt;
    const buffer = new LogBuffer();
    setEvents([]);
    setLog("");
    setStatus("connecting");
    const source = new EventSource(runStreamUrl(orgId, runId), { withCredentials: true });
    // Gom cập nhật log theo khung hình: hub có thể phát hàng trăm đoạn liền nhau lúc mới mở.
    let frame = 0;
    const flushLog = () => {
      frame = 0;
      setLog(buffer.toString());
    };
    source.onopen = () => setStatus("live");
    source.addEventListener("run_event", (e) => {
      const event = JSON.parse((e as MessageEvent<string>).data) as RunEventView;
      setEvents((current) => mergeEvents(current, [event]));
      if (event.type === "state") onStateRef.current();
    });
    source.addEventListener("log", (e) => {
      const chunk = JSON.parse((e as MessageEvent<string>).data) as RunLogChunk;
      if (buffer.append([chunk]) && !frame) frame = requestAnimationFrame(flushLog);
    });
    source.addEventListener("end", () => {
      source.close();
      if (frame) cancelAnimationFrame(frame);
      flushLog();
      setStatus("ended");
      onStateRef.current();
    });
    source.onerror = () => {
      // CONNECTING là trình duyệt đang tự nối lại; CLOSED là bỏ hẳn (hub trả lỗi HTTP).
      setStatus(source.readyState === EventSource.CLOSED ? "error" : "connecting");
    };
    return () => {
      source.close();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [orgId, runId, attempt]);

  return { events, log, status, retry: () => setAttempt((n) => n + 1) };
}
