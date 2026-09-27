import { useEffect, useState } from "react";
import { PROJECT_NAME, type DesktopProject, type DesktopSettings, type FileAction, type GitLabCheck, type MrSettings, type SyncReport } from "@xdev-hive/core";
import { Badge, Empty, ErrorNote, PageHeader } from "../components/ui.tsx";
import { useAction, useHive, useQuery } from "../hooks.ts";

const ACTION_TONE: Record<FileAction["action"], string> = {
  created: "ok",
  updated: "info",
  unchanged: "neutral",
  skipped: "warn",
};

export function ProjectsPage() {
  const { client } = useHive();
  const desktop = client.desktop!;
  const settings = useQuery(() => desktop.settings(), [desktop]);

  return (
    <div className="page">
      <PageHeader
        title="Dự án & cài đặt"
        subtitle="Nối repo trên máy này với Hive: đồng bộ tài liệu vào repo, cài MCP cho Claude Code, Codex, Gemini."
      />
      <ErrorNote error={settings.error} />
      {settings.data ? (
        <>
          <ModeCard settings={settings.data} onSaved={settings.reload} />
          <GitLabCard settings={settings.data} onSaved={settings.reload} />
          <ShimCard />
          <ProjectsCard settings={settings.data} onChanged={settings.reload} />
        </>
      ) : null}
    </div>
  );
}

