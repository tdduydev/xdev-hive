import {
  Label,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@xdev-hive/ui";

// Only the first story is rendered open (defaultOpen): the popup portals to <body> and would cover neighbouring
// cells in a grid card. The min height keeps the open list over the dark theme box rather than the white frame.
export function MachinePicker() {
  return (
    <div className="flex flex-col gap-1.5 p-4" style={{ minHeight: 340 }}>
      <Label htmlFor="sel-machine">Giao cho máy</Label>
      <Select defaultValue="mac-mini-01" defaultOpen>
        <SelectTrigger id="sel-machine" className="w-64">
          <SelectValue placeholder="Chọn máy" />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectGroup>
            <SelectLabel>Đang trực tuyến</SelectLabel>
            <SelectItem value="mac-mini-01">mac-mini-01</SelectItem>
            <SelectItem value="hc-duytd20-linux">hc-duytd20-linux</SelectItem>
            <SelectItem value="win-qa-02">win-qa-02</SelectItem>
          </SelectGroup>
          <SelectSeparator />
          <SelectGroup>
            <SelectLabel>Ngoại tuyến</SelectLabel>
            <SelectItem value="macbook-duy" disabled>macbook-duy</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}

function ProfileSelect({ size, value, label }: { size: "sm" | "default" | "lg"; value: string; label: string }) {
  return (
    <Select defaultValue={value}>
      <SelectTrigger size={size} className="w-44" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="claude-4">claude-4</SelectItem>
        <SelectItem value="codex-2">codex-2</SelectItem>
        <SelectItem value="claude-1">claude-1</SelectItem>
      </SelectContent>
    </Select>
  );
}

export function Sizes() {
  return (
    <div className="flex flex-wrap items-center gap-3 p-4">
      <ProfileSelect size="sm" value="claude-4" label="Gói agent (sm)" />
      <ProfileSelect size="default" value="codex-2" label="Gói agent" />
      <ProfileSelect size="lg" value="claude-1" label="Gói agent (lg)" />
    </div>
  );
}

export function States() {
  return (
    <div className="flex max-w-sm flex-col gap-4 p-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="sel-project">Dự án</Label>
        <Select>
          <SelectTrigger id="sel-project" className="w-64">
            <SelectValue placeholder="Chọn dự án" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="xdev-hive">xdev-hive</SelectItem>
            <SelectItem value="ehospital-ai">ehospital-ai</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="sel-model">Model</Label>
        <Select>
          <SelectTrigger id="sel-model" className="w-64" aria-invalid>
            <SelectValue placeholder="Chọn model cho task" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="balanced">Cân bằng</SelectItem>
          </SelectContent>
        </Select>
        <p className="m-0 text-xs text-danger">Task cần một model trước khi giao.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="sel-locked">Kênh cập nhật</Label>
        <Select defaultValue="stable" disabled>
          <SelectTrigger id="sel-locked" className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stable">Ổn định</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
