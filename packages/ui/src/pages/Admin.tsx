import { useEffect, useMemo, useState } from "react";
import {
  AGENT_TEMPLATES,
  POLICY_CLIS,
  POLICY_REPO_PARTS,
  missingRequired,
  requiredItemIds,
  type AuditEntry,
  type CommandStatus,
  type MachineCommand,
  type MachineDetail,
  type PolicyRepoPart,
  type SetupItem,
  type SetupState,
  type TeamPolicy,
} from "@xdev-hive/core";
import { Badge, Empty, ErrorNote, PageHeader } from "../components/ui.tsx";
import { formatTime, useAction, useHive, useProjects, useQuery } from "../hooks.ts";

type Tab = "machines" | "policy" | "audit";
const TABS: Record<Tab, string> = { machines: "Máy", policy: "Chính sách", audit: "Nhật ký" };

const STATE: Record<SetupState, { label: string; tone: string }> = {
  installed: { label: "Đã cài", tone: "ok" },
  missing: { label: "Chưa cài", tone: "warn" },
  outdated: { label: "Cần cập nhật", tone: "info" },
  manual: { label: "Cần sửa tay", tone: "danger" },
};
const COMMAND: Record<CommandStatus, { label: string; tone: string }> = {
  pending: { label: "chờ máy đồng ý", tone: "warn" },
  running: { label: "đang cài", tone: "info" },
  done: { label: "xong", tone: "ok" },
  failed: { label: "lỗi", tone: "danger" },
  rejected: { label: "máy từ chối", tone: "neutral" },
  cancelled: { label: "đã huỷ", tone: "neutral" },
  expired: { label: "hết hạn", tone: "neutral" },
};
const CLI_LABEL: Record<(typeof POLICY_CLIS)[number], string> = { claude: "Claude Code", codex: "Codex CLI", gemini: "Gemini CLI" };
const PART_LABEL: Record<PolicyRepoPart, string> = {
  agents: "Cấu hình agent",
  "codegraph-mcp": "codegraph (MCP)",
  "codegraph-index": "Index codegraph",
  superpowers: "superpowers",
};
const ACTION_LABEL: Record<string, string> = {
  "docs.save": "Sửa tài liệu",
  "proposals.approve": "Duyệt đề xuất",
  "proposals.reject": "Từ chối đề xuất",
  "memory.approve": "Duyệt memory",
  "memory.remove": "Xoá memory",
  "tasks.create": "Tạo task",
  "machines.remove": "Xoá máy",
  "cooldowns.clear": "Hết nghỉ quota",
  "policy.set": "Sửa chính sách",
  "admin.commandCreate": "Yêu cầu cài",
  "admin.commandCancel": "Huỷ yêu cầu",
  "machines.commandResult": "Máy báo kết quả",
  "tokens.create": "Tạo token",
  "tokens.revoke": "Thu hồi token",
};

export function AdminPage() {
  const [tab, setTab] = useState<Tab>("machines");
  return (
    <div className="page page-wide">
      <PageHeader title="Quản trị" subtitle="Tình trạng cài đặt của mọi máy trong team, chính sách chung và nhật ký thao tác admin." />
      <div className="tabs" role="tablist">
        {(Object.keys(TABS) as Tab[]).map((id) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
            {TABS[id]}
          </button>
        ))}
      </div>
      {tab === "machines" ? <FleetTab /> : tab === "policy" ? <PolicyTab /> : <AuditTab />}
    </div>
  );
}

// ── machines ───────────────────────────────────────────────────────────────