function ModeCard({ settings, onSaved }: { settings: DesktopSettings; onSaved: () => void }) {
  const { client } = useHive();
  const [mode, setMode] = useState(settings.mode);
  const [hubUrl, setHubUrl] = useState(settings.hubUrl);
  const [hubToken, setHubToken] = useState("");
  const [approval, setApproval] = useState(settings.memoryRequiresApproval);
  const [autoCommit, setAutoCommit] = useState(settings.autoCommit);
  const action = useAction();
  const [saved, setSaved] = useState(false);

  useEffect(() => setSaved(false), [mode, hubUrl, hubToken, approval, autoCommit]);

  return (
    <section className="card">
      <h2>Nguồn dữ liệu</h2>
      <div className="segmented" role="group" aria-label="Chế độ">
        <button className={mode === "local" ? "active" : ""} onClick={() => setMode("local")}>
          Cục bộ (một máy)
        </button>
        <button className={mode === "hub" ? "active" : ""} onClick={() => setMode("hub")}>
          Hub dùng chung (team)
        </button>
      </div>
      {mode === "local" ? (
        <p className="muted small">
          Dữ liệu nằm trong <code>{settings.dbPath}</code>. Mọi agent trên máy này đọc chung file đó.
        </p>
      ) : (
        <div className="form-grid">
          <label className="label" htmlFor="hub-url">
            URL hub
          </label>
          <input id="hub-url" className="input mono" placeholder="https://hive.example.com" value={hubUrl} onChange={(e) => setHubUrl(e.target.value)} />
          <label className="label" htmlFor="hub-token">
            Token
          </label>
          <input
            id="hub-token"
            className="input mono"
            type="password"
            autoComplete="off"
            placeholder={settings.hasHubToken ? "Đã lưu. Để trống để giữ nguyên" : "hive_…"}
            value={hubToken}
            onChange={(e) => setHubToken(e.target.value)}
          />
          <span className="label">Tên máy</span>
          <span className="muted small">
            <code>{settings.machine}</code>. Agent trên máy này giữ task với tên <code>&lt;gói&gt;.{settings.machine}</code>. Hai máy dùng chung
            token phải khác tên máy (sửa <code>machine</code> trong <code>{settings.configPath}</code>).
          </span>
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={approval} onChange={(e) => setApproval(e.target.checked)} disabled={mode === "hub"} />
        Memory do agent ghi phải được duyệt mới hiện cho agent khác {mode === "hub" ? "(hub tự cấu hình)" : ""}
      </label>
      <label className="check">
        <input type="checkbox" checked={autoCommit} onChange={(e) => setAutoCommit(e.target.checked)} />
        Tự commit khi đồng bộ tài liệu vào repo (chỉ commit các file tài liệu, không push)
      </label>
      <div className="row gap-s">
        <button
          className="btn btn-primary"
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
        </button>
        <span className="muted small mono">{settings.configPath}</span>
      </div>
      <ErrorNote error={action.error} />
      {saved ? <div className="note note-ok">Đã lưu. Agent sẽ dùng cấu hình mới từ phiên kế tiếp.</div> : null}
    </section>
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
    <section className="card">
      <h2>GitLab merge request</h2>
      <p className="muted small">
        Khi task xong, app push branch <code>ai/&lt;task&gt;</code> lên remote rồi tạo hoặc cập nhật MR. Output của agent được bọc trong code block nên
        không kích hoạt quick action (<code>/merge</code>…) hay mention.
      </p>
      <div className="form-grid">
        <label className="label" htmlFor="gl-url">URL GitLab</label>
        <input id="gl-url" className="input mono" placeholder="https://gitlab.example.com" value={url} onChange={(e) => (setSaved(false), setUrl(e.target.value))} />
        <label className="label" htmlFor="gl-token">Access token</label>
        <input
          id="gl-token"
          className="input mono"
          type="password"
          autoComplete="off"
          placeholder={g.hasToken ? "Đã lưu. Để trống để giữ nguyên" : "glpat-… (scope api, write_repository)"}
          value={token}
          onChange={(e) => (setSaved(false), setToken(e.target.value))}
        />
      </div>
      <label className="check">
        <input type="checkbox" checked={mr.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        Tự tạo MR
      </label>
      <div className="form-grid">
        <label className="label" htmlFor="gl-when">Khi nào</label>
        <select id="gl-when" className="input" value={mr.when} onChange={(e) => set("when", e.target.value as MrSettings["when"])}>
          <option value="after_review">Sau khi review chéo xong</option>
          <option value="after_success">Ngay khi agent làm xong (nếu không có review)</option>
        </select>
        <label className="label" htmlFor="gl-changes">Review yêu cầu sửa</label>
        <select
          id="gl-changes"
          className="input"
          value={mr.onChangesRequested}
          onChange={(e) => set("onChangesRequested", e.target.value as MrSettings["onChangesRequested"])}
        >
          <option value="draft">Vẫn tạo, để ở dạng Draft</option>
          <option value="skip">Chưa tạo MR</option>
        </select>
        <label className="label" htmlFor="gl-labels">Label</label>
        <input id="gl-labels" className="input" value={labels} onChange={(e) => (setSaved(false), setLabels(e.target.value))} />
        <label className="label" htmlFor="gl-remote">Remote</label>
        <input id="gl-remote" className="input mono" value={mr.remote} onChange={(e) => set("remote", e.target.value)} />
      </div>
      <label className="check">
        <input type="checkbox" checked={mr.removeSourceBranch} onChange={(e) => set("removeSourceBranch", e.target.checked)} />
        Xoá branch nguồn khi merge
      </label>
      <div className="row gap-s">
        <button className="btn btn-primary" onClick={() => void save()} disabled={action.busy}>
          Lưu
        </button>
        <button className="btn" disabled={action.busy || (!g.hasToken && !token)} onClick={() => void action.run(async () => setCheck(await client.desktop!.checkGitLab()))}>
          Kiểm tra kết nối
        </button>
        {saved ? <span className="tone-ok small">Đã lưu</span> : null}
      </div>
      {check ? <div className={`note ${check.ok ? "note-ok" : "note-error"}`}>{check.message}</div> : null}
      <ErrorNote error={action.error} />
    </section>
  );
}

function ProjectGitLab({ project, onSaved }: { project: DesktopProject; onSaved: () => void }) {
  const { client } = useHive();
  const [gitlabProject, setGitlabProject] = useState(project.gitlabProject ?? "");
  const [targetBranch, setTargetBranch] = useState(project.targetBranch ?? "");
  const action = useAction();
  return (
    <form
      className="row gap-s wrap project-gitlab"
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          await client.desktop!.updateProject(project.name, { gitlabProject: gitlabProject || null, targetBranch: targetBranch || null });
          onSaved();
        });
      }}
    >
      <input
        className="input mono grow"
        placeholder="GitLab project: tự đọc từ remote (hoặc group/project)"
        value={gitlabProject}
        onChange={(e) => setGitlabProject(e.target.value)}
        aria-label={`GitLab project của ${project.name}`}
      />
      <input
        className="input mono"
        style={{ width: 200 }}
        placeholder="target: default branch"
        value={targetBranch}
        onChange={(e) => setTargetBranch(e.target.value)}
        aria-label={`Target branch của ${project.name}`}
      />
      <button className="btn btn-small" type="submit" disabled={action.busy}>
        Lưu
      </button>
      <ErrorNote error={action.error} />
    </form>
  );
}

