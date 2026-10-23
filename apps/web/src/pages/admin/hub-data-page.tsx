import { HUB_DATA_INVENTORY, HUB_DATA_NOTES } from "@xdev-hive/contracts";
import { Card } from "@/components/ui/card.tsx";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

export function HubDataPage() {
  return (
    <>
      <PageHeader title="Dữ liệu hub giữ" />
      <PageBody>
        <Card className="grid gap-3 p-5">
          <h2 className="font-semibold">Ranh giới dữ liệu và ngoại lệ</h2>
          <ul className="grid list-disc gap-2 pl-5 text-sm text-muted-foreground">
            {HUB_DATA_NOTES.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </Card>
        <div className="grid min-w-0 gap-4">
          {HUB_DATA_INVENTORY.map((category) => (
            <Card key={category.id} className="grid min-w-0 gap-2 p-5">
              <h2 className="font-semibold">{category.label}</h2>
              <dl className="grid gap-2 text-sm">
                <div>
                  <dt className="font-medium">Nguồn</dt>
                  <dd className="text-muted-foreground">{category.source}</dd>
                </div>
                <div>
                  <dt className="font-medium">Thời gian giữ</dt>
                  <dd className="text-muted-foreground">{category.retention}</dd>
                </div>
                <div>
                  <dt className="font-medium">Gửi có chủ đích</dt>
                  <dd className="text-muted-foreground">{category.deliberate ? "Có" : "Tự động / hỗn hợp"}</dd>
                </div>
              </dl>
              <details className="text-sm text-muted-foreground">
                <summary className="cursor-pointer">Bảng dữ liệu</summary>
                <p className="mt-2 break-words font-mono text-xs">{category.tables.join(", ")}</p>
              </details>
            </Card>
          ))}
        </div>
      </PageBody>
    </>
  );
}
