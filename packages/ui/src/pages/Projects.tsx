import { useEffect, useState } from "react";
import {
  PROJECT_NAME,
  TRANSFER_RESULTS,
  type DesktopProject,
  type DesktopSettings,
  type FileAction,
  type GitLabCheck,
  type MrSettings,
  type SyncReport,
  type TransferReport,
  type TransferResult,
} from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { ToggleGroup, ToggleGroupItem } from "@xdev-hive/ui/components/ui/toggle-group";
import { Badge, Empty, ErrorNote, Notice, Page, PageHeader } from "../components/common.tsx";
import { useAction, useHive, useQuery } from "../hooks.ts";

const ACTION_TONE: Record<FileAction["action"], string> = {
  created: "ok",
  updated: "info",
  unchanged: "neutral",
  skipped: "warn",
};

/** Inline code (paths, keys) inside explanatory text. */
const CODE = "rounded bg-muted px-1 py-0.5 font-mono text-xs break-all";
/** Label/field grid; collapses to one column on narrow screens. */
const FORM_GRID = "grid items-center gap-3 sm:grid-cols-[180px_1fr]";
const LINK = "font-medium text-primary underline underline-offset-2";

export function ProjectsPage() {
  const { client } = useHive();
  const desktop = client.desktop!;
  const settings = useQuery(() => desktop.settings(), [desktop]);

  return (
    <Page>
      <PageHeader
        title="Dự án & cài đặt"
        subtitle="Nguồn dữ liệu, GitLab và các repo trên máy này. Kiểm tra và cài CLI, hive-mcp, cấu hình agent ở Cài đặt máy."
      />
      <ErrorNote error={settings.error} />
      {settings.data ? (
        <>
          <ModeCard settings={settings.data} onSaved={settings.reload} />
          <TransferCard settings={settings.data} />
          <GitLabCard settings={settings.data} onSaved={settings.reload} />
          <ProjectsCard settings={settings.data} onChanged={settings.reload} />
        </>
      ) : null}
    </Page>
  );
}

