/**
 * Địa chỉ SSE của run (apps/hub runs/stream.ts). EventSource không đặt được header nên tổ chức đi bằng tham số `org`;
 * khi nối lại trình duyệt tự gửi Last-Event-ID để hub phát tiếp từ chỗ đã nhận.
 */
export function runStreamUrl(orgId: string, runId: string): string {
  return `/api/v1/runs/${encodeURIComponent(runId)}/stream?org=${encodeURIComponent(orgId)}`;
}