function ShimCard() {
  const { client } = useHive();
  const action = useAction();
  const [report, setReport] = useState<{ path: string; onPath: boolean } | null>(null);
  return (
    <section className="card">
      <h2>Lệnh hive-mcp</h2>
      <p className="muted small">
        Agent gọi lệnh <code>hive-mcp</code> để nói chuyện với Hive qua MCP. Lệnh này chạy bằng chính app, máy không cần cài Node.
      </p>
      <button className="btn" disabled={action.busy} onClick={() => void action.run(async () => setReport(await client.desktop!.installShim()))}>
        Cài / cập nhật lệnh hive-mcp
      </button>
      <ErrorNote error={action.error} />
      {report ? (
        <div className={`note ${report.onPath ? "note-ok" : "note-warn"}`}>
          Đã cài vào <code>{report.path}</code>.
          {report.onPath
            ? null
            : " Thư mục này chưa có trong PATH của app. Kiểm tra lại PATH của shell (ví dụ thêm export PATH=\"$HOME/.local/bin:$PATH\" vào ~/.zshrc)."}
        </div>
      ) : null}
    </section>
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
    <section className="card">
      <h2>Dự án trên máy này</h2>
      {settings.projects.length === 0 ? <Empty>Chưa có dự án. Thêm repo bên dưới.</Empty> : null}
      <div className="stack">
        {settings.projects.map((p) => (
          <div key={p.name} className="project-row">
            <div className="grow">
              <div className="mono">{p.name}</div>
              <div className="muted small mono">{p.repo}</div>
            </div>
            <button
              className="btn btn-small"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  showSync(await desktop.syncProject(p.name));
                  bump();
                })
              }
            >
              Đồng bộ tài liệu
            </button>
            <button
              className="btn btn-small"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () =>
                  setResult({ project: p.name, title: "Cài vào agents", files: await desktop.installAgents(p.name) }),
                )
              }
            >
              Cài vào agents
            </button>
            <button className="btn btn-small btn-ghost" onClick={() => setGitlabOpen(gitlabOpen === p.name ? null : p.name)} aria-expanded={gitlabOpen === p.name}>
              GitLab
            </button>
            <button className="btn btn-small btn-ghost" onClick={() => void desktop.showInFolder(p.repo)}>
              Mở
            </button>
            <button
              className="btn btn-small btn-ghost"
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
            </button>
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
      <form
        className="row gap-s wrap add-project"
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
        <input
          className="input mono"
          style={{ width: 180 }}
          placeholder="project key"
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase())}
          aria-label="Project key"
          aria-invalid={name.length > 0 && !nameValid}
        />
        <input className="input mono grow" placeholder="/đường/dẫn/tới/repo" value={repo} onChange={(e) => setRepo(e.target.value)} aria-label="Thư mục repo" />
        <button
          type="button"
          className="btn"
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
        </button>
        <button className="btn btn-primary" type="submit" disabled={!nameValid || !repo || action.busy}>
          Thêm dự án
        </button>
      </form>
      <ErrorNote error={action.error} />
      {result ? (
        <div className="report">
          <div className="row gap-s">
            <b>{result.title}</b>
            <span className="mono small">{result.project}</span>
            <button className="btn btn-small btn-ghost" onClick={() => setResult(null)}>
              Đóng
            </button>
          </div>
          <ul>
            {result.files.map((f) => (
              <li key={f.file}>
                <Badge tone={ACTION_TONE[f.action]}>{f.action}</Badge> <span className="mono small">{f.file}</span>
                {f.note ? <span className="muted small"> · {f.note}</span> : null}
              </li>
            ))}
          </ul>
          {result.extra ? <div className="muted small">{result.extra}</div> : null}
        </div>
      ) : null}
    </section>
  );
}
