import { useState } from "react";
import { Input, SegmentedTabs } from "@xdev-hive/ui";

// Controlled: each story keeps its own value so clicking a segment works in the card too.
export function RunFilter() {
  const [value, setValue] = useState("running");
  return (
    <div className="p-6" style={{ maxWidth: 420 }}>
      <SegmentedTabs
        label="Lọc lượt chạy"
        value={value}
        onChange={setValue}
        items={[
          { value: "all", label: "Tất cả" },
          { value: "running", label: "Đang chạy" },
          { value: "failed", label: "Lỗi" },
        ]}
      />
    </div>
  );
}

export function WithDisabled() {
  const [value, setValue] = useState("all");
  return (
    <div className="p-6" style={{ maxWidth: 640 }}>
      <SegmentedTabs
        label="Lọc nguyên nhân bị kẹt"
        value={value}
        onChange={setValue}
        items={[
          { value: "all", label: "Tất cả" },
          { value: "dependency", label: "Phụ thuộc" },
          { value: "quota", label: "Quota / chi tiêu" },
          { value: "offline", label: "Máy offline", disabled: true },
        ]}
      />
    </div>
  );
}

export function InToolbar() {
  const [value, setValue] = useState("done");
  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="type-heading-md text-fg-strong">Lượt chạy</h2>
          <p className="type-body-sm text-fg-secondary">Run của các máy trong nhóm</p>
        </div>
        <div style={{ width: 340 }}>
          <SegmentedTabs
            label="Lọc trạng thái"
            value={value}
            onChange={setValue}
            items={[
              { value: "all", label: "Tất cả" },
              { value: "running", label: "Đang chạy" },
              { value: "done", label: "Hoàn tất" },
            ]}
          />
        </div>
      </div>
      <Input placeholder="Tìm theo task, máy hoặc agent" />
    </div>
  );
}
