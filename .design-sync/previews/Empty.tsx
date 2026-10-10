import { Card, CardContent, CardHeader, CardTitle, Empty } from "@xdev-hive/ui";

export function Basic() {
  return (
    <div className="max-w-xl p-4">
      <Empty>Chưa có task nào. Tạo task hoặc giao việc cho agent để bắt đầu.</Empty>
    </div>
  );
}

// The usual place: a section of a page whose list came back empty.
export function InSection() {
  return (
    <div className="flex max-w-xl flex-col gap-3 p-4">
      <h2 className="type-heading-sm text-fg-strong">Lượt chạy đang thực hiện</h2>
      <Empty>Chưa có lượt chạy đang thực hiện.</Empty>
    </div>
  );
}

export function InCard() {
  return (
    <div className="max-w-md p-4">
      <Card>
        <CardHeader>
          <CardTitle>Chờ review</CardTitle>
        </CardHeader>
        <CardContent>
          <Empty>Không có task nào chờ review.</Empty>
        </CardContent>
      </Card>
    </div>
  );
}
