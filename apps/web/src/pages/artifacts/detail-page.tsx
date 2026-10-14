import { useNavigate, useParams } from "@tanstack/react-router";
import { ArtifactDetail } from "@xdev-hive/artifacts-ui";
import { NotFoundPage } from "@/pages/status-pages.tsx";
import { PageBody } from "@/shell/page-header.tsx";
import { WebArtifacts } from "./web-env.tsx";

/** `/artifacts/:id` và `/artifacts/:id/v/:n`: đường dẫn agent dán vào chữ trả lời (`artifactWebPath`). */
export function ArtifactDetailPage() {
  const { id, n } = useParams({ strict: false });
  const navigate = useNavigate();
  const version = n === undefined ? undefined : Number(n);
  if (!id || (version !== undefined && (!Number.isInteger(version) || version < 1))) return <NotFoundPage />;
  return (
    <WebArtifacts>
      <PageBody width="wide">
        <ArtifactDetail
          id={id}
          version={version}
          // Đổi phiên bản đổi URL để chép link hay tải lại trang vẫn mở đúng bản đang xem.
          onVersionChange={(next) =>
            void navigate({ to: "/artifacts/$id/v/$n", params: { id, n: String(next) }, replace: true })
          }
        />
      </PageBody>
    </WebArtifacts>
  );
}
