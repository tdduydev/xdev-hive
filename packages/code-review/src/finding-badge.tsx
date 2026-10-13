import type { FindingSeverity } from "@xdev-hive/contracts";
import { Pill } from "@xdev-hive/ui/pill";
import type { CodeReviewText } from "./text.ts";

const TONE = { critical: "bad", major: "warn", minor: "neutral", info: "neutral" } as const;

export function SeverityPill({ severity, t }: { severity: FindingSeverity; t: CodeReviewText }) {
  return (
    <Pill tone={TONE[severity]} small>
      {t.severity[severity]}
    </Pill>
  );
}
