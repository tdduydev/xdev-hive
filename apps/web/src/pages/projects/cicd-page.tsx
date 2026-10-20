import { ConstructionIcon } from "lucide-react";
import { EmptyState } from "@/components/ui/query-state.tsx";
import { type Dict, useT } from "@/lib/i18n.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const text: Dict<{ title: string; soon: string; soonLead: string }> = {
  vi: {
    title: "CI/CD",
    soon: "Màn này đang được xây",
    soonLead: "Danh sách build và pipeline của dự án sẽ hiện ở đây.",
  },
  en: {
    title: "CI/CD",
    soon: "This screen is being built",
    soonLead: "The project's builds and pipelines will show here.",
  },
};

/** Trang rỗng giữ chỗ route và menu; task web sau của specs/020 thay nội dung. */
export function CiCdPage() {
  const t = useT(text);
  return (
    <>
      <PageHeader title={t.title} />
      <PageBody>
        <EmptyState icon={ConstructionIcon} title={t.soon} description={t.soonLead} />
      </PageBody>
    </>
  );
}
