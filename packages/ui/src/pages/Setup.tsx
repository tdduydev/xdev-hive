import { useState } from "react";
import type { SetupItem, SetupReport, SetupState } from "@xdev-hive/core";
import { Badge, Empty, ErrorNote, PageHeader } from "../components/ui.tsx";
import { useAction, useHive, useQuery } from "../hooks.ts";

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
  const shown = report ?? status.data;
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
      {!shown && status.loading ? <div className="muted">Đang kiểm tra CLI, lệnh hive-mcp và các repo…</div> : null}
      {shown ? (
        <>
          <div className={`note ${missing ? "note-warn" : "note-ok"}`}>
            {missing ? `${missing} mục chưa sẵn sàng.` : "Mọi thứ đã sẵn sàng."}
          </div>
          <section className="card">
            <h2>Máy này</h2>
            <SetupList items={shown.machine} onChanged={replace} />
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
              <SetupList items={p.items} onChanged={replace} />
            </section>
          ))}
        </>
      ) : null}
    </div>
  );
}

function SetupList({ items, onChanged }: { items: SetupItem[]; onChanged: (item: SetupItem) => void }) {
  return (
    <div className="stack">
      {items.map((item) => (
        <SetupRow key={item.id} item={item} onChanged={onChanged} />
      ))}
    </div>
  );
}

function SetupRow({ item, onChanged }: { item: SetupItem; onChanged: (item: SetupItem) => void }) {
  const { client } = useHive();
  const action = useAction();
  const [output, setOutput] = useState<string | null>(null);
  const state = STATE[item.state];
  return (
    <div className="setup-row">
      <div className="row gap-s">
        <Badge tone={state.tone}>{state.label}</Badge>
        <b className="grow">{item.label}</b>
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
