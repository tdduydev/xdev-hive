import { Label, Textarea } from "@xdev-hive/ui";

export function Basic() {
  return (
    <div className="flex max-w-md flex-col gap-1.5 p-4">
      <Label htmlFor="ta-note">Ghi chú bàn giao</Label>
      <Textarea id="ta-note" rows={4} placeholder="Đã làm / chưa làm / cách kiểm tra / rủi ro" />
    </div>
  );
}

export function Filled() {
  return (
    <div className="flex max-w-md flex-col gap-1.5 p-4">
      <Label htmlFor="ta-body">Mô tả task</Label>
      <Textarea
        id="ta-body"
        rows={5}
        defaultValue={
          "Danh sách lượt chạy cần lọc được theo máy (mac-mini-01, linux-runner).\n" +
          "Giữ bộ lọc trên URL để chia sẻ được.\n\n" +
          "Cách kiểm tra: npm run typecheck && npm test, rồi mở trang Lượt chạy của customer-ai."
        }
      />
    </div>
  );
}

export function States() {
  return (
    <div className="flex max-w-md flex-col gap-4 p-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ta-reason">Lý do huỷ run</Label>
        <Textarea id="ta-reason" rows={2} aria-invalid defaultValue="" placeholder="Viết ngắn vì sao huỷ" />
        <p className="m-0 text-xs text-danger">Cần lý do để agent sau đọc được.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ta-locked">Prompt hệ thống của gói codex-2</Label>
        <Textarea id="ta-locked" rows={2} disabled defaultValue="Làm trên branch ai/<task-id>. Không sửa AGENTS.md trực tiếp." />
      </div>
    </div>
  );
}
