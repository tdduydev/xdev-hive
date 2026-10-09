import { Alert, AlertDescription, AlertTitle, Button } from "@xdev-hive/ui";
import { CircleAlert, Info, RefreshCw } from "lucide-react";

// default = info blue. An icon as the first child gets its own grid column.
export function InfoTone() {
  return (
    <div className="max-w-xl p-4">
      <Alert>
        <Info />
        <AlertTitle>Hub đang cập nhật</AlertTitle>
        <AlertDescription>Các máy sẽ tự kết nối lại sau khoảng một phút. Run đang chạy không bị dừng.</AlertDescription>
      </Alert>
    </div>
  );
}

export function Destructive() {
  return (
    <div className="max-w-xl p-4">
      <Alert variant="destructive">
        <CircleAlert />
        <AlertTitle>Hub không phản hồi</AlertTitle>
        <AlertDescription>
          <p>hive.example.com không trả lời sau 3 lần thử. Agent trên máy vẫn chạy; kết quả sẽ gửi lên khi có mạng lại.</p>
          <Button variant="outline" size="xs"><RefreshCw />Thử lại</Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}

// Without an icon the first grid column collapses to 0 and the text starts at the edge.
export function WithoutIcon() {
  return (
    <div className="flex max-w-xl flex-col gap-3 p-4">
      <Alert>
        <AlertTitle>Bản 0.152.0 đã sẵn sàng</AlertTitle>
        <AlertDescription>App sẽ cập nhật khi không còn run nào đang chạy trên máy này.</AlertDescription>
      </Alert>
      <Alert variant="destructive">
        <AlertDescription>Không đọc được quota của codex-2: phiên đăng nhập Codex CLI đã hết hạn.</AlertDescription>
      </Alert>
    </div>
  );
}
