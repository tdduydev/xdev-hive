import { useState } from "react";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { useT } from "#ui/i18n/index.tsx";
import { scopeKey, type Scope } from "#ui/lib/scope.ts";

/** A page-local choice cannot carry over to a different scope or a removed service. */
export function useServiceFilter(scope: Scope) {
  const [choice, setChoice] = useState({ key: "", service: "" });
  const key = scopeKey(scope);
  const service = scope.kind === "system" && choice.key === key && scope.projects.includes(choice.service) ? choice.service : "";
  return [service, (value: string) => setChoice({ key, service: value })] as const;
}

export function ServiceFilter({ scope, value, onChange }: { scope: Scope; value: string; onChange: (value: string) => void }) {
  const t = useT();
  if (scope.kind !== "system") return null;
  return <label className="flex min-w-0 max-w-full flex-col gap-1 text-xs text-muted-foreground">
    {t("systemOverview.service")}
    <NativeSelect data-service-filter wrapperClassName="min-w-0 max-w-full" className="w-full max-md:min-h-11 max-md:text-base" value={value} onChange={(e) => onChange(e.target.value)}>
      <NativeSelectOption value="">{t("systemOverview.allServices")}</NativeSelectOption>
      {[...new Set(scope.projects)].sort().map((p) => <NativeSelectOption key={p} value={p}>{p}</NativeSelectOption>)}
    </NativeSelect>
  </label>;
}
