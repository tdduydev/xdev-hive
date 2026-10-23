import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ItemBoard, ItemDetail, NewItem, Questions, SdlcProvider } from "@xdev-hive/sdlc-ui";
import type { ReactNode } from "react";
import { sdlcTabOf, useWebSdlcEnv } from "@/lib/sdlc-env.tsx";
import { SdlcItemArtifacts } from "@/pages/artifacts/linked-section.tsx";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody } from "@/shell/page-header.tsx";

/*
 * Màn AI SDLC của web (specs/011 T054): giao diện ở packages/sdlc-ui, dùng chung với app desktop; web chỉ nối router,
 * API và quyền. Mỗi component tự có tiêu đề trang nên ở đây không dùng PageHeader.
 */

export function SdlcPage({ children }: { children: ReactNode }) {
  const { org } = useOrg();
  return (
    <SdlcProvider env={useWebSdlcEnv()}>
      {/* Đổi tổ chức thì dựng lại để bộ lọc và bản nháp của tổ chức cũ không sang tổ chức mới. */}
      <PageBody key={org.id}>{children}</PageBody>
    </SdlcProvider>
  );
}

export function SdlcBoardPage() {
  const { project, mode } = useSearch({ from: "/session/app/in-org/sdlc" });
  return (
    <SdlcPage>
      {/* Bộ lọc trên URL chỉ là điểm mở; mở lại với bộ lọc khác thì dựng lại bảng thay vì giữ lựa chọn cũ. */}
      <ItemBoard key={`${project ?? ""}|${mode ?? ""}`} initialProjectId={project} initialModeRef={mode} />
    </SdlcPage>
  );
}

export function SdlcNewPage() {
  const navigate = useNavigate();
  return (
    <SdlcPage>
      <NewItem
        onCreated={(item) =>
          navigate({
            to: "/sdlc/$project/$number",
            params: { project: item.project.key, number: String(item.number) },
          })
        }
      />
    </SdlcPage>
  );
}

export function SdlcQuestionsPage() {
  return (
    <SdlcPage>
      <Questions />
    </SdlcPage>
  );
}

export function SdlcItemPage() {
  const params = useParams({ strict: false }) as { project?: string; number?: string; tab?: string };
  const navigate = useNavigate();
  const project = params.project ?? "";
  const number = Number(params.number);
  return (
    <SdlcPage>
      <ItemDetail
        key={`${project}/${number}`}
        projectKey={project}
        number={number}
        tab={sdlcTabOf(params.tab)}
        onTabChange={(tab) =>
          navigate(
            tab === "overview"
              ? { to: "/sdlc/$project/$number", params: { project, number: String(number) } }
              : { to: "/sdlc/$project/$number/$tab", params: { project, number: String(number), tab } },
          )
        }
      />
      <SdlcItemArtifacts projectKey={project} number={number} />
    </SdlcPage>
  );
}
