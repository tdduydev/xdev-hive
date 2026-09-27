import { useEffect, useState } from "react";
import type { Machine, QuotaCooldown } from "@xdev-hive/core";
import { Badge, Empty, ErrorNote, PageHeader, STATUS_TONE } from "../components/ui.tsx";
import { formatTime, useAction, useHive, useQuery } from "../hooks.ts";

const ROLE_LABEL: Record<Machine["runs"][number]["role"], string> = { plan: "lập kế hoạch", implement: "làm task", review: "review" };
const REFRESH_MS = 15_000;

export function MachinesPage() {
  const { client } = useHive();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => clearInterval(t);
  }, []);
  const machines = useQuery(() => client.call("machines.list", {}), [client, tick]);
  const cooldowns = useQuery(() => client.call("cooldowns.list", {}), [client, tick]);
  const reload = () => setTick((n) => n + 1);

  return (
    <div className="page">
      <PageHeader
        title="Máy & run"
        subtitle="App desktop ở chế độ hub báo lên mỗi 30 giây: run đang chạy hoặc đang chờ, và gói sub đang nghỉ vì hết quota."
      />

      <h2>Máy</h2>
      <ErrorNote error={machines.error} />
      {machines.data?.length === 0 ? <Empty>Chưa có máy nào báo lên. Mở app desktop ở chế độ Hub dùng chung.</Empty> : null}
      {machines.data?.some((m) => m.duplicate) ? (
        <div className="note note-warn">
          Có hai app đang báo lên cùng tên máy và cùng token, nên chúng giữ chung lease task và có thể nhận trùng. Đổi <code>machine</code>{" "}
          trong <code>~/.xdev-hive/config.json</code> trên một máy, hoặc cấp cho mỗi máy một token riêng.
        </div>
      ) : null}
      {machines.data?.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Máy</th>
                <th>Trạng thái</th>
                <th>Run</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {machines.data.map((m) => (
                <MachineRow key={m.id} machine={m} onChanged={reload} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <h2>Quota đang nghỉ</h2>
      <ErrorNote error={cooldowns.error} />
      {cooldowns.data?.length === 0 ? (
        <Empty>Không có tài khoản nào đang nghỉ. Chỉ profile có điền "Tài khoản" mới chia sẻ quota qua hub.</Empty>
      ) : null}
      {cooldowns.data?.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Tài khoản</th>
                <th>Nghỉ đến</th>
                <th>Lý do</th>
                <th>Báo từ</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {cooldowns.data.map((c) => (
                <CooldownRow key={c.account} cooldown={c} onChanged={reload} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function MachineRow({ machine: m, onChanged }: { machine: Machine; onChanged: () => void }) {
  const { client, me } = useHive();
  const action = useAction();
  const running = m.runs.filter((r) => r.status === "running");
  const queued = m.runs.length - running.length;
  return (
    <tr>
      <td>
        <b className="mono">{m.machine}</b>
        <div className="muted small mono">{m.id}</div>
        {m.version ? <div className="muted small">v{m.version}</div> : null}
      </td>
      <td className="small">
        <div className="row gap-s">
          <Badge tone={m.duplicate ? "danger" : m.online ? "ok" : "neutral"}>
            {m.duplicate ? "Trùng tên máy" : m.online ? "Đang hoạt động" : "Mất kết nối"}
          </Badge>
        </div>
        <div className="muted small">lần cuối {formatTime(m.lastSeen)}</div>
      </td>
      <td className="small">
        {running.length === 0 && queued === 0 ? <span className="muted">Rảnh</span> : null}
        {running.map((r) => (
          <div key={r.runId}>
            <Badge tone={STATUS_TONE[r.status]}>đang chạy</Badge> <span className="mono">{r.taskId}</span> {r.taskTitle}
            <div className="muted small">
              {r.project} · {r.profileId ?? "?"} · {ROLE_LABEL[r.role]} · từ {formatTime(r.since)}
            </div>
          </div>
        ))}
        {queued > 0 ? <div className="muted">+ {queued} run đang chờ</div> : null}
        {!m.online && m.runs.length > 0 ? <div className="muted small">Số liệu từ lần báo cuối, có thể đã cũ.</div> : null}
        <ErrorNote error={action.error} />
      </td>
      <td className="right">
        {me.role === "admin" && !m.online ? (
          <button
            className="btn btn-small btn-ghost"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await client.call("machines.remove", { id: m.id });
                onChanged();
              })
            }
          >
            Xoá
          </button>
        ) : null}
      </td>
    </tr>
  );
}

function CooldownRow({ cooldown: c, onChanged }: { cooldown: QuotaCooldown; onChanged: () => void }) {
  const { client, me } = useHive();
  const action = useAction();
  return (
    <tr>
      <td className="mono">{c.account}</td>
      <td className="small">{formatTime(c.until)}</td>
      <td className="small note-cell">
        {c.reason || <span className="muted">—</span>}
        <ErrorNote error={action.error} />
      </td>
      <td className="small mono muted">{c.reportedBy}</td>
      <td className="right">
        {me.role !== "viewer" ? (
          <button
            className="btn btn-small"
            disabled={action.busy}
            title="Mọi máy dùng tài khoản này sẽ thử lại ở lần heartbeat kế tiếp"
            onClick={() =>
              void action.run(async () => {
                await client.call("cooldowns.clear", { account: c.account });
                onChanged();
              })
            }
          >
            Hết nghỉ
          </button>
        ) : null}
      </td>
    </tr>
  );
}
