import { Checkbox, Input, Label, Switch, Textarea } from "@xdev-hive/ui";

// Label never renders alone: each story pairs it with the control it names (htmlFor -> id).
export function WithField() {
  return (
    <div className="flex max-w-sm flex-col gap-4 p-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="lb-key">Mã dự án</Label>
        <Input id="lb-key" defaultValue="xdev-hive" />
        <p className="m-0 text-xs text-fg-muted">Agent truyền mã này vào tham số project của tool xdev-hive.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="lb-note">Ghi chú bàn giao</Label>
        <Textarea id="lb-note" rows={2} placeholder="Đã làm / chưa làm / cách kiểm tra / rủi ro" />
      </div>
    </div>
  );
}

// Inline labels for a checkbox or switch use font-normal; a disabled control (the peer before it) mutes the label.
export function Inline() {
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Switch id="lb-auto" defaultChecked />
        <Label htmlFor="lb-auto" className="font-normal">Tự giao task cho máy rảnh</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="lb-review" defaultChecked />
        <Label htmlFor="lb-review" className="font-normal">Xong thì review chéo bằng vendor khác</Label>
      </div>
      <div className="flex items-center gap-2">
        <Switch id="lb-gate" disabled />
        <Label htmlFor="lb-gate" className="font-normal">Máy gác cổng merge (chỉ admin bật được)</Label>
      </div>
    </div>
  );
}
