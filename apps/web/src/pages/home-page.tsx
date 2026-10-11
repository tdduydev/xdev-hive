import { Link } from "@tanstack/react-router";
import { Icon } from "../components/icons.tsx";
import { buttonClass } from "../components/ui/button.tsx";
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
          <span className="mb-1 grid size-10 place-items-center rounded-lg bg-sel text-sel-fg">
            <Icon name="users" className="size-5" />
          </span>
          {current ? (
            <>
              <h2 className="text-lg font-semibold text-ink">{current.org.name}</h2>
              <p className="max-w-md text-muted">
                Bạn là {ORG_ROLE_LABEL[current.org.role].toLowerCase()} của tổ chức này. Dự án và việc của đội sẽ hiện ở
                đây khi có.
              </p>
              <div className="mt-2 flex flex-wrap justify-center gap-2">
                <Link to="/admin/teams" className={buttonClass()}>
                  Đội và hệ thống
                </Link>
                <Link to="/admin/members" className={buttonClass()}>
                  Thành viên
                </Link>
              </div>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold text-ink">Chưa thuộc tổ chức nào</h2>
              <p className="max-w-md text-muted">
                Nhờ quản trị tổ chức gửi lời mời tới <span className="font-medium text-ink">{me.email}</span>. Khi đã
                vào tổ chức, dự án và việc của đội sẽ hiện ở đây.
              </p>
            </>
          )}
        </Card>
      </PageBody>
    </>
  );
}
