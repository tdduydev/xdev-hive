import { ArrowLeft } from "lucide-react";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { useT } from "#ui/i18n/index.tsx";

export function MobileBack({ onClick }: { onClick: () => void }) {
  const t = useT();
  return <div className="sticky top-0 z-20 shrink-0 border-b border-line-subtle bg-surface px-3 py-2 md:hidden"><Button variant="ghost" onClick={onClick} className="min-h-10"><ArrowLeft />{t("common.backToList")}</Button></div>;
}
