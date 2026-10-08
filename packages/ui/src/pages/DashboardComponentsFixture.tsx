import { useState } from "react";
import { AttentionList } from "#ui/components/AttentionList.tsx";
import { SummaryStrip } from "#ui/components/SummaryStrip.tsx";
import { Page, PageHeader } from "#ui/components/common.tsx";
import { Button } from "#ui/components/ui/button.tsx";
import { Input } from "#ui/components/ui/input.tsx";
import { Badge } from "#ui/components/ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "#ui/components/ui/card.tsx";
import { Tag, Switch, SegmentedTabs, StatTile, ListRow, EmptyState, type Tone } from "#ui/components/ui/primitives.tsx";
import { Toggle } from "#ui/components/ui/toggle.tsx";
import { translate as t } from "#ui/i18n/translate.ts";

function ThemeFixture({ theme }: { theme: "dark" | "light" }) {
  const [value, setValue] = useState("all");
  return <section data-theme={theme} data-cosmic-fixture={theme} className="cosmic-fixture" aria-label={t(`cosmicFixture.${theme}`)}>
    <h2>{t(`cosmicFixture.${theme}`)}</h2>
    <div className="cosmic-fixture-grid">
      <Card><CardHeader><CardTitle>{t("cosmicFixture.buttons")}</CardTitle></CardHeader><CardContent className="cosmic-fixture-stack">
        {(["sm", "md", "lg"] as const).map(size => <div className="cosmic-fixture-wrap" key={size}>{(["glass", "solid", "blue", "ghost"] as const).map(variant => <Button key={variant} variant={variant} size={size}>{t(`cosmicFixture.${variant}`)} · {size}</Button>)}</div>)}
        <Button disabled>{t("cosmicFixture.disabled")}</Button>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>{t("cosmicFixture.controls")}</CardTitle></CardHeader><CardContent className="cosmic-fixture-stack">
        <label>{t("cosmicFixture.name")}<Input placeholder={t("cosmicFixture.placeholder")} /></label>
        <Input aria-label={t("cosmicFixture.disabled")} disabled placeholder={t("cosmicFixture.disabled")} />
        <Switch defaultChecked>{t("cosmicFixture.toggle")}</Switch>
        <Toggle aria-label={t("cosmicFixture.toggle")}>{t("cosmicFixture.toggle")}</Toggle>
        <SegmentedTabs label={t("cosmicFixture.tabs")} value={value} onChange={setValue} items={(["all", "running", "done"] as const).map(value => ({ value, label: t(`cosmicFixture.${value}`) }))} />
      </CardContent></Card>
      <Card><CardHeader><CardTitle>{t("cosmicFixture.tags")}</CardTitle></CardHeader><CardContent className="cosmic-fixture-stack">
        <div className="cosmic-fixture-wrap">{(["neutral", "info", "success", "warning", "danger"] as Tone[]).map(tone => <Tag key={tone} tone={tone}>{t(`cosmicFixture.${tone}`)}</Tag>)}</div>
        <div className="cosmic-fixture-wrap">{(["default", "secondary", "destructive", "outline", "ghost", "link"] as const).map(variant => <Badge variant={variant} key={variant}>{t("cosmicFixture.tags")}</Badge>)}</div>
        <StatTile label={t("cosmicFixture.stats")} value="—" detail={t("cosmicFixture.sample")} />
      </CardContent></Card>
      <Card><CardContent className="cosmic-fixture-stack">
        <ListRow title={t("cosmicFixture.row")} description={t("cosmicFixture.sample")} action={<Button size="sm">{t("cosmicFixture.open")}</Button>} />
        <EmptyState title={t("cosmicFixture.empty")} description={t("cosmicFixture.emptyDetail")} />
      </CardContent></Card>
    </div>
  </section>;
}
/** Browser-only samples, explicitly isolated from product metrics. */
export function DashboardComponentsFixture() {
  return <Page><PageHeader title={t("cosmicFixture.title")} />
    <ThemeFixture theme="dark" /><ThemeFixture theme="light" />
    <SummaryStrip label={t("cosmicFixture.stats")} items={[
      { id: "running", label: t("cosmicFixture.running"), value: 2, href: "#/runs?status=running" },
      { id: "queued", label: t("cosmicFixture.all"), value: 1, href: "#/runs?status=queued" },
      { id: "review", label: t("cosmicFixture.warning"), value: 3, href: "#/tasks?status=review", tone: "warning" },
    ]} />
    <AttentionList label={t("cosmicFixture.warning")} items={[
      { id: "quota", level: "warning", levelLabel: t("cosmicFixture.warning"), text: t("cosmicFixture.sample"), action: <button type="button">{t("cosmicFixture.open")}</button> },
      { id: "backup", level: "danger", levelLabel: t("cosmicFixture.danger"), text: t("cosmicFixture.sample"), action: <button type="button" disabled>{t("cosmicFixture.disabled")}</button> },
    ]} />
  </Page>;
}
