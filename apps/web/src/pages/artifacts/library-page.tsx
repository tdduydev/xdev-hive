import { ArtifactLibrary } from "@xdev-hive/artifacts-ui";
import { PageBody } from "@/shell/page-header.tsx";
import { WebArtifacts } from "./web-env.tsx";

/** Thư viện artifact `/artifacts` (FR-080): tiêu đề, bộ lọc và thùng rác nằm trong component dùng chung với app. */
export function ArtifactLibraryPage() {
  return (
    <WebArtifacts>
      <PageBody>
        <ArtifactLibrary />
      </PageBody>
    </WebArtifacts>
  );
}
