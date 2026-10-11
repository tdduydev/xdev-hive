import type { RunEventView, RunLogChunk } from "@xdev-hive/contracts";

/**
 * Địa chỉ SSE của run (apps/hub runs/stream.ts). EventSource không đặt được header nên tổ chức đi bằng tham số `org`;
 * khi nối lại trình duyệt tự gửi Last-Event-ID để hub phát tiếp từ chỗ đã nhận.
 */
export function runStreamUrl(orgId: string, runId: string): string {
  return `/api/v1/runs/${encodeURIComponent(runId)}/stream?org=${encodeURIComponent(orgId)}`;
}

/** Thêm sự kiện mới vào danh sách, bỏ sự kiện đã có (hub phát lại khi nối lại mà mất con trỏ). Giữ thứ tự id. */
export function mergeEvents(current: RunEventView[], incoming: RunEventView[]): RunEventView[] {
  const last = current.at(-1)?.id ?? 0;
  const fresh = incoming.filter((e) => e.id > last);
  return fresh.length ? [...current, ...fresh] : current;
}

// Mã điều khiển màu và con trỏ của terminal (CSI, OSC); log hiện trong <pre> nên bỏ đi cho dễ đọc.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-_]`, "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Giữ tối đa chừng này ký tự log trong trình duyệt; run dài in hàng chục MB sẽ làm trang đơ. */
export const LOG_LIMIT = 400_000;

/**
 * Ghép các đoạn log (base64, theo thứ tự id) thành chữ. Giải mã UTF-8 theo luồng để ký tự nhiều byte bị cắt giữa hai
 * đoạn vẫn ra đúng; mỗi lần thử mới có một dòng ngăn cách. Bỏ đoạn đã nhận (id không tăng) khi SSE phát lại.
 */
export class LogBuffer {
  private text = "";
  private trimmed = false;
  private lastId = 0;
  private attempt: number | null = null;
  private decoder = new TextDecoder("utf-8");

  append(chunks: RunLogChunk[]): boolean {
    let changed = false;
    for (const chunk of chunks) {
      if (chunk.id <= this.lastId) continue;
      this.lastId = chunk.id;
      if (this.attempt !== chunk.attempt) {
        if (this.attempt !== null) this.text += `${this.decoder.decode()}\n── Lần thử ${chunk.attempt} ──\n`;
        this.decoder = new TextDecoder("utf-8");
        this.attempt = chunk.attempt;
      }
      const raw = this.decoder.decode(base64Bytes(chunk.bytes), { stream: true });
      this.text += stripAnsi(raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
      changed = true;
    }
    if (this.text.length > LOG_LIMIT) {
      this.text = this.text.slice(this.text.length - LOG_LIMIT);
      this.trimmed = true;
    }
    return changed;
  }

  toString(): string {
    return this.trimmed
      ? `… (đã bỏ phần log cũ, chỉ giữ ${LOG_LIMIT.toLocaleString("vi-VN")} ký tự cuối)\n${this.text}`
      : this.text;
  }
}
