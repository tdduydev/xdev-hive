import { useEffect, useState } from "react";
import { requiredItemIds, type MachineCommand, type SetupItem, type SetupReport, type SetupState } from "@xdev-hive/core";
import { Badge, Empty, ErrorNote, PageHeader } from "../components/ui.tsx";
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
    <div className="page">
      <PageHeader
        title="Cài đặt máy"
        subtitle="App kiểm tra những gì đã có trên máy này và trong từng repo. Mỗi nút chỉ làm đúng việc ghi ở dòng đó."
        actions={
          <button
            className="btn"
            disabled={status.loading}
            onClick={() => {
              setReport(null);
              status.reload();
            }}
          >
            {status.loading ? "Đang kiểm tra…" : "Kiểm tra lại"}
          </button>
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
      {!shown && status.loading ? <div className="muted">Đang kiểm tra CLI, lệnh hive-mcp và các repo…</div> : null}
      {shown ? (
        <>
          <div className={`note ${missing ? "note-warn" : "note-ok"}`}>
            {missing ? `${missing} mục chưa sẵn sàng.` : "Mọi thứ đã sẵn sàng."}
            {policy && required.size ? ` Chính sách team yêu cầu ${required.size} mục (nhãn "bắt buộc").` : ""}
          </div>
          <section className="card">
            <h2>Máy này</h2>
            <SetupList items={shown.machine} required={required} onChanged={replace} />
          </section>
          {shown.projects.length === 0 ? (
            <Empty>
              Chưa có dự án. Thêm repo ở <a href="#/projects">Dự án &amp; cài đặt</a> để kiểm tra cấu hình agent, codegraph và superpowers trong repo.
            </Empty>
          ) : null}
          {shown.projects.map((p) => (
            <section key={p.project} className="card">
              <h2>
                <span className="mono">{p.project}</span>
              </h2>
              <div className="muted small mono">{p.repo}</div>
              <SetupList items={p.items} required={required} onChanged={replace} />
            </section>
          ))}
        </>
      ) : null}
    </div>
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
    <section className="card">
      <h2>Yêu cầu từ admin</h2>
      <p className="muted small">Admin trên hub muốn máy này cài các mục dưới đây. App chỉ chạy đúng việc của mục đó, và chỉ khi bạn đồng ý.</p>
      <div className="stack">
        {commands.map((c) => (
          <div key={c.id} className="setup-row">
            <div className="row gap-s wrap">
              <b className="grow">{c.label}</b>
              <button className="btn btn-small btn-primary" disabled={action.busy} onClick={() => answer(c, true)}>
                {action.busy ? "Đang cài…" : "Đồng ý và cài"}
              </button>
              <button className="btn btn-small btn-ghost" disabled={action.busy} onClick={() => answer(c, false)}>
                Từ chối
              </button>
            </div>
            <div className="muted small">
              #{c.id} · {c.requestedBy} · {formatTime(c.requestedAt)} · <span className="mono">{c.itemId}</span>
            </div>
          </div>
        ))}
      </div>
      <ErrorNote error={action.error} />
      {done ? (
        <div className={`note ${done.status === "done" ? "note-ok" : done.status === "rejected" ? "" : "note-error"}`}>
          #{done.id} {done.label}: {done.status === "done" ? "đã cài xong" : done.status === "rejected" ? "đã từ chối" : "cài lỗi"}. Hub đã nhận kết quả.
        </div>
      ) : null}
    </section>
  );
}

function SetupList({ items, required, onChanged }: { items: SetupItem[]; required: Set<string>; onChanged: (item: SetupItem) => void }) {
  return (
    <div className="stack">
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
    <div className="setup-row">
      <div className="row gap-s">
        <Badge tone={state.tone}>{state.label}</Badge>
        <b>{item.label}</b>
        {required ? <Badge tone="accent">bắt buộc</Badge> : null}
        <span className="grow" />
        {item.action ? (
          <button
            className="btn btn-small btn-primary"
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
          </button>
        ) : null}
      </div>
      <div className="muted small setup-detail">{item.detail}</div>
      <ErrorNote error={action.error} />
      {output ? (
        <details>
          <summary className="small">Kết quả</summary>
          <pre className="log log-diff">{output}</pre>
        </details>
      ) : null}
    </div>
  );
}
