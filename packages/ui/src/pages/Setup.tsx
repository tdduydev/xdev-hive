import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { requiredItemIds, type MachineCommand, type SetupItem, type SetupReport, type SetupState } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Badge, Empty, ErrorNote, Notice, Page, PageHeader } from "../components/common.tsx";
import { formatTime, useAction, useHive, useQuery } from "../hooks.ts";

const STATE: Record<SetupState, { label: string; tone: string }> = {
  installed: { label: "Đã cài", tone: "ok" },
  missing: { label: "Chưa cài", tone: "warn" },
  outdated: { label: "Cần cập nhật", tone: "info" },
  manual: { label: "Cần sửa tay", tone: "danger" },
};

export function SetupPage() {
  const { client } = useHive();
  const desktop = client.desktop!;
  const status = useQuery(() => desktop.setupStatus(), [desktop]);
  const [report, setReport] = useState<SetupReport | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  const requests = useQuery(() => desktop.hubRequests(), [desktop, tick]);
  const shown = report ?? status.data;
  const policy = requests.data?.policy ?? null;
  const required = policy && shown ? requiredItemIds(policy, shown.projects.map((p) => p.project)) : new Set<string>();
  const replace = (item: SetupItem) =>
    shown &&
    setReport({
      machine: shown.machine.map((i) => (i.id === item.id ? item : i)),
      projects: shown.projects.map((p) => ({ ...p, items: p.items.map((i) => (i.id === item.id ? item : i)) })),
    });
  const missing = shown ? [...shown.machine, ...shown.projects.flatMap((p) => p.items)].filter((i) => i.state !== "installed").length : 0;

  return (
    <Page>
      <PageHeader
        title="Cài đặt máy"
        subtitle="App kiểm tra những gì đã có trên máy này và trong từng repo. Mỗi nút chỉ làm đúng việc ghi ở dòng đó."
        actions={
          <Button
            variant="outline"
            disabled={status.loading}
            onClick={() => {
              setReport(null);
              status.reload();
            }}
          >
            <RefreshCw className={status.loading ? "animate-spin" : undefined} />
            {status.loading ? "Đang kiểm tra…" : "Kiểm tra lại"}
          </Button>
        }
      />
      <ErrorNote error={status.error} />
      {requests.data?.commands.length ? (
        <RequestsCard
          commands={requests.data.commands}
          onAnswered={() => {
            setTick((n) => n + 1);
            setReport(null);
            status.reload();
          }}
        />
      ) : null}
      {!shown && status.loading ? <p className="text-sm text-muted-foreground">Đang kiểm tra CLI, lệnh hive-mcp và các repo…</p> : null}
      {shown ? (
        <>
          <Notice tone={missing ? "warn" : "ok"}>
            {missing ? `${missing} mục chưa sẵn sàng.` : "Mọi thứ đã sẵn sàng."}
            {policy && required.size ? ` Chính sách team yêu cầu ${required.size} mục (nhãn "bắt buộc").` : ""}
          </Notice>
          <Card>
            <CardHeader>
              <CardTitle>Máy này</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <SetupList items={shown.machine} required={required} onChanged={replace} />
            </CardContent>
          </Card>
          {shown.projects.length === 0 ? (
            <Empty>
              Chưa có dự án. Thêm repo ở{" "}
              <a href="#/projects" className="font-medium text-primary underline underline-offset-2">
                Dự án &amp; cài đặt
              </a>{" "}
              để kiểm tra cấu hình agent, codegraph và superpowers trong repo.
            </Empty>
          ) : null}
          {shown.projects.map((p) => (
            <Card key={p.project}>
              <CardHeader>
                <CardTitle className="font-mono break-all">{p.project}</CardTitle>
                <CardDescription className="font-mono text-xs break-all">{p.repo}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <SetupList items={p.items} required={required} onChanged={replace} />
              </CardContent>
            </Card>
          ))}
        </>
      ) : null}
    </Page>
  );
}

function RequestsCard({ commands, onAnswered }: { commands: MachineCommand[]; onAnswered: () => void }) {
  const { client } = useHive();
  const action = useAction();
  const [done, setDone] = useState<MachineCommand | null>(null);
  const answer = (c: MachineCommand, approve: boolean) =>
    void action.run(async () => {
      setDone(await client.desktop!.answerCommand(c.id, approve));
      onAnswered();
    });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Yêu cầu từ admin</CardTitle>
        <CardDescription>Admin trên hub muốn máy này cài các mục dưới đây. App chỉ chạy đúng việc của mục đó, và chỉ khi bạn đồng ý.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          {commands.map((c) => (
            <div key={c.id} className="flex flex-col gap-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 font-medium break-words">{c.label}</span>
                <Button size="sm" variant="outline" disabled={action.busy} onClick={() => answer(c, true)}>
                  {action.busy ? "Đang cài…" : "Đồng ý và cài"}
                </Button>
                <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => answer(c, false)}>
                  Từ chối
                </Button>
              </div>
              <div className="text-xs break-words text-muted-foreground">
                #{c.id} · {c.requestedBy} · {formatTime(c.requestedAt)} · <span className="font-mono break-all">{c.itemId}</span>
              </div>
            </div>
          ))}
        </div>
        <ErrorNote error={action.error} />
        {done ? (
          <Notice tone={done.status === "done" ? "ok" : done.status === "rejected" ? "info" : "error"}>
            #{done.id} {done.label}: {done.status === "done" ? "đã cài xong" : done.status === "rejected" ? "đã từ chối" : "cài lỗi"}. Hub đã nhận kết quả.
          </Notice>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SetupList({ items, required, onChanged }: { items: SetupItem[]; required: Set<string>; onChanged: (item: SetupItem) => void }) {
  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => (
        <SetupRow key={item.id} item={item} required={required.has(item.id)} onChanged={onChanged} />
      ))}
    </div>
  );
}

function SetupRow({ item, required, onChanged }: { item: SetupItem; required: boolean; onChanged: (item: SetupItem) => void }) {
  const { client } = useHive();
  const action = useAction();
  const [output, setOutput] = useState<string | null>(null);
  const state = STATE[item.state];
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={state.tone}>{state.label}</Badge>
        <span className="min-w-0 font-medium break-words">{item.label}</span>
        {required ? <Badge tone="accent">bắt buộc</Badge> : null}
        {item.action ? (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                const r = await client.desktop!.installSetup(item.id);
                setOutput(r.output || null);
                onChanged(r.item);
              })
            }
          >
            {action.busy ? "Đang cài…" : item.action}
          </Button>
        ) : null}
      </div>
      <div className="text-xs break-words text-muted-foreground">{item.detail}</div>
      <ErrorNote error={action.error} />
      {output ? (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">Kết quả</summary>
          <pre className="mt-2 max-h-80 overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs">{output}</pre>
        </details>
      ) : null}
    </div>
  );
}