function ModeCard({ settings, onSaved }: { settings: DesktopSettings; onSaved: () => void }) {
  const { client, me, bump } = useHive();
  const [mode, setMode] = useState(settings.mode);
  const [hubUrl, setHubUrl] = useState(settings.hubUrl);
  const [hubToken, setHubToken] = useState("");
  // People sign in with their hub account (the hub issues this machine a token); a pasted token still works.
  const [auth, setAuth] = useState<"account" | "token">("account");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const signIn = useAction();
  const [signedIn, setSignedIn] = useState<string | null>(null);
  const [approval, setApproval] = useState(settings.memoryRequiresApproval);
  const [autoCommit, setAutoCommit] = useState(settings.autoCommit);
  const action = useAction();
  const [saved, setSaved] = useState(false);

  useEffect(() => setSaved(false), [mode, hubUrl, hubToken, approval, autoCommit]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nguồn dữ liệu</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ToggleGroup
          type="single"
          variant="outline"
          className="max-w-full"
          value={mode}
          onValueChange={(v) => {
            if (v) setMode(v as DesktopSettings["mode"]);
          }}
          aria-label="Chế độ"
        >
          <ToggleGroupItem
            value="local"
            className="h-auto min-h-9 shrink py-1.5 whitespace-normal data-[state=on]:bg-brand-soft data-[state=on]:text-brand-soft-foreground"
          >
            Cục bộ (một máy)
          </ToggleGroupItem>
          <ToggleGroupItem
            value="hub"
            className="h-auto min-h-9 shrink py-1.5 whitespace-normal data-[state=on]:bg-brand-soft data-[state=on]:text-brand-soft-foreground"
          >
            Hub dùng chung (team)
          </ToggleGroupItem>
        </ToggleGroup>
        {mode === "local" ? (
          <p className="text-sm break-words text-muted-foreground">
            Dữ liệu nằm trong <code className={CODE}>{settings.dbPath}</code>. Mọi agent trên máy này đọc chung file đó.
          </p>
        ) : (
          <div className={FORM_GRID}>
            <Label htmlFor="hub-url">URL hub</Label>
            <Input id="hub-url" className="font-mono" placeholder="https://hive.example.com" value={hubUrl} onChange={(e) => setHubUrl(e.target.value)} />
            <span className="text-sm leading-none font-medium">Đăng nhập</span>
            <div className="flex min-w-0 flex-col gap-3">
              {settings.mode === "hub" && settings.hasHubToken ? (
                <p className="text-sm text-muted-foreground">
                  {me.user ? (
                    <>
                      Máy này đang dùng tài khoản <b className="text-foreground">@{me.user.username}</b>: agent trên máy thấy đúng các dự án của tài khoản đó.
                    </>
                  ) : (
                    <>Máy này đang dùng một token không thuộc tài khoản nào ({me.name}).</>
                  )}
                </p>
              ) : null}
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                className="w-fit"
                value={auth}
                onValueChange={(v) => v && setAuth(v as "account" | "token")}
                aria-label="Cách đăng nhập hub"
              >
                <ToggleGroupItem value="account" className="px-3 data-[state=on]:bg-brand-soft data-[state=on]:text-brand-soft-foreground">
                  Tài khoản
                </ToggleGroupItem>
                <ToggleGroupItem value="token" className="px-3 data-[state=on]:bg-brand-soft data-[state=on]:text-brand-soft-foreground">
                  Dán token
                </ToggleGroupItem>
              </ToggleGroup>
              {auth === "account" ? (
                <form
                  className="flex flex-wrap items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void signIn.run(async () => {
                      await client.desktop!.hubSignIn({ hubUrl, username: username.trim(), password });
                      setSignedIn(username.trim().toLowerCase());
                      setPassword("");
                      setMode("hub");
                      onSaved();
                      bump();
                    });
                  }}
                >
                  <Input
                    className="min-w-36 flex-1"
                    placeholder="Tên đăng nhập"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    aria-label="Tên đăng nhập hub"
                  />
                  <Input
                    className="min-w-36 flex-1"
                    type="password"
                    placeholder="Mật khẩu"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    aria-label="Mật khẩu hub"
                  />
                  <Button type="submit" variant="outline" disabled={!hubUrl.trim() || !username.trim() || !password || signIn.busy}>
                    {signIn.busy ? "Đang đăng nhập…" : "Đăng nhập & kết nối"}
                  </Button>
                  <p className="w-full text-xs text-muted-foreground">
                    Mật khẩu không lưu trên máy: hub cấp cho máy <code className={CODE}>{settings.machine}</code> một token thuộc tài khoản của bạn. Đăng nhập lại thì token cũ của máy
                    này bị thay. Tài khoản mới: đăng nhập hub trên trình duyệt một lần để đổi mật khẩu tạm trước.
                  </p>
                  <ErrorNote error={signIn.error} />
                  {signedIn && !signIn.error ? <Notice tone="ok">Đã kết nối hub bằng tài khoản @{signedIn}.</Notice> : null}
                </form>
              ) : (
                <Input
                  id="hub-token"
                  className="font-mono"
                  type="password"
                  autoComplete="off"
                  placeholder={settings.hasHubToken ? "Đã lưu. Để trống để giữ nguyên" : "hive_…"}
                  value={hubToken}
                  onChange={(e) => setHubToken(e.target.value)}
                  aria-label="Token hub"
                />
              )}
            </div>
            <span className="text-sm leading-none font-medium">Tên máy</span>
            <p className="text-sm break-words text-muted-foreground">
              <code className={CODE}>{settings.machine}</code>. Agent trên máy này giữ task với tên <code className={CODE}>&lt;gói&gt;.{settings.machine}</code>. Hai
              máy dùng chung token phải khác tên máy (sửa <code className={CODE}>machine</code> trong <code className={CODE}>{settings.configPath}</code>).
            </p>
          </div>
        )}
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={approval} onCheckedChange={(v) => setApproval(v === true)} disabled={mode === "hub"} />
          Memory do agent ghi phải được duyệt mới hiện cho agent khác {mode === "hub" ? "(hub tự cấu hình)" : ""}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={autoCommit} onCheckedChange={(v) => setAutoCommit(v === true)} />
          Tự commit khi đồng bộ tài liệu vào repo (chỉ commit các file tài liệu, không push)
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await client.desktop!.updateSettings({ mode, hubUrl, hubToken, memoryRequiresApproval: approval, autoCommit });
                setHubToken("");
                setSaved(true);
                onSaved();
              })
            }
          >
            Lưu cài đặt
          </Button>
          <span className="min-w-0 font-mono text-xs break-all text-muted-foreground">{settings.configPath}</span>
        </div>
        <ErrorNote error={action.error} />
        {saved ? <Notice tone="ok">Đã lưu. Agent sẽ dùng cấu hình mới từ phiên kế tiếp.</Notice> : null}
      </CardContent>
    </Card>
  );
}

