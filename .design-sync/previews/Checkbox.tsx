import { Checkbox, Label } from "@xdev-hive/ui";

export function States() {
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Checkbox id="cb-review" defaultChecked />
        <Label htmlFor="cb-review" className="font-normal">Xong thì review chéo bằng vendor khác</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="cb-branch" />
        <Label htmlFor="cb-branch" className="font-normal">Làm tiếp trên branch hiện có</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="cb-all" checked="indeterminate" />
        <Label htmlFor="cb-all" className="font-normal">Chọn tất cả dòng có thể xoá</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="cb-locked" defaultChecked disabled />
        <Label htmlFor="cb-locked" className="font-normal">
          Bật hàng đợi merge
          <span className="ml-1 text-xs text-muted-foreground">(Do biến môi trường đặt)</span>
        </Label>
      </div>
    </div>
  );
}

const PERMISSIONS = [
  { id: "view", label: "Xem", hint: "task, run, tài liệu, memory, skill, chat và Context agent của service", on: true },
  { id: "taskWork", label: "Làm task", hint: "nhận task, cập nhật trạng thái và ghi chú, gửi kết quả run", on: true },
  { id: "runDispatch", label: "Giao, dừng run", hint: "giao task cho máy chạy agent, dừng run, huỷ yêu cầu", on: false },
];

export function WithHint() {
  return (
    <div className="p-4">
      <fieldset className="m-0 flex max-w-sm flex-col gap-2 rounded-md border border-line-subtle bg-subtle p-3">
        <legend className="mb-0.5 text-[11px] font-semibold tracking-wide text-fg-muted uppercase">Quyền</legend>
        {PERMISSIONS.map((p) => (
          <label key={p.id} className="flex cursor-pointer items-start gap-2 text-xs">
            <Checkbox className="mt-px" defaultChecked={p.on} />
            <span className="flex min-w-0 flex-col">
              <span className="font-medium text-fg-strong">{p.label}</span>
              <span className="text-[11px]/4 text-fg-muted">{p.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}
