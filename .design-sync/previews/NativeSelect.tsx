import { Label, NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@xdev-hive/ui";

export function Basic() {
  return (
    <div className="flex max-w-sm flex-col gap-4 p-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ns-priority">Ưu tiên</Label>
        <NativeSelect id="ns-priority" defaultValue="normal" wrapperClassName="w-48">
          <NativeSelectOption value="high">Cao</NativeSelectOption>
          <NativeSelectOption value="normal">Bình thường</NativeSelectOption>
          <NativeSelectOption value="low">Thấp</NativeSelectOption>
        </NativeSelect>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ns-machine">Máy chạy merge</Label>
        <NativeSelect id="ns-machine" defaultValue="" wrapperClassName="w-full">
          <NativeSelectOption value="">Chọn máy</NativeSelectOption>
          <NativeSelectOption value="mac-mini-01">mac-mini-01</NativeSelectOption>
          <NativeSelectOption value="hc-duytd20-linux">hc-duytd20-linux · Gác cổng</NativeSelectOption>
        </NativeSelect>
      </div>
    </div>
  );
}

export function Sizes() {
  return (
    <div className="flex flex-wrap items-center gap-3 p-4">
      <NativeSelect size="sm" defaultValue="d7" aria-label="Khoảng thời gian (sm)">
        <NativeSelectOption value="d1">24 giờ</NativeSelectOption>
        <NativeSelectOption value="d7">7 ngày</NativeSelectOption>
        <NativeSelectOption value="d30">30 ngày</NativeSelectOption>
      </NativeSelect>
      <NativeSelect defaultValue="d30" aria-label="Khoảng thời gian">
        <NativeSelectOption value="d1">24 giờ</NativeSelectOption>
        <NativeSelectOption value="d7">7 ngày</NativeSelectOption>
        <NativeSelectOption value="d30">30 ngày</NativeSelectOption>
      </NativeSelect>
    </div>
  );
}

// Option groups only show once the native list opens; the closed control shows the selected profile.
export function Grouped() {
  return (
    <div className="flex max-w-sm flex-col gap-1.5 p-4">
      <Label htmlFor="ns-profile">Gói agent</Label>
      <NativeSelect id="ns-profile" defaultValue="codex-2" wrapperClassName="w-64">
        <NativeSelectOptGroup label="Claude">
          <NativeSelectOption value="claude-1">claude-1</NativeSelectOption>
          <NativeSelectOption value="claude-4">claude-4</NativeSelectOption>
        </NativeSelectOptGroup>
        <NativeSelectOptGroup label="Codex">
          <NativeSelectOption value="codex-1">codex-1</NativeSelectOption>
          <NativeSelectOption value="codex-2">codex-2</NativeSelectOption>
        </NativeSelectOptGroup>
      </NativeSelect>
    </div>
  );
}

export function States() {
  return (
    <div className="flex max-w-sm flex-col gap-4 p-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ns-project">Dự án</Label>
        <NativeSelect id="ns-project" defaultValue="" aria-invalid wrapperClassName="w-64">
          <NativeSelectOption value="">Chọn dự án</NativeSelectOption>
          <NativeSelectOption value="xdev-hive">xdev-hive</NativeSelectOption>
          <NativeSelectOption value="ehospital-ai">ehospital-ai</NativeSelectOption>
        </NativeSelect>
        <p className="m-0 text-xs text-danger">Chọn một dự án trước khi tạo task.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ns-locked">Kênh cập nhật</Label>
        <NativeSelect id="ns-locked" defaultValue="stable" disabled wrapperClassName="w-64">
          <NativeSelectOption value="stable">Ổn định</NativeSelectOption>
          <NativeSelectOption value="beta">Beta</NativeSelectOption>
        </NativeSelect>
      </div>
    </div>
  );
}