const RESULT: Record<TransferResult, { label: string; tone: string }> = {
  added: { label: "thêm", tone: "ok" },
  updated: { label: "version mới", tone: "info" },
  proposed: { label: "đề xuất", tone: "warn" },
  unchanged: { label: "không đổi", tone: "neutral" },
  skipped: { label: "bỏ qua", tone: "neutral" },
  failed: { label: "lỗi", tone: "danger" },
};
const KIND = { doc: "Tài liệu", memory: "Memory", task: "Task" } as const;

function TransferCard({ settings }: { settings: DesktopSettings }) {
  const { client, bump } = useHive();
  const action = useAction();
  const [report, setReport] = useState<TransferReport | null>(null);
  const [showAll, setShowAll] = useState(false);
  const ready = Boolean(settings.hubUrl && settings.hasHubToken);
  const run = (direction: "push" | "pull", question: string) => {
    if (!window.confirm(question)) return;
    void action.run(async () => {
      setReport(await client.desktop!.transferHub(direction));
      setShowAll(false);
      bump();
    });
  };
  const rows = report ? report.items.filter((i) => showAll || i.result !== "unchanged") : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Dữ liệu dùng chung với hub</CardTitle>
        <CardDescription className="break-words">
          Ở chế độ <b>Hub dùng chung</b>, app và agent đọc, ghi thẳng lên hub nên không cần đồng bộ. Hai nút dưới đây chép <b>một lần</b> giữa
          database trên máy (<code className={CODE}>{settings.dbPath}</code>) và hub: tài liệu (bản mới nhất), memory đã duyệt, task.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>
            <b>Đẩy lên hub</b>: mục chưa có trên hub thì thêm. Tài liệu khác bản trên hub thành đề xuất chờ admin duyệt, không ghi đè.
          </li>
          <li>
            <b>Tải về máy</b>: mục chưa có trên máy thì thêm. Tài liệu khác thì ghi thành version mới, bản cũ vẫn trong lịch sử.
          </li>
          <li>Không chuyển: lịch sử version, đề xuất, memory chưa duyệt, người đang giữ task (task đang làm thành Chưa làm).</li>
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={!ready || action.busy}
            onClick={() => run("push", `Đẩy tài liệu, memory và task trên máy này lên ${settings.hubUrl}? Tài liệu khác bản trên hub sẽ thành đề xuất.`)}
          >
            Đẩy dữ liệu máy lên hub
          </Button>
          <Button
            variant="outline"
            disabled={!ready || action.busy}
            onClick={() => run("pull", `Tải tài liệu, memory và task từ ${settings.hubUrl} về database trên máy này?`)}
          >
            Tải dữ liệu hub về máy
          </Button>
          {action.busy ? <span className="text-sm text-muted-foreground">Đang chuyển…</span> : null}
        </div>
        {!ready ? <p className="text-sm text-muted-foreground">Điền URL và token hub ở Nguồn dữ liệu rồi bấm Lưu cài đặt.</p> : null}
        <ErrorNote error={action.error} />
        {report ? (
          <div className="flex flex-col gap-3 rounded-lg bg-muted/50 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium break-all">
                {report.from} → {report.to}
              </span>
              {TRANSFER_RESULTS.filter((r) => report.counts[r] > 0).map((r) => (
                <Badge key={r} tone={RESULT[r].tone}>
                  {report.counts[r]} {RESULT[r].label}
                </Badge>
              ))}
              <div className="ml-auto flex flex-wrap items-center gap-1">
                {report.counts.unchanged > 0 ? (
                  <Button size="sm" variant="ghost" onClick={() => setShowAll(!showAll)}>
                    {showAll ? "Ẩn mục không đổi" : "Hiện cả mục không đổi"}
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => setReport(null)}>
                  Đóng
                </Button>
              </div>
            </div>
            {rows.length ? (
              <ul className="flex flex-col gap-1">
                {rows.map((i) => (
                  <li key={`${i.kind}:${i.key}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Badge tone={RESULT[i.result].tone}>{RESULT[i.result].label}</Badge>
                    <span className="text-xs">{KIND[i.kind]}</span>
                    <span className="min-w-0 font-mono text-xs break-all">{i.key}</span>
                    {i.note ? <span className="min-w-0 text-xs break-words text-muted-foreground">· {i.note}</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">Không có gì mới để chuyển.</p>
            )}
            {report.counts.proposed > 0 ? (
              <p className="text-xs text-muted-foreground">
                Đề xuất nằm ở trang{" "}
                <a href="#/proposals" className={LINK}>
                  Đề xuất
                </a>
                {report.to === "hub" ? " trên hub" : ""}, cần admin duyệt.
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function GitLabCard({ settings, onSaved }: { settings: DesktopSettings; onSaved: () => void }) {
  const { client } = useHive();
  const g = settings.gitlab;
  const [url, setUrl] = useState(g.url);
  const [token, setToken] = useState("");
  const [mr, setMr] = useState<MrSettings>(g.mr);
  const [labels, setLabels] = useState(g.mr.labels.join(", "));
  const [check, setCheck] = useState<GitLabCheck | null>(null);
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const set = <K extends keyof MrSettings>(k: K, v: MrSettings[K]) => {
    setSaved(false);
    setMr({ ...mr, [k]: v });
  };

  const save = () =>
    action.run(async () => {
      await client.desktop!.updateSettings({
        gitlab: { url, token, mr: { ...mr, labels: labels.split(",").map((l) => l.trim()).filter(Boolean) } },
      });
      setToken("");
      setSaved(true);
      onSaved();
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>GitLab merge request</CardTitle>
        <CardDescription className="break-words">
          Khi task xong, app push branch <code className={CODE}>ai/&lt;task&gt;</code> lên remote rồi tạo hoặc cập nhật MR. Output của agent được bọc trong code
          block nên không kích hoạt quick action (<code className={CODE}>/merge</code>…) hay mention.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className={FORM_GRID}>
          <Label htmlFor="gl-url">URL GitLab</Label>
          <Input id="gl-url" className="font-mono" placeholder="https://gitlab.example.com" value={url} onChange={(e) => (setSaved(false), setUrl(e.target.value))} />
          <Label htmlFor="gl-token">Access token</Label>
          <Input
            id="gl-token"
            className="font-mono"
            type="password"
            autoComplete="off"
            placeholder={g.hasToken ? "Đã lưu. Để trống để giữ nguyên" : "glpat-… (scope api, write_repository)"}
            value={token}
            onChange={(e) => (setSaved(false), setToken(e.target.value))}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={mr.enabled} onCheckedChange={(v) => set("enabled", v === true)} />
          Tự tạo MR
        </label>
        <div className={FORM_GRID}>
          <Label htmlFor="gl-when">Khi nào</Label>
          <NativeSelect id="gl-when" value={mr.when} onChange={(e) => set("when", e.target.value as MrSettings["when"])}>
            <NativeSelectOption value="after_review">Sau khi review chéo xong</NativeSelectOption>
            <NativeSelectOption value="after_success">Ngay khi agent làm xong (nếu không có review)</NativeSelectOption>
          </NativeSelect>
          <Label htmlFor="gl-changes">Review yêu cầu sửa</Label>
          <NativeSelect
            id="gl-changes"
            value={mr.onChangesRequested}
            onChange={(e) => set("onChangesRequested", e.target.value as MrSettings["onChangesRequested"])}
          >
            <NativeSelectOption value="draft">Vẫn tạo, để ở dạng Draft</NativeSelectOption>
            <NativeSelectOption value="skip">Chưa tạo MR</NativeSelectOption>
          </NativeSelect>
          <Label htmlFor="gl-labels">Label</Label>
          <Input id="gl-labels" value={labels} onChange={(e) => (setSaved(false), setLabels(e.target.value))} />
          <Label htmlFor="gl-remote">Remote</Label>
          <Input id="gl-remote" className="font-mono" value={mr.remote} onChange={(e) => set("remote", e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={mr.removeSourceBranch} onCheckedChange={(v) => set("removeSourceBranch", v === true)} />
          Xoá branch nguồn khi merge
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void save()} disabled={action.busy}>
            Lưu
          </Button>
          <Button
            variant="outline"
            disabled={action.busy || (!g.hasToken && !token)}
            onClick={() => void action.run(async () => setCheck(await client.desktop!.checkGitLab()))}
          >
            Kiểm tra kết nối
          </Button>
          {saved ? <span className="text-sm text-success">Đã lưu</span> : null}
        </div>
        {check ? (
          <Notice tone={check.ok ? "ok" : "error"} className="whitespace-pre-wrap">
            {check.message}
          </Notice>
        ) : null}
        <ErrorNote error={action.error} />
      </CardContent>
    </Card>
  );
}

function ProjectGitLab({ project, onSaved }: { project: DesktopProject; onSaved: () => void }) {
  const { client } = useHive();
  const [gitlabProject, setGitlabProject] = useState(project.gitlabProject ?? "");
  const [targetBranch, setTargetBranch] = useState(project.targetBranch ?? "");
  const action = useAction();
  return (
    <form
      className="flex flex-wrap items-center gap-2 border-t border-dashed pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          await client.desktop!.updateProject(project.name, { gitlabProject: gitlabProject || null, targetBranch: targetBranch || null });
          onSaved();
        });
      }}
    >
      <Input
        className="min-w-48 flex-[2] font-mono"
        placeholder="GitLab project: tự đọc từ remote (hoặc group/project)"
        value={gitlabProject}
        onChange={(e) => setGitlabProject(e.target.value)}
        aria-label={`GitLab project của ${project.name}`}
      />
      <Input
        className="min-w-40 flex-1 font-mono sm:max-w-52"
        placeholder="target: default branch"
        value={targetBranch}
        onChange={(e) => setTargetBranch(e.target.value)}
        aria-label={`Target branch của ${project.name}`}
      />
      <Button size="sm" variant="outline" type="submit" disabled={action.busy}>
        Lưu
      </Button>
      <ErrorNote error={action.error} />
    </form>
  );
}

function ProjectsCard({ settings, onChanged }: { settings: DesktopSettings; onChanged: () => void }) {
  const { client, bump } = useHive();
  const desktop = client.desktop!;
  const [name, setName] = useState("");
  const [repo, setRepo] = useState("");
  const action = useAction();
  const [result, setResult] = useState<{ project: string; title: string; files: FileAction[]; extra?: string } | null>(null);
  const [gitlabOpen, setGitlabOpen] = useState<string | null>(null);
  const nameValid = PROJECT_NAME.test(name);

  const showSync = (r: SyncReport) =>
    setResult({
      project: r.project,
      title: "Đồng bộ tài liệu",
      files: r.files,
      extra: [
        r.imported.length ? `Đã nhập vào Hive: ${r.imported.join(", ")}` : "",
        r.commit ? `Commit ${r.commit}` : "",
        r.note ?? "",
      ]
        .filter(Boolean)
        .join(" · "),
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Dự án trên máy này</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {settings.projects.length === 0 ? <Empty>Chưa có dự án. Thêm repo bên dưới.</Empty> : null}
        {settings.projects.length ? (
          <div className="flex flex-col gap-2">
            {settings.projects.map((p) => (
              <div key={p.name} className="flex flex-col gap-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <div className="min-w-0 flex-1 basis-48">
                    <div className="font-mono text-sm break-all">{p.name}</div>
                    <div className="font-mono text-xs break-all text-muted-foreground">{p.repo}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          showSync(await desktop.syncProject(p.name));
                          bump();
                        })
                      }
                    >
                      Đồng bộ tài liệu
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <a href="#/setup">Cài đặt</a>
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setGitlabOpen(gitlabOpen === p.name ? null : p.name)} aria-expanded={gitlabOpen === p.name}>
                      GitLab
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void desktop.showInFolder(p.repo)}>
                      Mở
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (window.confirm(`Bỏ ${p.name} khỏi danh sách? Repo và tài liệu trong Hive không bị xoá.`)) {
                          void action.run(async () => {
                            await desktop.removeProject(p.name);
                            onChanged();
                          });
                        }
                      }}
                    >
                      Bỏ
                    </Button>
                  </div>
                </div>
                {gitlabOpen === p.name ? (
                  <ProjectGitLab
                    project={p}
                    onSaved={() => {
                      setGitlabOpen(null);
                      onChanged();
                    }}
                  />
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        <form
          className="flex flex-wrap items-center gap-2 border-t pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await desktop.addProject({ name, repo });
              setName("");
              setRepo("");
              onChanged();
            });
          }}
        >
          <Input
            className="min-w-32 flex-1 font-mono sm:max-w-44"
            placeholder="project key"
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            aria-label="Project key"
            aria-invalid={name.length > 0 && !nameValid}
          />
          <Input
            className="min-w-48 flex-[3] font-mono"
            placeholder="/đường/dẫn/tới/repo"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            aria-label="Thư mục repo"
          />
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              void action.run(async () => {
                const folder = await desktop.pickFolder();
                if (folder) {
                  setRepo(folder);
                  if (!name) setName((folder.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/[^a-z0-9._-]/g, "-"));
                }
              })
            }
          >
            Chọn thư mục…
          </Button>
          <Button type="submit" disabled={!nameValid || !repo || action.busy}>
            Thêm dự án
          </Button>
        </form>
        <ErrorNote error={action.error} />
        {result ? (
          <div className="flex flex-col gap-3 rounded-lg bg-muted/50 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{result.title}</span>
              <span className="min-w-0 font-mono text-xs break-all">{result.project}</span>
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setResult(null)}>
                Đóng
              </Button>
            </div>
            <ul className="flex flex-col gap-1">
              {result.files.map((f) => (
                <li key={f.file} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Badge tone={ACTION_TONE[f.action]}>{f.action}</Badge>
                  <span className="min-w-0 font-mono text-xs break-all">{f.file}</span>
                  {f.note ? <span className="min-w-0 text-xs break-words text-muted-foreground">· {f.note}</span> : null}
                </li>
              ))}
            </ul>
            {result.extra ? <p className="text-xs break-words text-muted-foreground">{result.extra}</p> : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
