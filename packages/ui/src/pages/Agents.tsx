import { useState } from "react";
import { cn } from "cn";
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
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { Badge, Empty, ErrorNote, Notice, Page, PageHeader, StatusDot } from "../components/common.tsx";
import { errorMessage, formatTime, useAction, useHive, useQuery } from "../hooks.ts";
import { ROLE_LABEL } from "./Board.tsx";

const KIND_LABEL: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini", custom: "Tuỳ chỉnh" };

/** Env var that points each CLI at a separate login, so two subscriptions of one vendor can rotate. */
const ACCOUNT_ENV_HINT: Partial<Record<AgentKind, string>> = {
  claude: "CLAUDE_CONFIG_DIR=~/.claude-2",
  codex: "CODEX_HOME=~/.codex-2",
};

const CODE = "rounded bg-muted px-1 py-0.5 font-mono text-xs";
const HINT = "text-xs text-muted-foreground sm:col-start-2";

export function AgentsPage() {
  const { client } = useHive();
  const desktop = client.desktop!;
  const [tick, setTick] = useState(0);
  const profiles = useQuery(() => desktop.profiles(), [desktop, tick]);
  const settings = useQuery(() => desktop.settings(), [desktop]);
  const requests = useQuery(() => desktop.hubRequests(), [desktop]);
  const templates = requests.data?.policy?.profileTemplates ?? [];
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
    <Page>
      <PageHeader
        title="Gói sub & agent"
        subtitle="Mỗi profile là một gói sub (một tài khoản CLI). Runner chọn theo ưu tiên, xoay vòng các gói cùng mức, và cho gói nghỉ đến giờ reset khi hết quota."
      />
      {settings.data ? <RunnerCard runner={settings.data.runner} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Thêm profile:</span>
        {AGENT_KINDS.map((k) => (
          <Button key={k} size="sm" variant="outline" onClick={() => newProfile(k)}>
            + {KIND_LABEL[k]}
          </Button>
        ))}
      </div>
      {templates.length ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Mẫu của team (từ hub):</span>
          {templates.map((t) => {
            const exists = (profiles.data ?? []).some((p) => p.id === t.id);
            return (
              <Button
                key={t.id}
                size="sm"
                variant="outline"
                disabled={exists}
                title={exists ? "Máy này đã có profile cùng id" : "Mở form với mẫu này; thêm env (thư mục đăng nhập) của máy bạn rồi lưu"}
                onClick={() => setEditing({ profile: { ...t, env: {} } })}
              >
                + {t.label}
              </Button>
            );
          })}
        </div>
      ) : null}
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
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {profiles.data?.map((p) => (
          <ProfileCard key={p.id} profile={p} onEdit={() => setEditing({ profile: p, previousId: p.id })} onChanged={refresh} />
        ))}
      </div>
    </Page>
  );
}

