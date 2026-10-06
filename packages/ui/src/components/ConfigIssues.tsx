// BUG-config-silent: the parts of config.json the app could not read. Agent và quota and Hôm nay say so, so a profile
// that vanished from the list is not mistaken for one the app lost on its own.
import type { ConfigIssue } from "@xdev-hive/core";
import { Notice } from "#ui/components/common.tsx";
import { useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";

export function ConfigIssues({ issues, configPath, className }: { issues: ConfigIssue[] | undefined; configPath?: string; className?: string }) {
  const t = useT();
  if (!issues?.length) return null;
  return (
    <div data-config-issues={issues.length} className={className}>
      <Notice tone="warn" title={t("configIssues.title", { count: issues.length })}>
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {issues.map((i, n) => (
            <li key={n} className="wrap-anywhere">
              <span className="font-mono text-xs">
                {i.section}
                {i.id === null ? "" : `[${i.id}]`}
                {i.field ? `.${i.field}` : ""}
              </span>
              {": "}
              {i.message} · {t(i.action === "skipped" ? "configIssues.skipped" : "configIssues.default")}
            </li>
          ))}
        </ul>
        <p className="m-0 mt-1 text-xs/[18px] text-fg-muted">{t("configIssues.fix", { path: configPath ?? "config.json" })}</p>
      </Notice>
    </div>
  );
}

/** For pages that do not read the settings themselves (Hôm nay): nothing outside the desktop app. */
export function DesktopConfigIssues({ className }: { className?: string }) {
  const { client } = useHive();
  const settings = useQuery(() => (client.desktop ? client.desktop.settings() : Promise.resolve(null)), [client.desktop]);
  return <ConfigIssues issues={settings.data?.configIssues} configPath={settings.data?.configPath} className={className} />;
}
