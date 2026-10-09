import { Button, PageHeader } from "@xdev-hive/ui";
import { Plus, RefreshCw } from "lucide-react";

export function WithActions() {
  return (
    <div className="p-4">
      <PageHeader
        title="Máy chạy agent"
        subtitle="Máy nào đang trực tuyến, chạy phiên bản nào và đang làm gì."
        actions={
          <>
            <Button variant="outline" size="sm"><RefreshCw />Đọc lại quota</Button>
            <Button variant="solid" size="sm"><Plus />Thêm máy</Button>
          </>
        }
      />
    </div>
  );
}

export function TitleAndSubtitle() {
  return (
    <div className="p-4">
      <PageHeader title="Thành viên" subtitle="Ai vào được hub và vai trò của họ: admin quản lý mọi dự án, member làm task, viewer chỉ xem." />
    </div>
  );
}

export function TitleOnly() {
  return (
    <div className="p-4">
      <PageHeader title="Token truy cập" actions={<Button variant="outline" size="sm"><Plus />Tạo token</Button>} />
    </div>
  );
}
