import { Link } from "@tanstack/react-router";
import { Icon } from "../components/icons.tsx";
import { buttonVariants } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { ORG_ROLE_LABEL } from "../lib/roles.ts";
import { useMe } from "../shell/me-context.ts";
import { useOrgs } from "../shell/org-context.ts";
import { PageBody, PageHeader } from "../shell/page-header.tsx";

/** Trang chủ tạm cho tới khi có bảng việc (M3): cho biết đang ở tổ chức nào, hoặc đang chờ lời mời. */
export function HomePage() {
  const me = useMe();
  const { current } = useOrgs();
  return (
    <>
      <PageHeader title={`Chào ${me.name}`} />
      <PageBody>
        <Card className="grid justify-items-center gap-2 px-6 py-10 text-center">
          <span className="mb-1 grid size-10 place-items-center rounded-lg bg-accent text-accent-foreground">
            <Icon name="users" className="size-5" />
          </span>
          {current ? (
            <>
              <h2 className="text-base font-semibold text-foreground">{current.org.name}</h2>
              <p className="max-w-md text-muted-foreground">
                Bạn là {ORG_ROLE_LABEL[current.org.role].toLowerCase()} của tổ chức này. Việc của các dự án nằm ở bảng
                việc.
              </p>
              <div className="mt-2 flex flex-wrap justify-center gap-2">
                <Link to="/tasks" className={buttonVariants({ variant: "default" })}>
                  Bảng việc
                </Link>
                <Link to="/admin/teams" className={buttonVariants({ variant: "outline" })}>
                  Đội và hệ thống
                </Link>
                <Link to="/admin/members" className={buttonVariants({ variant: "outline" })}>
                  Thành viên
                </Link>
              </div>
            </>
          ) : (
            <>
              <h2 className="text-base font-semibold text-foreground">Chưa thuộc tổ chức nào</h2>
              <p className="max-w-md text-muted-foreground">
                Nhờ quản trị tổ chức gửi lời mời tới <span className="font-medium text-foreground">{me.email}</span>.
                Khi đã vào tổ chức, dự án và việc của đội sẽ hiện ở đây.
              </p>
            </>
          )}
        </Card>
      </PageBody>
    </>
  );
}
