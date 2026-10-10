import { Button, Notice } from "@xdev-hive/ui";

// The four tones, each with its own icon.
export function Tones() {
  return (
    <div className="flex max-w-xl flex-col gap-3 p-4">
      <Notice tone="ok" title="Đã phát hành 0.152.0">Bản cài cho macOS, Windows và Linux đã lên GitHub Release. Hub chuyển 100% máy sang bản mới.</Notice>
      <Notice tone="warn" title="Máy linux-runner offline">Mất heartbeat từ 14:05. Task R-73a đang chờ trong hàng của máy này.</Notice>
      <Notice tone="info" title="Hub tự giao task">Task chưa gán đi tới máy rảnh đầu tiên có gói phù hợp.</Notice>
      <Notice tone="error" title="Hub không phản hồi">hive.example.com không trả lời sau 3 lần thử.</Notice>
    </div>
  );
}

// Message only: no title, as most call sites use it.
export function MessageOnly() {
  return (
    <div className="flex max-w-xl flex-col gap-3 p-4">
      <Notice tone="ok">Đã lưu. Cấu hình agent sẽ áp dụng từ lượt chạy tiếp theo.</Notice>
      <Notice tone="warn">Máy win-qa-02 đã ngoại tuyến 4 ngày.</Notice>
    </div>
  );
}

// children render inside AlertDescription (a start-aligned grid), so a button sits under the text.
export function WithAction() {
  return (
    <div className="max-w-xl p-4">
      <Notice tone="warn" title="2 agent đang chạy trên máy này">
        <p>Dừng agent trước khi cập nhật app, hoặc chờ run xong rồi cập nhật khi rảnh.</p>
        <Button variant="outline" size="xs">Dừng agent</Button>
      </Notice>
    </div>
  );
}
