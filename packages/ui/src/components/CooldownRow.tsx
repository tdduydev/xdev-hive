import type { QuotaCooldown } from "@xdev-hive/core";
import { Button } from "#ui/components/ui/button.tsx";
import { TableCell } from "#ui/components/ui/table.tsx";
import { ResponsiveTableRow as TableRow } from "#ui/components/ResponsiveTable.tsx";
import { ErrorNote } from "#ui/components/common.tsx";
import { formatTime, useAction, useHive } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { canClearCooldown } from "#ui/lib/permission-controls.ts";

export function CooldownRow({ cooldown: c, onChanged }: { cooldown: QuotaCooldown; onChanged: () => void }) {
  const { client, me } = useHive();
  const t = useT();
  const action = useAction();
  return (
    <TableRow>
      <TableCell className="align-top font-mono text-xs">{c.account}</TableCell>
      <TableCell className="align-top text-muted-foreground">{formatTime(c.until)}</TableCell>
      <TableCell className="align-top whitespace-normal">
        <div className="flex max-w-80 min-w-0 flex-col gap-2">
          <span className="whitespace-pre-wrap wrap-anywhere">{c.reason || <span className="text-muted-foreground">—</span>}</span>
          <ErrorNote error={action.error} />
        </div>
      </TableCell>
      <TableCell className="align-top font-mono text-xs text-muted-foreground">{c.reportedBy}</TableCell>
      <TableCell className="text-right align-top">
        {canClearCooldown(me) ? (
          <Button
            size="sm"
            variant="outline"
            disabled={action.busy}
            title={t("machines.clearHint")}
            onClick={() =>
              void action.run(async () => {
                await client.call("cooldowns.clear", { account: c.account });
                onChanged();
              })
            }
          >
            {t("machines.clear")}
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
