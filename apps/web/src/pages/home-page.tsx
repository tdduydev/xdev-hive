import { Icon } from "../components/icons.tsx";
import { Card } from "../components/ui/card.tsx";
import { useMe } from "../shell/me-context.ts";
import { PageBody, PageHeader } from "../shell/page-header.tsx";

/** Trang chủ tạm: chưa có API tổ chức (M1c) nên mọi người đều ở trạng thái chưa thuộc tổ chức nào. */
export function HomePage() {
  const me = useMe();
  return (
    <>
      <PageHeader title={`Chào ${me.name}`} />
      <PageBody>
        <Card className="grid justify-items-center gap-2 px-6 py-10 text-center">
          <span className="mb-1 grid size-10 place-items-center rounded-lg bg-sel text-sel-fg">
            <Icon name="users" className="size-5" />
          </span>
          <h2 className="text-lg font-semibold text-ink">Chưa thuộc tổ chức nào</h2>
          <p className="max-w-md text-muted">
            Nhờ quản trị tổ chức gửi lời mời tới <span className="font-medium text-ink">{me.email}</span>. Khi đã vào tổ
            chức, dự án và việc của đội sẽ hiện ở đây.
          </p>
        </Card>
      </PageBody>
    </>
  );
}
