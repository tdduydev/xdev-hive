import { Button, Card, EmptyState } from "@xdev-hive/ui";
import { Plus } from "lucide-react";

export function WithAction() {
  return (
    <div className="p-4">
      <EmptyState
        title="Chưa có task nào"
        description="Tạo task đầu tiên để agent nhận việc. Task chưa gán sẽ đi tới máy rảnh."
        action={<Button variant="solid" size="sm" className="mt-4"><Plus />Tạo task</Button>}
      />
    </div>
  );
}

export function TitleAndDescription() {
  return (
    <div className="p-4">
      <EmptyState title="Chưa có dự án" description="Tạo dự án đầu tiên để các agent dùng chung memory và task." />
    </div>
  );
}

// A whole panel with nothing in it: the empty state fills the card.
export function InPanel() {
  return (
    <div className="max-w-md p-4">
      <Card>
        <EmptyState
          title="Chưa có máy nào"
          description="Cài app xDev Hive trên một máy và đăng nhập hub để máy nhận run."
          action={<Button variant="outline" size="sm" className="mt-4">Xem hướng dẫn</Button>}
        />
      </Card>
    </div>
  );
}
