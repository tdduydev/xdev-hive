import { ConstructionIcon } from "lucide-react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty.tsx";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import type { NavItem } from "@/lib/nav.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const text: Dict<{ title: string; body: (design: string) => string }> = {
  vi: {
    title: "Sắp có",
    body: (design) =>
      `Màn này đã có thiết kế (docs/design-system/screens/${design}) và đang được làm. Hub chưa có đủ API cho màn này.`,
  },
  en: {
    title: "Coming soon",
    body: (design) =>
      `This screen is designed (docs/design-system/screens/${design}) and in progress. The hub does not have the APIs yet.`,
  },
};

/** Trang tạm cho màn đã có trong sidebar (thiết kế v2) nhưng chưa làm, để link không dẫn tới trang lỗi. */
export function ComingSoonPage({ item, design }: { item: Pick<NavItem, "label">; design: string }) {
  const t = useT(text);
  const lang = useLang();
  return (
    <>
      <PageHeader title={item.label[lang]} />
      <PageBody>
        <Empty className="border border-dashed border-border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ConstructionIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle role="heading" aria-level={2}>
              {t.title}
            </EmptyTitle>
            <EmptyDescription>{t.body(design)}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </PageBody>
    </>
  );
}
