import { useState } from "react";
import {
  AGENT_KINDS,
  AGENT_ROLES,
  AGENT_TEMPLATES,
  agentProfileSchema,
  type AgentKind,
  type AgentProfile,
  type AgentProfileStatus,
  type AgentRole,
  type ProfileCheck,
  type RunnerSettings,
} from "@xdev-hive/core";
import { Badge, Empty, ErrorNote, PageHeader } from "../components/ui.tsx";
import { errorMessage, formatTime, useAction, useHive, useQuery } from "../hooks.ts";
import { ROLE_LABEL } from "./Board.tsx";

const KIND_LABEL: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini", custom: "Tuỳ chỉnh" };

/** Env var that points each CLI at a separate login, so two subscriptions of one vendor can rotate. */
const ACCOUNT_ENV_HINT: Partial<Record<AgentKind, string>> = {
  claude: "CLAUDE_CONFIG_DIR=~/.claude-2",
  codex: "CODEX_HOME=~/.codex-2",
};

export function AgentsPage() {
  const { client } = useHive();
  const desktop = client.desktop!;
  const [tick, setTick] = useState(0);
  const profiles = useQuery(() => desktop.profiles(), [desktop, tick]);
  const settings = useQuery(() => desktop.settings(), [desktop]);
  const [editing, setEditing] = useState<{ profile: AgentProfile; previousId?: string } | null>(null);
  const refresh = () => setTick((t) => t + 1);

  const newProfile = (kind: AgentKind) => {
    const base = kind === "custom" ? { ...AGENT_TEMPLATES.claude, kind, label: "Agent tuỳ chỉnh", bin: "", args: ["{prompt}"] } : AGENT_TEMPLATES[kind];
    const taken = new Set((profiles.data ?? []).map((p) => p.id));
    let n = 1;
    while (taken.has(`${kind}-${n}`)) n++;
    setEditing({ profile: { ...base, id: `${kind}-${n}`, label: kind === "custom" ? base.label : `${KIND_LABEL[kind]} (gói ${n})`, env: {} } });
  };

  return (
    <div className="page">
      <PageHeader
        title="Gói sub & agent"
        subtitle="Mỗi profile là một gói sub (một tài khoản CLI). Runner chọn theo ưu tiên, xoay vòng các gói cùng mức, và cho gói nghỉ đến giờ reset khi hết quota."
      />
      {settings.data ? <RunnerCard runner={settings.data.runner} /> : null}
      <div className="row gap-s wrap">
        <span className="muted small">Thêm profile:</span>
        {AGENT_KINDS.map((k) => (
          <button key={k} className="btn btn-small" onClick={() => newProfile(k)}>
            + {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      {editing ? (
        <ProfileForm
          key={editing.previousId ?? editing.profile.id}
          initial={editing.profile}
          previousId={editing.previousId}
          onDone={() => {
            setEditing(null);
            refresh();
          }}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      <ErrorNote error={profiles.error} />
      {profiles.data?.length === 0 ? <Empty>Chưa có profile nào.</Empty> : null}
      <div className="profile-grid">
        {profiles.data?.map((p) => (
          <ProfileCard key={p.id} profile={p} onEdit={() => setEditing({ profile: p, previousId: p.id })} onChanged={refresh} />
        ))}
      </div>
    </div>
  );
}

function ProfileCard({ profile: p, onEdit, onChanged }: { profile: AgentProfileStatus; onEdit: () => void; onChanged: () => void }) {
  const { client } = useHive();
  const desktop = client.desktop!;
  const action = useAction();
  const [check, setCheck] = useState<ProfileCheck | null>(null);
  const resting = p.cooldownUntil !== null;
  const { cooldownUntil: _c, cooldownReason: _r, running: _n, lastUsedAt: _l, stats: _s, ...plain } = p;

  return (
    <article className={`card profile-card ${p.enabled ? "" : "disabled"}`}>
      <div className="row gap-s">
        <span className={`dot dot-${!p.enabled ? "neutral" : resting ? "warn" : p.running ? "info" : "ok"}`} />
        <b className="grow ellipsis">{p.label}</b>
        <Badge tone="accent">{KIND_LABEL[p.kind]}</Badge>
      </div>
      <div className="mono small muted">
        {p.id} · ưu tiên {p.priority} · tối đa {p.maxConcurrent} song song
      </div>
      <div className="small">
        {!p.enabled ? (
          <span className="muted">Đang tắt</span>
        ) : resting ? (
          <span className="tone-warn">
            Nghỉ đến {formatTime(p.cooldownUntil)}
            {p.cooldownReason ? ` · ${p.cooldownReason}` : ""}
          </span>
        ) : p.running ? (
          <span className="tone-info">Đang chạy {p.running} run</span>
        ) : (
          <span className="tone-ok">Sẵn sàng</span>
        )}
      </div>
      <div className="row gap-s wrap small muted">
        <span>{p.stats.runs} lượt</span>
        <span>· {p.stats.succeeded} xong</span>
        <span>· {p.stats.rateLimited} hết quota</span>
        <span>· {p.stats.failed} lỗi</span>
        {p.lastUsedAt ? <span>· dùng {formatTime(p.lastUsedAt)}</span> : null}
      </div>
      <div className="row gap-s wrap">
        {p.roles.map((r) => (
          <Badge key={r}>{ROLE_LABEL[r]}</Badge>
        ))}
      </div>
      <code className="mono small cmdline">
        {Object.entries(p.env)
          .map(([k, v]) => `${k}=${v} `)
          .join("")}
        {p.bin} {p.args.join(" ")}
      </code>
      <div className="row gap-s wrap">
        <button
          className="btn btn-small"
          disabled={action.busy}
          onClick={() => void action.run(async () => (await desktop.saveProfile({ ...plain, enabled: !p.enabled }, p.id), onChanged()))}
        >
          {p.enabled ? "Tắt" : "Bật"}
        </button>
        <button className="btn btn-small" disabled={action.busy} onClick={() => void action.run(async () => setCheck(await desktop.checkProfile(p.id)))}>
          Kiểm tra CLI
        </button>
        {resting ? (
          <button className="btn btn-small" disabled={action.busy} onClick={() => void action.run(async () => (await desktop.resetCooldown(p.id), onChanged()))}>
            Hết nghỉ
          </button>
        ) : null}
        <button className="btn btn-small btn-ghost" onClick={onEdit}>
          Sửa
        </button>
        <button
          className="btn btn-small btn-ghost btn-danger"
          disabled={action.busy}
          onClick={() => {
            if (window.confirm(`Xoá profile ${p.id}? Lịch sử run vẫn giữ.`)) void action.run(async () => (await desktop.removeProfile(p.id), onChanged()));
          }}
        >
          Xoá
        </button>
      </div>
      {check ? (
        <div className={`note ${check.ok ? "note-ok" : "note-error"}`}>
          {check.path ? <div className="mono small">{check.path}</div> : null}
          <div className="mono small pre">{check.output || (check.ok ? "OK" : "Lỗi")}</div>
        </div>
      ) : null}
      <ErrorNote error={action.error} />
    </article>
  );
}

const envToText = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
const textToEnv = (text: string) =>
  Object.fromEntries(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf("=");
        return i === -1 ? [l, ""] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );

function ProfileForm({
  initial,
  previousId,
  onDone,
  onCancel,
}: {
  initial: AgentProfile;
  previousId?: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { client } = useHive();
  const [p, setP] = useState(initial);
  const [argsText, setArgsText] = useState(initial.args.join("\n"));
  const [envText, setEnvText] = useState(envToText(initial.env));
  const [error, setError] = useState<string | null>(null);
  const action = useAction();
  const set = <K extends keyof AgentProfile>(key: K, value: AgentProfile[K]) => setP({ ...p, [key]: value });
  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v !== "" ? Number(v) : fallback);

  const submit = () => {
    const candidate = { ...p, args: argsText.split("\n").filter((a) => a.length > 0), env: textToEnv(envText) };
    const parsed = agentProfileSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"));
      return;
    }
    setError(null);
    void action.run(async () => {
      await client.desktop!.saveProfile(parsed.data, previousId);
      onDone();
    });
  };

  return (
    <form
      className="card profile-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h2>{previousId ? `Sửa ${previousId}` : "Profile mới"}</h2>
      <div className="form-grid">
        <label className="label" htmlFor="pf-id">Id</label>
        <input id="pf-id" className="input mono" value={p.id} onChange={(e) => set("id", e.target.value)} />
        <label className="label" htmlFor="pf-label">Tên</label>
        <input id="pf-label" className="input" value={p.label} onChange={(e) => set("label", e.target.value)} />
        <label className="label" htmlFor="pf-kind">Loại</label>
        <select id="pf-kind" className="input" value={p.kind} onChange={(e) => set("kind", e.target.value as AgentKind)}>
          {AGENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <label className="label" htmlFor="pf-bin">Lệnh</label>
        <input id="pf-bin" className="input mono" placeholder="claude hoặc /đường/dẫn/tuyệt/đối" value={p.bin} onChange={(e) => set("bin", e.target.value)} />
        <label className="label" htmlFor="pf-args">Tham số (mỗi dòng một)</label>
        <textarea id="pf-args" className="textarea textarea-small mono" value={argsText} onChange={(e) => setArgsText(e.target.value)} />
        <span />
        <span className="muted small">
          <code>{"{prompt}"}</code> được thay bằng prompt của task (không có thì prompt đi qua stdin). Có thêm <code>{"{worktree}"}</code>,{" "}
          <code>{"{task}"}</code>, <code>{"{project}"}</code>, <code>{"{branch}"}</code>. Cờ CLI đổi theo phiên bản: kiểm tra bằng <code>--help</code>.
        </span>
        <label className="label" htmlFor="pf-env">Biến môi trường</label>
        <textarea
          id="pf-env"
          className="textarea textarea-small mono"
          placeholder={ACCOUNT_ENV_HINT[p.kind] ?? "KEY=value"}
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
        />
        <span />
        <span className="muted small">
          Gói thứ hai của cùng vendor: trỏ CLI sang thư mục đăng nhập khác
          {ACCOUNT_ENV_HINT[p.kind] ? (
            <>
              , ví dụ <code>{ACCOUNT_ENV_HINT[p.kind]}</code>
            </>
          ) : null}
          , rồi đăng nhập một lần trong terminal với biến đó.
        </span>
        <label className="label">Vai trò</label>
        <div className="row gap-s wrap">
          {AGENT_ROLES.map((r) => (
            <label key={r} className="check small">
              <input
                type="checkbox"
                checked={p.roles.includes(r)}
                onChange={(e) => set("roles", e.target.checked ? [...p.roles, r] : p.roles.filter((x: AgentRole) => x !== r))}
              />
              {ROLE_LABEL[r]}
            </label>
          ))}
        </div>
        <label className="label" htmlFor="pf-priority">Ưu tiên</label>
        <input id="pf-priority" className="input" type="number" min={0} max={100} value={p.priority} onChange={(e) => set("priority", num(e.target.value, p.priority))} />
        <label className="label" htmlFor="pf-conc">Song song tối đa</label>
        <input id="pf-conc" className="input" type="number" min={1} max={8} value={p.maxConcurrent} onChange={(e) => set("maxConcurrent", num(e.target.value, p.maxConcurrent))} />
        <label className="label" htmlFor="pf-cool">Nghỉ mặc định (phút)</label>
        <input id="pf-cool" className="input" type="number" min={1} value={p.cooldownMinutes} onChange={(e) => set("cooldownMinutes", num(e.target.value, p.cooldownMinutes))} />
        <label className="label" htmlFor="pf-timeout">Giới hạn mỗi run (phút)</label>
        <input id="pf-timeout" className="input" type="number" min={1} value={p.timeoutMinutes} onChange={(e) => set("timeoutMinutes", num(e.target.value, p.timeoutMinutes))} />
      </div>
      <label className="check">
        <input type="checkbox" checked={p.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        Bật
      </label>
      {error ? <div className="note note-error">{error}</div> : null}
      <ErrorNote error={action.error} />
      <div className="row gap-s">
        <button className="btn btn-primary" type="submit" disabled={action.busy}>
          Lưu profile
        </button>
        <button className="btn btn-ghost" type="button" onClick={onCancel}>
          Huỷ
        </button>
      </div>
    </form>
  );
}

function RunnerCard({ runner }: { runner: RunnerSettings }) {
  const { client } = useHive();
  const [maxParallel, setMaxParallel] = useState(String(runner.maxParallel));
  const [maxAttempts, setMaxAttempts] = useState(String(runner.maxAttempts));
  const [root, setRoot] = useState(runner.worktreeRoot ?? "");
  const action = useAction();
  const [saved, setSaved] = useState(false);
  return (
    <section className="card">
      <h2>Runner</h2>
      <div className="row gap-s wrap">
        <label className="label" htmlFor="rn-par">Agent chạy song song</label>
        <input id="rn-par" className="input input-num" type="number" min={1} max={8} value={maxParallel} onChange={(e) => setMaxParallel(e.target.value)} />
        <label className="label" htmlFor="rn-att">Số lần thử mỗi task (tính cả xoay vòng)</label>
        <input id="rn-att" className="input input-num" type="number" min={1} max={6} value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)} />
      </div>
      <div className="form-grid">
        <label className="label" htmlFor="rn-root">Thư mục worktree</label>
        <input id="rn-root" className="input mono" placeholder="~/.xdev-hive/worktrees (mặc định)" value={root} onChange={(e) => setRoot(e.target.value)} />
      </div>
      <div className="row gap-s">
        <button
          className="btn"
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              try {
                await client.desktop!.updateSettings({
                  runner: { maxParallel: Number(maxParallel), maxAttempts: Number(maxAttempts), worktreeRoot: root.trim() || null },
                });
                setSaved(true);
              } catch (err) {
                setSaved(false);
                throw new Error(errorMessage(err));
              }
            })
          }
        >
          Lưu
        </button>
        {saved ? <span className="tone-ok small">Đã lưu</span> : null}
      </div>
      <ErrorNote error={action.error} />
    </section>
  );
}
