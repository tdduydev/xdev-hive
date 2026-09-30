// Warns about invisible characters (bidi controls, tags, zero-width) before the hub refuses the text.
import { findHidden } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { useT } from "#ui/i18n/index.tsx";
import { Notice } from "./common.tsx";

/** Where the first hidden character is across the fields, and a button that removes them all. */
export function HiddenChars({ fields, onStrip }: { fields: Array<{ label: string; text: string }>; onStrip: () => void }) {
  const t = useT();
  const found = fields.map((f) => ({ label: f.label, hits: findHidden(f.text, 1000) }));
  const count = found.reduce((n, f) => n + f.hits.length, 0);
  const first = found.find((f) => f.hits.length);
  if (!first) return null;
  const hit = first.hits[0]!;
  return (
    <Notice tone="warn" title={t("hidden.title", { count })}>
      <p>{t("hidden.first", { count, code: hit.code, field: first.label, line: hit.line, column: hit.column })}</p>
      <p>{t("hidden.hint")}</p>
      <Button size="sm" variant="outline" type="button" className="mt-2" onClick={onStrip}>
        {t("hidden.strip")}
      </Button>
    </Notice>
  );
}