function FleetTab() {
  const { client } = useHive();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  const machines = useQuery(() => client.call("admin.machines", {}), [client, tick]);
  const policy = useQuery(() => client.call("policy.get", {}), [client]);
  const reload = () => setTick((n) => n + 1);
  const list = machines.data ?? [];
  const lacking = policy.data ? list.filter((m) => m.setup && missingRequired(policy.data!, m.setup).length > 0).length : 0;
  const waiting = list.reduce((n, m) => n + m.commands.filter((c) => c.status === "pending" || c.status === "running").length, 0);

  return (
    <>
      <ErrorNote error={machines.error ?? policy.error} />
      <div className="stat-grid">
        <Stat label="Máy" value={list.length} />
        <Stat label="Đang hoạt động" value={list.filter((m) => m.online).length} />
        <Stat label="Thiếu mục bắt buộc" value={lacking} tone={lacking ? "warn" : undefined} />
        <Stat label="Yêu cầu đang mở" value={waiting} />
      </div>
      {machines.data && list.length === 0 ? <Empty>Chưa có máy nào báo lên. App desktop ở chế độ hub gửi heartbeat mỗi 30 giây.</Empty> : null}
      {list.map((m) => (
        <MachineCard key={m.id} machine={m} policy={policy.data ?? null} onChanged={reload} />
      ))}
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ""}`}>
      <div className="muted small">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

function MachineCard({ machine: m, policy, onChanged }: { machine: MachineDetail; policy: TeamPolicy | null; onChanged: () => void }) {
  const projects = m.setup?.projects.map((p) => p.project) ?? [];
  const required = policy ? requiredItemIds(policy, projects) : new Set<string>();
  const missing = policy && m.setup ? missingRequired(policy, m.setup) : [];
  const open = new Map(m.commands.filter((c) => c.status === "pending" || c.status === "running").map((c) => [c.itemId, c]));

  return (
    <section className="card">
      <div className="row gap-s wrap">
        <b className="mono">{m.machine}</b>
        <Badge tone={m.duplicate ? "danger" : m.online ? "ok" : "neutral"}>{m.duplicate ? "Trùng tên máy" : m.online ? "Đang hoạt động" : "Mất kết nối"}</Badge>
        {missing.length ? <Badge tone="warn">thiếu {missing.length} mục bắt buộc</Badge> : policy && m.setup ? <Badge tone="ok">đủ theo chính sách</Badge> : null}
        <span className="grow" />
        <span className="muted small">
          {m.version ? `v${m.version} · ` : ""}heartbeat {formatTime(m.lastSeen)}
          {m.setupAt ? ` · kiểm tra cài đặt ${formatTime(m.setupAt)}` : ""}
        </span>
      </div>
      <div className="muted small mono">{m.id}</div>
      {!m.setup ? (
        <div className="muted small">Máy chưa gửi kết quả kiểm tra cài đặt (bản app cũ, hoặc vừa mở).</div>
      ) : (
        <div className="stack">
          <ItemTable title="Máy này" items={m.setup.machine} required={required} machineId={m.id} open={open} online={m.online} onChanged={onChanged} />
          {m.setup.projects.map((p) => (
            <ItemTable
              key={p.project}
              title={p.project}
              subtitle={p.repo}
              items={p.items}
              required={required}
              machineId={m.id}
              open={open}
              online={m.online}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}
      {m.profiles.length ? (
        <div>
          <div className="list-group-title">Gói sub</div>
          <div className="row gap-s wrap">
            {m.profiles.map((p) => (
              <span key={p.id} className="profile-chip">
                <span className={`dot dot-${!p.enabled ? "neutral" : !p.installed ? "danger" : p.cooldownUntil ? "warn" : "ok"}`} />
                <span className="mono small">{p.id}</span>
                <span className="muted small">
                  {!p.enabled ? "tắt" : !p.installed ? "chưa có CLI" : p.cooldownUntil ? `nghỉ đến ${formatTime(p.cooldownUntil)}` : "sẵn sàng"}
                  {p.account ? ` · ${p.account}` : ""} · {p.runs} lượt
                </span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {m.commands.length ? <CommandList commands={m.commands} onChanged={onChanged} /> : null}
    </section>
  );
}

function ItemTable(props: {
  title: string;
  subtitle?: string;
  items: SetupItem[];
  required: Set<string>;
  machineId: string;
  open: Map<string, MachineCommand>;
  online: boolean;
  onChanged: () => void;
}) {
  const { client } = useHive();
  const action = useAction();
  return (
    <div>
      <div className="row gap-s wrap">
        <span className="list-group-title">{props.title}</span>
        {props.subtitle ? <span className="muted small mono">{props.subtitle}</span> : null}
      </div>
      <div className="stack">
        {props.items.map((i) => {
          const pending = props.open.get(i.id);
          return (
            <div key={i.id} className="setup-row">
              <div className="row gap-s wrap">
                <Badge tone={STATE[i.state].tone}>{STATE[i.state].label}</Badge>
                <span>{i.label}</span>
                {props.required.has(i.id) ? <Badge tone="accent">bắt buộc</Badge> : null}
                <span className="grow" />
                {pending ? (
                  <Badge tone={COMMAND[pending.status].tone}>{COMMAND[pending.status].label}</Badge>
                ) : i.action && i.state !== "installed" ? (
                  <button
                    className="btn btn-small"
                    disabled={action.busy}
                    title={props.online ? "Máy sẽ hỏi người dùng trước khi cài" : "Máy đang mất kết nối: yêu cầu chờ tới khi máy mở lại (hết hạn sau 24 giờ)"}
                    onClick={() =>
                      void action.run(async () => {
                        await client.call("admin.commandCreate", { machineId: props.machineId, itemId: i.id });
                        props.onChanged();
                      })
                    }
                  >
                    Yêu cầu cài
                  </button>
                ) : null}
              </div>
              <div className="small muted setup-detail">{i.detail}</div>
            </div>
          );
        })}
      </div>
      <ErrorNote error={action.error} />
    </div>
  );
}

function CommandList({ commands, onChanged }: { commands: MachineCommand[]; onChanged: () => void }) {
  const { client } = useHive();
  const action = useAction();
  return (
    <details>
      <summary className="small">Yêu cầu cài đặt ({commands.length})</summary>
      <ul className="history">
        {commands.map((c) => (
          <li key={c.id} className="history-row">
            <div className="row gap-s wrap">
              <Badge tone={COMMAND[c.status].tone}>{COMMAND[c.status].label}</Badge>
              <span className="small">
                #{c.id} {c.label}
              </span>
              <span className="muted small">
                {c.requestedBy} · {formatTime(c.requestedAt)}
                {c.updatedAt !== c.requestedAt ? ` → ${formatTime(c.updatedAt)}` : ""}
              </span>
              {c.status === "pending" ? (
                <button
                  className="btn btn-small btn-ghost"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      await client.call("admin.commandCancel", { id: c.id });
                      onChanged();
                    })
                  }
                >
                  Huỷ
                </button>
              ) : null}
            </div>
            {c.output ? <pre className="log log-diff">{c.output}</pre> : null}
          </li>
        ))}
      </ul>
      <ErrorNote error={action.error} />
    </details>
  );
}

// ── policy ─────────────────────────────────────────────────────────────────

function PolicyTab() {
  const { client } = useHive();
  const current = useQuery(() => client.call("policy.get", {}), [client]);
  const machines = useQuery(() => client.call("admin.machines", {}), [client]);
  const known = useProjects();
  const [draft, setDraft] = useState<TeamPolicy | null>(null);
  const [templates, setTemplates] = useState("");
  const [saved, setSaved] = useState(false);
  const action = useAction();

  useEffect(() => {
    if (current.data && !draft) {
      setDraft(current.data);
      setTemplates(JSON.stringify(current.data.profileTemplates, null, 2));
    }
  }, [current.data, draft]);

  const projects = useMemo(() => {
    const names = new Set<string>(known);
    for (const m of machines.data ?? []) for (const p of m.setup?.projects ?? []) names.add(p.project);
    for (const p of Object.keys(draft?.projects ?? {})) names.add(p);
    return [...names].sort();
  }, [known, machines.data, draft]);

  if (!draft) return <ErrorNote error={current.error} />;
  const change = (next: Partial<TeamPolicy>) => {
    setSaved(false);
    setDraft({ ...draft, ...next });
  };
  const toggle = <T,>(list: T[], value: T, on: boolean) => (on ? [...new Set([...list, value])] : list.filter((x) => x !== value));
  const addTemplate = (kind: keyof typeof AGENT_TEMPLATES) => {
    let list: unknown[] = [];
    try {
      list = JSON.parse(templates || "[]") as unknown[];
    } catch {
      // keep the admin's text; the new template goes into a fresh list
    }
    const base = AGENT_TEMPLATES[kind];
    const { env: _env, ...template } = { ...base, id: `${base.id.replace(/-\d+$/, "")}-team`, account: undefined };
    setSaved(false);
    setTemplates(JSON.stringify([...list, template], null, 2));
  };

  return (
    <>
      <section className="card">
        <h2>Bắt buộc trên mọi máy</h2>
        <p className="muted small">Máy nào thiếu sẽ thấy nhãn "bắt buộc" ở trang Cài đặt máy, và tab Máy đánh dấu máy đó.</p>
        <div className="row gap-s wrap">
          {POLICY_CLIS.map((cli) => (
            <label key={cli} className="check">
              <input type="checkbox" checked={draft.requiredClis.includes(cli)} onChange={(e) => change({ requiredClis: toggle(draft.requiredClis, cli, e.target.checked) })} />
              {CLI_LABEL[cli]}
            </label>
          ))}
          <label className="check">
            <input type="checkbox" checked={draft.requireShim} onChange={(e) => change({ requireShim: e.target.checked })} />
            Lệnh hive-mcp
          </label>
        </div>
      </section>

      <section className="card">
        <h2>Theo dự án</h2>
        <p className="muted small">Áp dụng cho máy nào đã thêm dự án đó vào app desktop.</p>
        {projects.length === 0 ? <Empty>Chưa thấy dự án nào (từ tài liệu, task hoặc máy báo lên).</Empty> : null}
        <div className="table-wrap">
          <table className="table">
            <tbody>
              {projects.map((p) => (
                <tr key={p}>
                  <td className="mono" style={{ width: 200 }}>
                    {p}
                  </td>
                  <td>
                    <div className="row gap-s wrap">
                      {POLICY_REPO_PARTS.map((part) => (
                        <label key={part} className="check small">
                          <input
                            type="checkbox"
                            checked={(draft.projects[p] ?? []).includes(part)}
                            onChange={(e) => {
                              const parts = toggle(draft.projects[p] ?? [], part, e.target.checked);
                              const next = { ...draft.projects, [p]: parts };
                              if (!parts.length) delete next[p];
                              change({ projects: next });
                            }}
                          />
                          {PART_LABEL[part]}
                        </label>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Profile mẫu cho team</h2>
        <p className="muted small">
          App desktop hiện các mẫu này ở trang Gói sub &amp; agent để thêm bằng một nút. Mẫu không được có <code>env</code>: thư mục đăng nhập và key là
          của từng máy.
        </p>
        <div className="row gap-s wrap">
          <span className="muted small">Thêm mẫu:</span>
          {(Object.keys(AGENT_TEMPLATES) as Array<keyof typeof AGENT_TEMPLATES>).map((k) => (
            <button key={k} className="btn btn-small" onClick={() => addTemplate(k)}>
              + {AGENT_TEMPLATES[k].label}
            </button>
          ))}
        </div>
        <textarea
          className="textarea mono"
          rows={12}
          value={templates}
          onChange={(e) => {
            setSaved(false);
            setTemplates(e.target.value);
          }}
          aria-label="Profile mẫu (JSON)"
        />
      </section>

      <div className="row gap-s">
        <button
          className="btn btn-primary"
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              let profileTemplates: TeamPolicy["profileTemplates"];
              try {
                profileTemplates = JSON.parse(templates || "[]") as TeamPolicy["profileTemplates"];
              } catch {
                throw new Error("Profile mẫu không phải JSON hợp lệ.");
              }
              const next = await client.call("policy.set", {
                requiredClis: draft.requiredClis,
                requireShim: draft.requireShim,
                projects: draft.projects,
                profileTemplates,
              });
              setDraft(next);
              setTemplates(JSON.stringify(next.profileTemplates, null, 2));
              setSaved(true);
            })
          }
        >
          Lưu chính sách
        </button>
        {saved ? <span className="tone-ok small">Đã lưu. Máy nhận ở heartbeat kế tiếp.</span> : null}
        {draft.updatedAt ? (
          <span className="muted small">
            Sửa lần cuối {formatTime(draft.updatedAt)} bởi {draft.updatedBy}
          </span>
        ) : null}
      </div>
      <ErrorNote error={action.error} />
    </>
  );
}

// ── audit ──────────────────────────────────────────────────────────────────

function AuditTab() {
  const { client } = useHive();
  const [filter, setFilter] = useState("");
  const log = useQuery(() => client.call("admin.audit", { limit: 300, action: filter || undefined }), [client, filter]);
  return (
    <>
      <div className="toolbar">
        <select className="input" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Loại thao tác">
          <option value="">Mọi thao tác</option>
          {Object.entries(ACTION_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <span className="muted small">300 mục mới nhất. Chỉ ghi thao tác thay đổi dữ liệu, không ghi lượt đọc.</span>
      </div>
      <ErrorNote error={log.error} />
      {log.data?.length === 0 ? <Empty>Chưa có thao tác nào.</Empty> : null}
      {log.data?.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Lúc</th>
                <th>Ai</th>
                <th>Thao tác</th>
                <th>Đối tượng</th>
                <th>Chi tiết</th>
              </tr>
            </thead>
            <tbody>
              {log.data.map((e: AuditEntry) => (
                <tr key={e.id}>
                  <td className="small muted nowrap">{formatTime(e.at)}</td>
                  <td className="small mono">{e.actor}</td>
                  <td className="small">{ACTION_LABEL[e.action] ?? e.action}</td>
                  <td className="small mono">{e.target}</td>
                  <td className="small note-cell">{e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