function ProfileCard({ profile: p, onEdit, onChanged }: { profile: AgentProfileStatus; onEdit: () => void; onChanged: () => void }) {
  const { client } = useHive();
  const desktop = client.desktop!;
  const action = useAction();
  const [check, setCheck] = useState<ProfileCheck | null>(null);
  const resting = p.cooldownUntil !== null;
  const { cooldownUntil: _c, cooldownReason: _r, cooldownFrom: _f, cliPath: _p, running: _n, lastUsedAt: _l, stats: _s, ...plain } = p;
  const noCli = p.enabled && p.cliPath === null;

  return (
    <Card className={cn("min-w-0 gap-3 py-4", p.enabled ? "" : "opacity-65")}>
      <CardContent className="flex flex-col gap-3 px-4">
        <div className="flex items-center gap-2">
          <StatusDot tone={!p.enabled ? "neutral" : noCli ? "danger" : resting ? "warn" : p.running ? "info" : "ok"} />
          <b className="min-w-0 flex-1 truncate font-semibold">{p.label}</b>
          <Badge tone="accent">{KIND_LABEL[p.kind]}</Badge>
        </div>
        <div className="font-mono text-xs wrap-anywhere text-muted-foreground">
          {p.id} · ưu tiên {p.priority} · tối đa {p.maxConcurrent} song song
          {p.account ? ` · tài khoản ${p.account}` : ""}
        </div>
        <div className="text-sm">
          {!p.enabled ? (
            <span className="text-muted-foreground">Đang tắt</span>
          ) : noCli ? (
            <span className="text-destructive">
              Chưa có lệnh <code className={CODE}>{p.bin}</code> trên máy này. Cài ở{" "}
              <a href="#/setup" className="underline underline-offset-2">
                Cài đặt máy
              </a>
              , runner sẽ bỏ qua gói này khi chưa có.
            </span>
          ) : resting ? (
            <span className="text-warning">
              Nghỉ đến {formatTime(p.cooldownUntil)}
              {p.cooldownFrom ? ` · báo từ ${p.cooldownFrom}` : ""}
              {p.cooldownReason ? ` · ${p.cooldownReason}` : ""}
            </span>
          ) : p.running ? (
            <span className="text-info">Đang chạy {p.running} run</span>
          ) : (
            <span className="text-success">Sẵn sàng</span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          <span>{p.stats.runs} lượt</span>
          <span>· {p.stats.succeeded} xong</span>
          <span>· {p.stats.rateLimited} hết quota</span>
          <span>· {p.stats.failed} lỗi</span>
          {p.lastUsedAt ? <span>· dùng {formatTime(p.lastUsedAt)}</span> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {p.roles.map((r) => (
            <Badge key={r}>{ROLE_LABEL[r]}</Badge>
          ))}
        </div>
        <code className="block overflow-x-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs whitespace-nowrap">
          {Object.entries(p.env)
            .map(([k, v]) => `${k}=${v} `)
            .join("")}
          {p.bin} {p.args.join(" ")}
        </code>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={action.busy}
            onClick={() => void action.run(async () => (await desktop.saveProfile({ ...plain, enabled: !p.enabled }, p.id), onChanged()))}
          >
            {p.enabled ? "Tắt" : "Bật"}
          </Button>
          <Button size="sm" variant="outline" disabled={action.busy} onClick={() => void action.run(async () => setCheck(await desktop.checkProfile(p.id)))}>
            Kiểm tra CLI
          </Button>
          {resting ? (
            <Button
              size="sm"
              variant="outline"
              disabled={action.busy}
              onClick={() => void action.run(async () => (await desktop.resetCooldown(p.id), onChanged()))}
            >
              Hết nghỉ
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onEdit}>
            Sửa
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={action.busy}
            onClick={() => {
              if (window.confirm(`Xoá profile ${p.id}? Lịch sử run vẫn giữ.`)) void action.run(async () => (await desktop.removeProfile(p.id), onChanged()));
            }}
          >
            Xoá
          </Button>
        </div>
        {check ? (
          <Notice tone={check.ok ? "ok" : "error"}>
            {check.path ? <div className="max-w-full font-mono text-xs break-all">{check.path}</div> : null}
            <div className="max-w-full font-mono text-xs whitespace-pre-wrap wrap-anywhere">{check.output || (check.ok ? "OK" : "Lỗi")}</div>
          </Notice>
        ) : null}
        <ErrorNote error={action.error} />
      </CardContent>
    </Card>
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
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{previousId ? `Sửa ${previousId}` : "Profile mới"}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid items-center gap-3 sm:grid-cols-[180px_1fr]">
            <Label htmlFor="pf-id">Id</Label>
            <Input id="pf-id" className="font-mono" value={p.id} onChange={(e) => set("id", e.target.value)} />
            <Label htmlFor="pf-label">Tên</Label>
            <Input id="pf-label" value={p.label} onChange={(e) => set("label", e.target.value)} />
            <Label htmlFor="pf-kind">Loại</Label>
            <NativeSelect id="pf-kind" value={p.kind} onChange={(e) => set("kind", e.target.value as AgentKind)}>
              {AGENT_KINDS.map((k) => (
                <NativeSelectOption key={k} value={k}>
                  {KIND_LABEL[k]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Label htmlFor="pf-bin">Lệnh</Label>
            <Input id="pf-bin" className="font-mono" placeholder="claude hoặc /đường/dẫn/tuyệt/đối" value={p.bin} onChange={(e) => set("bin", e.target.value)} />
            <Label htmlFor="pf-args" className="leading-snug sm:self-start sm:pt-2.5">
              Tham số (mỗi dòng một)
            </Label>
            <Textarea id="pf-args" className="font-mono" value={argsText} onChange={(e) => setArgsText(e.target.value)} />
            <span className={HINT}>
              <code className={CODE}>{"{prompt}"}</code> được thay bằng prompt của task (không có thì prompt đi qua stdin). Có thêm{" "}
              <code className={CODE}>{"{worktree}"}</code>, <code className={CODE}>{"{task}"}</code>, <code className={CODE}>{"{project}"}</code>,{" "}
              <code className={CODE}>{"{branch}"}</code>. Cờ CLI đổi theo phiên bản: kiểm tra bằng <code className={CODE}>--help</code>.
            </span>
            <Label htmlFor="pf-env" className="leading-snug sm:self-start sm:pt-2.5">
              Biến môi trường
            </Label>
            <Textarea
              id="pf-env"
              className="font-mono"
              placeholder={ACCOUNT_ENV_HINT[p.kind] ?? "KEY=value"}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
            />
            <span className={HINT}>
              Gói thứ hai của cùng vendor: trỏ CLI sang thư mục đăng nhập khác
              {ACCOUNT_ENV_HINT[p.kind] ? (
                <>
                  , ví dụ <code className={CODE}>{ACCOUNT_ENV_HINT[p.kind]}</code>
                </>
              ) : null}
              , rồi đăng nhập một lần trong terminal với biến đó.
            </span>
            <Label htmlFor="pf-account" className="leading-snug">
              Tài khoản (dùng chung quota)
            </Label>
            <Input
              id="pf-account"
              className="font-mono"
              placeholder="claude-max-duy"
              value={p.account ?? ""}
              onChange={(e) => set("account", e.target.value.trim() || undefined)}
            />
            <span className={HINT}>
              Ở chế độ hub: mọi máy có profile cùng tài khoản sẽ cùng nghỉ khi một máy báo hết quota. Để trống nếu gói này chỉ đăng nhập trên máy này.
            </span>
            <Label>Vai trò</Label>
            <div className="flex flex-wrap items-center gap-4">
              {AGENT_ROLES.map((r) => (
                <label key={r} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={p.roles.includes(r)}
                    onCheckedChange={(v) => set("roles", v === true ? [...p.roles, r] : p.roles.filter((x: AgentRole) => x !== r))}
                  />
                  {ROLE_LABEL[r]}
                </label>
              ))}
            </div>
            <Label htmlFor="pf-priority">Ưu tiên</Label>
            <Input
              id="pf-priority"
              className="sm:max-w-40"
              type="number"
              min={0}
              max={100}
              value={p.priority}
              onChange={(e) => set("priority", num(e.target.value, p.priority))}
            />
            <Label htmlFor="pf-conc">Song song tối đa</Label>
            <Input
              id="pf-conc"
              className="sm:max-w-40"
              type="number"
              min={1}
              max={8}
              value={p.maxConcurrent}
              onChange={(e) => set("maxConcurrent", num(e.target.value, p.maxConcurrent))}
            />
            <Label htmlFor="pf-cool">Nghỉ mặc định (phút)</Label>
            <Input
              id="pf-cool"
              className="sm:max-w-40"
              type="number"
              min={1}
              value={p.cooldownMinutes}
              onChange={(e) => set("cooldownMinutes", num(e.target.value, p.cooldownMinutes))}
            />
            <Label htmlFor="pf-timeout">Giới hạn mỗi run (phút)</Label>
            <Input
              id="pf-timeout"
              className="sm:max-w-40"
              type="number"
              min={1}
              value={p.timeoutMinutes}
              onChange={(e) => set("timeoutMinutes", num(e.target.value, p.timeoutMinutes))}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={p.enabled} onCheckedChange={(v) => set("enabled", v === true)} />
            Bật
          </label>
          <ErrorNote error={error} />
          <ErrorNote error={action.error} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={action.busy}>
              Lưu profile
            </Button>
            <Button variant="ghost" type="button" onClick={onCancel}>
              Huỷ
            </Button>
          </div>
        </CardContent>
      </Card>
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
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Runner</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-2">
            <Label htmlFor="rn-par" className="leading-snug">
              Agent chạy song song
            </Label>
            <Input id="rn-par" className="w-20" type="number" min={1} max={8} value={maxParallel} onChange={(e) => setMaxParallel(e.target.value)} />
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="rn-att" className="leading-snug">
              Số lần thử mỗi task (tính cả xoay vòng)
            </Label>
            <Input id="rn-att" className="w-20" type="number" min={1} max={6} value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)} />
          </div>
        </div>
        <div className="grid items-center gap-3 sm:grid-cols-[180px_1fr]">
          <Label htmlFor="rn-root">Thư mục worktree</Label>
          <Input id="rn-root" className="font-mono" placeholder="~/.xdev-hive/worktrees (mặc định)" value={root} onChange={(e) => setRoot(e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
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
          </Button>
          {saved ? <span className="text-sm text-success">Đã lưu</span> : null}
        </div>
        <ErrorNote error={action.error} />
      </CardContent>
    </Card>
  );
}
