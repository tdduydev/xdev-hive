import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { Pill } from "@xdev-hive/ui/pill";
import { Table, TableBody, TableHeader, TableRow, Td, Th } from "@xdev-hive/ui/table";
import { Textarea } from "@xdev-hive/ui/textarea";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ConnectHiveButton } from "@/components/connect-hive.tsx";
import { PickFolderButton } from "@/components/pick-folder-button.tsx";
import { profileOf, useLinkedAccount } from "@/lib/account.ts";
import { useFolder } from "@/lib/folder.ts";
import { type HubProject, hubTool, matchProject } from "@/lib/hub.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { can } from "@/lib/nav.ts";
import {
  CLI_DIRS,
  type DiffLine,
  diffHunks,
  type HubSkillItem,
  hivePackFile,
  type InstalledSkill,
  idleTokens,
  installedSkills,
  installSkills,
  lineDiff,
  offKey,
  proposeSkill,
  removeSkills,
  renderSkillFile,
  type SkillState,
  skillState,
  skillUses,
  type Target,
  useOff,
} from "@/lib/skills.ts";
import { errorText, type WorkspaceMeta, workspaceMeta } from "@/lib/tauri.ts";
import { cn } from "@/lib/utils.ts";

type Tone = "neutral" | "ok" | "warn" | "bad" | "sel";
type ScopeKind = HubSkillItem["scope"] | "local";

const text: Dict<{
  lead: string;
  target: string;
  tProject: string;
  tUser: string;
  sync: (n: number) => string;
  synced: string;
  noFolder: string;
  noAccount: string;
  unmatched: string;
  loading: string;
  search: string;
  allStates: string;
  allScopes: string;
  colSource: string;
  colState: string;
  colVersion: string;
  colIdle: string;
  colUse: string;
  selectAll: string;
  selectRow: (name: string) => string;
  selected: (n: number) => string;
  installUpdate: string;
  disableMe: string;
  enableMe: string;
  propose: string;
  updateTo: (v: number) => string;
  installV: (v: number) => string;
  overwrite: (v: number) => string;
  confirmOverwrite: string;
  whatChanged: string;
  localVsHub: (v: number) => string;
  content: (v: number) => string;
  upToDate: string;
  ctxCost: string;
  usedBy: string;
  usedNote: string;
  page: (from: number, to: number, total: number) => string;
  prev: string;
  next: string;
  empty: string;
  pickRow: string;
  scope: Record<ScopeKind, string>;
  team: (name: string) => string;
  project: (name: string) => string;
  state: Record<SkillState, string>;
  cliSynced: string;
  cliPending: (n: number) => string;
  cliSkipped: string;
  cliCount: (n: number) => string;
  geminiWhere: string;
  installed: (n: number) => string;
  conflicts: (names: string) => string;
  removed: (n: number) => string;
  turnedOff: (n: number) => string;
  proposeNote: string;
  proposeSend: string;
  cancel: string;
  proposed: string;
  ownNote: string;
  goneNote: string;
  shadowNote: string;
}> = {
  vi: {
    lead: "Skill áp cho thư mục này theo phạm vi tổ chức → đội → dự án. App cài vào CLI trên máy để agent của bạn dùng được.",
    target: "Cài vào",
    tProject: "Thư mục dự án (.claude/skills, .agents/skills)",
    tUser: "Tài khoản của tôi (~/.claude/skills, ~/.codex/skills)",
    sync: (n) => `Đồng bộ ${n} bản mới`,
    synced: "Đã đồng bộ",
    noFolder: "Chọn thư mục làm việc ở góc trên bên trái, hoặc cài vào tài khoản của tôi.",
    noAccount: "Kết nối Hive để lấy skill từ hub. Skill đã cài trên máy vẫn dùng được.",
    unmatched: "Thư mục chưa khớp dự án nào trên hub: chỉ hiện skill của tổ chức.",
    loading: "Đang đọc…",
    search: "Tìm skill…",
    allStates: "Mọi trạng thái",
    allScopes: "Mọi nguồn",
    colSource: "Nguồn",
    colState: "Trên máy",
    colVersion: "Bản",
    colIdle: "Token khi chờ",
    colUse: "Tôi dùng",
    selectAll: "Chọn cả trang",
    selectRow: (name) => `Chọn ${name}`,
    selected: (n) => `Đã chọn ${n}`,
    installUpdate: "Cài / cập nhật",
    disableMe: "Tắt với tôi",
    enableMe: "Bật lại",
    propose: "Đề xuất sửa",
    updateTo: (v) => `Cập nhật lên v${v}`,
    installV: (v) => `Cài v${v}`,
    overwrite: (v) => `Ghi đè bằng v${v}`,
    confirmOverwrite: "Bấm lần nữa để bỏ bản sửa trên máy",
    whatChanged: "Thay đổi",
    localVsHub: (v) => `Bản trên máy so với v${v}`,
    content: (v) => `Nội dung · v${v}`,
    upToDate: "Máy đang có bản mới nhất.",
    ctxCost: "Chiếm ngữ cảnh khi chưa dùng",
    usedBy: "Agent của tôi đã gọi, 30 ngày",
    usedNote: "Đếm lần gọi skill trong phiên Claude Code trên máy này.",
    page: (from, to, total) => `${from}–${to} / ${total}`,
    prev: "Trang trước",
    next: "Trang sau",
    empty: "Không có skill nào khớp.",
    pickRow: "Chọn một skill để xem chi tiết.",
    scope: { hive: "Hive mặc định", org: "Tổ chức", team: "Đội", project: "Dự án", local: "Trên máy" },
    team: (name) => `Đội · ${name}`,
    project: (name) => `Dự án · ${name}`,
    state: {
      installed: "Đã cài",
      update: "Có bản mới",
      missing: "Chưa cài",
      off: "Tôi đã tắt",
      modified: "Đã sửa trên máy",
      own: "Tự thêm",
      shadowed: "Bị bản hẹp hơn che",
      gone: "Hub đã xoá",
    },
    cliSynced: "Đã đồng bộ",
    cliPending: (n) => `${n} bản mới`,
    cliSkipped: "Bỏ qua",
    cliCount: (n) => `${n} skill`,
    geminiWhere: "app chưa cài skill cho CLI này",
    installed: (n) => `Đã cài ${n} skill.`,
    conflicts: (names) => `Không ghi đè vì đã sửa hoặc tự thêm trên máy: ${names}.`,
    removed: (n) => `Đã gỡ ${n} skill khỏi máy.`,
    turnedOff: (n) => `Đã tắt ${n} skill với bạn; "Đồng bộ" sẽ không cài lại.`,
    proposeNote: "Vì sao cần sửa? Người duyệt sẽ đọc.",
    proposeSend: "Gửi đề xuất",
    cancel: "Huỷ",
    proposed: "Đã gửi đề xuất. Quản trị duyệt xong thì bản mới về mọi máy.",
    ownNote: "Skill bạn tự đặt vào thư mục; app không ghi đè hay xoá.",
    goneNote: "App đã cài skill này nhưng hub không còn áp cho thư mục.",
    shadowNote: "Cùng tên với một skill phạm vi hẹp hơn; CLI dùng bản hẹp hơn.",
  },
  en: {
    lead: "Skills that apply to this folder by organization → team → project scope. The app installs them into the CLIs on this machine so your agents can use them.",
    target: "Install to",
    tProject: "Project folder (.claude/skills, .agents/skills)",
    tUser: "My account (~/.claude/skills, ~/.codex/skills)",
    sync: (n) => `Sync ${n} updates`,
    synced: "Synced",
    noFolder: "Choose a working folder at the top left, or install to your account.",
    noAccount: "Connect to Hive to get skills from the hub. Skills installed on this machine still work.",
    unmatched: "This folder does not match a hub project: showing organization skills only.",
    loading: "Reading…",
    search: "Search skills…",
    allStates: "All states",
    allScopes: "All sources",
    colSource: "Source",
    colState: "On this machine",
    colVersion: "Version",
    colIdle: "Idle tokens",
    colUse: "My use",
    selectAll: "Select page",
    selectRow: (name) => `Select ${name}`,
    selected: (n) => `${n} selected`,
    installUpdate: "Install / update",
    disableMe: "Disable for me",
    enableMe: "Enable again",
    propose: "Propose edit",
    updateTo: (v) => `Update to v${v}`,
    installV: (v) => `Install v${v}`,
    overwrite: (v) => `Overwrite with v${v}`,
    confirmOverwrite: "Click again to drop your local edits",
    whatChanged: "What changed",
    localVsHub: (v) => `Local copy vs. v${v}`,
    content: (v) => `Content · v${v}`,
    upToDate: "This machine has the latest version.",
    ctxCost: "Context cost while idle",
    usedBy: "My agents called it, 30d",
    usedNote: "Counts skill calls in Claude Code sessions on this machine.",
    page: (from, to, total) => `${from}–${to} of ${total}`,
    prev: "Previous page",
    next: "Next page",
    empty: "No skills match.",
    pickRow: "Pick a skill to see details.",
    scope: { hive: "Hive default", org: "Organization", team: "Team", project: "Project", local: "This machine" },
    team: (name) => `Team · ${name}`,
    project: (name) => `Project · ${name}`,
    state: {
      installed: "Installed",
      update: "Update",
      missing: "Not installed",
      off: "Disabled by me",
      modified: "Edited locally",
      own: "Added by me",
      shadowed: "Hidden by narrower scope",
      gone: "Removed from hub",
    },
    cliSynced: "Synced",
    cliPending: (n) => `${n} updates`,
    cliSkipped: "Skipped",
    cliCount: (n) => `${n} skills`,
    geminiWhere: "the app does not install skills for this CLI yet",
    installed: (n) => `Installed ${n} skills.`,
    conflicts: (names) => `Not overwritten because they were edited or added on this machine: ${names}.`,
    removed: (n) => `Removed ${n} skills from this machine.`,
    turnedOff: (n) => `Disabled ${n} skills for you; Sync will not reinstall them.`,
    proposeNote: "Why is this change needed? Reviewers will read it.",
    proposeSend: "Send proposal",
    cancel: "Cancel",
    proposed: "Proposal sent. Once approved, the new version reaches every machine.",
    ownNote: "A skill you placed in this folder; the app never overwrites or removes it.",
    goneNote: "The app installed this skill, but the hub no longer applies it to this folder.",
    shadowNote: "Same name as a narrower-scope skill; the CLI uses the narrower one.",
  },
};

const STATE_TONE: Record<SkillState, Tone> = {
  installed: "ok",
  update: "warn",
  missing: "sel",
  off: "neutral",
  modified: "warn",
  own: "neutral",
  shadowed: "neutral",
  gone: "bad",
};
const SCOPE_TONE: Record<ScopeKind, Tone> = {
  hive: "sel",
  org: "sel",
  team: "ok",
  project: "neutral",
  local: "neutral",
};
/** Trạng thái mà "Đồng bộ" và "Cài / cập nhật" xử lý; còn lại là việc người dùng tự quyết. */
const PENDING: SkillState[] = ["update", "missing"];
const PAGE = 8;

interface Row {
  id: string;
  name: string;
  description: string;
  scope: ScopeKind;
  scopeLabel: string;
  hub: HubSkillItem | null;
  local: InstalledSkill | undefined;
  state: SkillState;
  uses: number;
}

const TARGET_KEY = "hive.skills.target";
function readTarget(): Target {
  try {
    return localStorage.getItem(TARGET_KEY) === "user" ? "user" : "project";
  } catch {
    return "project";
  }
}

/** Đọc đủ các trang của skill_list (mỗi lần tối đa 50). */
async function listHubSkills(project: string | null) {
  const skills: HubSkillItem[] = [];
  let hidden: HubSkillItem[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const args: Record<string, unknown> = { limit: 50, offset };
    if (project) args.project = project;
    const page: { skills: HubSkillItem[]; hidden?: HubSkillItem[]; nextOffset: number | null } = await hubTool(
      "skill_list",
      args,
    );
    skills.push(...page.skills);
    if (page.hidden) hidden = page.hidden;
    offset = page.nextOffset;
  }
  // Không có dự án thì skill_list trả mọi phạm vi mình thấy; chỉ skill của tổ chức (và skill mặc định tổ chức bật)
  // chắc chắn áp cho thư mục lạ.
  return project
    ? { skills, hidden }
    : { skills: skills.filter((s) => s.scope === "org" || s.scope === "hive"), hidden: [] };
}

/** Nội dung SKILL.md đầy đủ trên hub (skill_get trả theo trang). */
async function hubSkillText(skill: HubSkillItem, project: string | null): Promise<string> {
  let content = "";
  let offset: number | null = 0;
  while (offset !== null) {
    const args: Record<string, unknown> = { name: skill.name, offset };
    if (project) args.project = project;
    const page: { content: string; nextOffset: number | null } = await hubTool("skill_get", args);
    content += page.content;
    offset = page.nextOffset;
  }
  return renderSkillFile(skill.name, skill.description, content);
}

/** Màn Skills (AppSkills.dc.html): skill của hub áp cho thư mục, cài vào CLI trên máy, so bản, đề xuất sửa. */
export function SkillsScreen() {
  const t = useT(text);
  const lang = useLang();
  const account = useLinkedAccount();
  const profile = profileOf(account ?? null);
  const canSync = can(profile, "skills.sync");
  const canPropose = profile !== "writer";
  const [folder] = useFolder();
  const [target, setTargetState] = useState<Target>(readTarget);
  const [off, setOffNames] = useOff(offKey(target, folder));
  // undefined: đang đọc; null: không có thư mục hoặc không đọc được.
  const [meta, setMeta] = useState<WorkspaceMeta | null | undefined>(undefined);
  const [project, setProject] = useState<HubProject | null | undefined>(undefined);
  const [hub, setHub] = useState<{ skills: HubSkillItem[]; hidden: HubSkillItem[] } | null>(null);
  const [hubError, setHubError] = useState<string | null>(null);
  const [local, setLocal] = useState<InstalledSkill[] | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [uses, setUses] = useState<Record<string, number>>({});
  const [reload, setReload] = useState(0);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<string>("");
  const [scopeFilter, setScopeFilter] = useState<string>("");
  const [page, setPage] = useState(0);
  const [curId, setCurId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [armed, setArmed] = useState(false);
  const [proposing, setProposing] = useState<string | null>(null);

  const setTarget = (next: Target) => {
    try {
      localStorage.setItem(TARGET_KEY, next);
    } catch {
      /* Không nhớ được thì lần sau về mặc định. */
    }
    setTargetState(next);
    setChecked(new Set());
    setNotice(null);
  };

  useEffect(() => {
    let alive = true;
    setMeta(undefined);
    setProject(undefined);
    if (!folder) {
      setMeta(null);
      return;
    }
    workspaceMeta(folder).then(
      (m) => alive && setMeta(m),
      () => alive && setMeta(null),
    );
    return () => {
      alive = false;
    };
  }, [folder]);

  useEffect(() => {
    if (!account || meta === undefined) return;
    let alive = true;
    setHub(null);
    setHubError(null);
    (async () => {
      try {
        let found: HubProject | null = null;
        if (meta?.remote) {
          const { projects } = await hubTool<{ projects: HubProject[] }>("project_list");
          found = matchProject(meta.remote, projects);
        }
        if (!alive) return;
        setProject(found);
        const list = await listHubSkills(found?.key ?? null);
        if (alive) setHub(list);
      } catch (e) {
        if (alive) setHubError(errorText(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [account, meta]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload là tín hiệu đọc lại sau khi cài hoặc gỡ.
  useEffect(() => {
    let alive = true;
    setLocalError(null);
    if (target === "project" && !folder) {
      setLocal([]);
      return;
    }
    installedSkills(target, folder).then(
      (l) => alive && setLocal(l),
      (e) => {
        if (!alive) return;
        // Không giữ danh sách của nơi cài trước: trạng thái "Đã cài" sẽ sai.
        setLocal(null);
        setLocalError(errorText(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [target, folder, reload]);

  useEffect(() => {
    let alive = true;
    skillUses(target === "project" ? folder : null).then(
      (u) => alive && setUses(u),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [target, folder]);

  const teamName = useCallback(
    (id: string | undefined) => account?.teams.find((x) => x.id === id)?.name ?? null,
    [account],
  );

  const scopeLabel = useCallback(
    (s: HubSkillItem) => {
      if (s.scope === "team") {
        const name = teamName(s.teamId);
        return name ? t.team(name) : t.scope.team;
      }
      if (s.scope === "project") return project ? t.project(project.name) : t.scope.project;
      if (s.scope === "hive") return s.license ? `${t.scope.hive} · ${s.license}` : t.scope.hive;
      return t.scope.org;
    },
    [t, teamName, project],
  );

  const rows = useMemo<Row[]>(() => {
    const byName = new Map((local ?? []).map((l) => [l.name, l]));
    const out: Row[] = [];
    for (const s of hub?.skills ?? []) {
      const l = byName.get(s.name);
      out.push({
        id: `${s.name}@${s.scope}`,
        name: s.name,
        description: s.description,
        scope: s.scope,
        scopeLabel: scopeLabel(s),
        hub: s,
        local: l,
        state: skillState(s, l, off.has(s.name)),
        uses: uses[s.name] ?? 0,
      });
    }
    for (const s of hub?.hidden ?? []) {
      out.push({
        id: `${s.name}@${s.scope}:hidden`,
        name: s.name,
        description: s.description,
        scope: s.scope,
        scopeLabel: scopeLabel(s),
        hub: s,
        local: undefined,
        state: "shadowed",
        uses: 0,
      });
    }
    const onHub = new Set((hub?.skills ?? []).map((s) => s.name));
    for (const l of local ?? []) {
      if (onHub.has(l.name)) continue;
      out.push({
        id: `${l.name}@local`,
        name: l.name,
        description: "",
        scope: "local",
        scopeLabel: t.scope.local,
        hub: null,
        local: l,
        // Chưa đọc được hub thì không biết hub còn skill hay không: coi như đã cài.
        state: hub ? skillState(null, l, false) : l.version == null ? "own" : "installed",
        uses: uses[l.name] ?? 0,
      });
    }
    // Bản đang áp đứng trước bản bị che cùng tên.
    const hiddenLast = (r: Row) => (r.state === "shadowed" ? 1 : 0);
    return out.sort((a, b) => a.name.localeCompare(b.name) || hiddenLast(a) - hiddenLast(b));
  }, [hub, local, off, uses, scopeLabel, t]);

  const filtered = rows.filter(
    (r) =>
      (!query || `${r.name} ${r.description}`.toLowerCase().includes(query.trim().toLowerCase())) &&
      (!stateFilter || r.state === stateFilter) &&
      (!scopeFilter || r.scope === scopeFilter),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const pageNo = Math.min(page, pages - 1);
  const shown = filtered.slice(pageNo * PAGE, pageNo * PAGE + PAGE);
  const cur = rows.find((r) => r.id === curId) ?? shown[0] ?? null;
  const pending = rows.filter((r) => PENDING.includes(r.state));
  // Còn chờ hub hay danh sách trên máy; một phần lỗi thì phần đó coi như xong để bảng không kẹt "Đang đọc…".
  const loading = (!!account && !hub && !hubError) || (!local && !localError);
  const selectable = (r: Row) => r.state !== "shadowed" && r.state !== "own";
  const project_ = project?.key ?? null;

  // Đổi skill đang xem thì bỏ xác nhận ghi đè và ô đề xuất đang mở.
  // biome-ignore lint/correctness/useExhaustiveDependencies: chỉ chạy khi đổi dòng.
  useEffect(() => {
    setArmed(false);
    setProposing(null);
  }, [cur?.id]);

  // Bản trên hub để so khi máy có bản cũ hoặc đã sửa, hoặc để xem trước khi chưa cài.
  useEffect(() => {
    if (!cur?.hub || cur.state === "shadowed" || cur.state === "installed") return;
    const key = `${cur.hub.name}@${cur.hub.version}`;
    if (texts[key] !== undefined) return;
    let alive = true;
    hubSkillText(cur.hub, project_).then(
      (txt) => alive && setTexts((m) => ({ ...m, [key]: txt })),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [cur, texts, project_]);

  async function install(names: string[], force = false) {
    const items = rows.filter((r) => names.includes(r.name) && r.hub && r.state !== "shadowed");
    if (!items.length) return;
    setBusy(true);
    setNotice(null);
    try {
      const files = await Promise.all(
        items.map(async (r) => {
          const s = r.hub as HubSkillItem;
          // Skill mặc định của Hive có scripts, references đi kèm: cài cả thư mục để agent chạy được như ở run.
          if (s.scope === "hive") return hivePackFile(s.name, s.version);
          const key = `${s.name}@${s.version}`;
          const txt = texts[key] ?? (await hubSkillText(s, project_));
          return { name: s.name, version: s.version, text: txt };
        }),
      );
      const res = await installSkills(target, folder, files, force);
      setOffNames(res.done, false);
      const parts = [
        res.done.length ? t.installed(res.done.length) : "",
        res.conflicts.length ? t.conflicts(res.conflicts.join(", ")) : "",
      ];
      setNotice({ tone: res.conflicts.length ? "bad" : "ok", text: parts.filter(Boolean).join(" ") });
      setChecked(new Set());
      setReload((n) => n + 1);
    } catch (e) {
      setNotice({ tone: "bad", text: errorText(e) });
    } finally {
      setBusy(false);
      setArmed(false);
    }
  }

  async function disable(names: string[]) {
    setBusy(true);
    setNotice(null);
    try {
      const installed = rows.filter((r) => names.includes(r.name) && r.local?.version != null).map((r) => r.name);
      const res = installed.length ? await removeSkills(target, folder, installed) : { done: [], conflicts: [] };
      const turnedOff = names.filter((n) => !res.conflicts.includes(n));
      setOffNames(turnedOff, true);
      const parts = [
        res.done.length ? t.removed(res.done.length) : "",
        turnedOff.length ? t.turnedOff(turnedOff.length) : "",
        res.conflicts.length ? t.conflicts(res.conflicts.join(", ")) : "",
      ];
      setNotice({ tone: res.conflicts.length ? "bad" : "ok", text: parts.filter(Boolean).join(" ") });
      setChecked(new Set());
      setReload((n) => n + 1);
    } catch (e) {
      setNotice({ tone: "bad", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function sendProposal(row: Row, note: string) {
    if (!row.local || row.local.version == null) return;
    setBusy(true);
    setNotice(null);
    try {
      await proposeSkill({
        name: row.name,
        project: project_,
        baseVersion: row.local.version,
        text: row.local.text,
        note,
      });
      setNotice({ tone: "ok", text: t.proposed });
      setProposing(null);
    } catch (e) {
      setNotice({ tone: "bad", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const dirs = CLI_DIRS[target];
  const inDir = (dir: string) => (local ?? []).filter((l) => l.dirs.some((d) => dir.endsWith(d))).length;
  const sub = !account
    ? t.noAccount
    : hubError
      ? hubError
      : target === "project" && !folder
        ? t.noFolder
        : project === null && folder
          ? t.unmatched
          : null;

  const versionText = (r: Row) => {
    const have = r.local?.version;
    if (!r.hub) return have != null ? `v${have}` : "—";
    if (r.state === "shadowed") return `v${r.hub.version}`;
    if (have == null) return `— → v${r.hub.version}`;
    return have < r.hub.version ? `v${have} → v${r.hub.version}` : `v${have}`;
  };

  const curHubText = cur?.hub ? texts[`${cur.hub.name}@${cur.hub.version}`] : undefined;
  const diff =
    cur?.local && curHubText !== undefined && (cur.state === "update" || cur.state === "modified")
      ? diffHunks(lineDiff(cur.local.text, curHubText))
      : null;
  const repoPath = (r: Row) =>
    r.hub?.repoPath ??
    (r.hub?.scope === "hive"
      ? `tdduydev/xdev-skills · library/${r.name}/`
      : r.hub?.scope === "org"
        ? `org/${r.name}/SKILL.md`
        : r.hub?.scope === "project" && project
          ? `projects/${project.key}/${r.name}/SKILL.md`
          : r.hub
            ? `${r.name}/SKILL.md`
            : null);

  return (
    <div className="flex flex-col gap-3.5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-72 flex-1 flex-col gap-1">
          <p className="text-sm text-muted-foreground">{t.lead}</p>
          {sub && <p className={cn("text-sm", hubError ? "text-destructive" : "text-muted-foreground")}>{sub}</p>}
          {!account && <ConnectHiveButton className="self-start" />}
          {account && !hubError && target === "project" && !folder && <PickFolderButton />}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
            {t.target}
            <select
              className="h-7.5 rounded-lg border border-input bg-background px-2 text-sm text-foreground"
              value={target}
              onChange={(e) => setTarget(e.target.value as Target)}
            >
              <option value="project">{t.tProject}</option>
              <option value="user">{t.tUser}</option>
            </select>
          </label>
          {canSync && (
            <Button
              size="sm"
              disabled={busy || !hub || !pending.length || (target === "project" && !folder)}
              onClick={() => install(pending.map((r) => r.name))}
            >
              {pending.length ? t.sync(pending.length) : t.synced}
            </Button>
          )}
        </div>
      </header>

      {notice && (
        <p role="status" className={cn("text-sm", notice.tone === "bad" ? "text-destructive" : "text-success")}>
          {notice.text}
        </p>
      )}
      {localError && <p className="text-sm text-destructive">{localError}</p>}

      <section className="grid grid-cols-1 gap-2.5 min-[760px]:grid-cols-3">
        {[
          { name: "Claude Code", where: `${dirs.claude}/ · ${t.cliCount(inDir(dirs.claude))}`, skip: false },
          { name: "Codex", where: `${dirs.codex}/ · ${t.cliCount(inDir(dirs.codex))}`, skip: false },
          { name: "Gemini CLI", where: t.geminiWhere, skip: true },
        ].map((c) => (
          <div key={c.name} className="flex flex-col gap-1 rounded-xl border bg-card px-3 py-2.5 text-card-foreground">
            <span className="flex items-center gap-2">
              <strong className="font-semibold">{c.name}</strong>
              {c.skip ? (
                <Pill>{t.cliSkipped}</Pill>
              ) : hub ? (
                <Pill tone={pending.length ? "warn" : "ok"}>
                  {pending.length ? t.cliPending(pending.length) : t.cliSynced}
                </Pill>
              ) : null}
            </span>
            <span className="font-mono text-xs text-muted-foreground">{c.where}</span>
          </div>
        ))}
      </section>

      <div className="flex flex-col items-start gap-3.5 min-[1000px]:flex-row">
        <section className="w-full min-w-0 overflow-hidden rounded-xl border bg-card min-[1000px]:flex-1">
          <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2.5">
            <Input
              className="h-7.5 max-w-60 text-sm"
              placeholder={t.search}
              aria-label={t.search}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />
            <select
              aria-label={t.colState}
              className="h-7.5 rounded-lg border border-input bg-background px-2 text-sm"
              value={stateFilter}
              onChange={(e) => {
                setStateFilter(e.target.value);
                setPage(0);
              }}
            >
              <option value="">{t.allStates}</option>
              {(Object.keys(t.state) as SkillState[])
                .filter((s) => rows.some((r) => r.state === s))
                .map((s) => (
                  <option key={s} value={s}>
                    {t.state[s]}
                  </option>
                ))}
            </select>
            <select
              aria-label={t.colSource}
              className="h-7.5 rounded-lg border border-input bg-background px-2 text-sm"
              value={scopeFilter}
              onChange={(e) => {
                setScopeFilter(e.target.value);
                setPage(0);
              }}
            >
              <option value="">{t.allScopes}</option>
              {(Object.keys(t.scope) as ScopeKind[])
                .filter((s) => rows.some((r) => r.scope === s))
                .map((s) => (
                  <option key={s} value={s}>
                    {t.scope[s]}
                  </option>
                ))}
            </select>
            {canSync && checked.size > 0 && (
              <span role="toolbar" aria-label={t.selected(checked.size)} className="ml-auto flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{t.selected(checked.size)}</span>
                <Button size="sm" disabled={busy} onClick={() => install([...checked])}>
                  {t.installUpdate}
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => disable([...checked])}>
                  {t.disableMe}
                </Button>
              </span>
            )}
          </div>
          <Table className="min-w-160 [&_td]:px-2.5 [&_th]:px-2.5">
            <TableHeader>
              <TableRow>
                {canSync && (
                  <Th className="w-8">
                    <input
                      type="checkbox"
                      aria-label={t.selectAll}
                      checked={shown.some(selectable) && shown.filter(selectable).every((r) => checked.has(r.name))}
                      onChange={(e) =>
                        setChecked((cur) => {
                          const next = new Set(cur);
                          for (const r of shown.filter(selectable)) {
                            if (e.target.checked) next.add(r.name);
                            else next.delete(r.name);
                          }
                          return next;
                        })
                      }
                    />
                  </Th>
                )}
                <Th>Skill</Th>
                <Th>{t.colSource}</Th>
                <Th>{t.colState}</Th>
                <Th>{t.colVersion}</Th>
                <Th className="text-right whitespace-normal">{t.colIdle}</Th>
                <Th className="text-right whitespace-normal">{t.colUse}</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.length === 0 ? (
                <TableRow>
                  <Td colSpan={canSync ? 7 : 6} className="text-sm text-muted-foreground">
                    {loading ? t.loading : t.empty}
                  </Td>
                </TableRow>
              ) : (
                shown.map((r) => (
                  <TableRow
                    key={r.id}
                    data-state={cur?.id === r.id ? "selected" : undefined}
                    className="cursor-pointer"
                    onClick={() => setCurId(r.id)}
                  >
                    {canSync && (
                      <Td onClick={(e) => e.stopPropagation()}>
                        {selectable(r) && (
                          <input
                            type="checkbox"
                            aria-label={t.selectRow(r.name)}
                            checked={checked.has(r.name)}
                            onChange={(e) =>
                              setChecked((cur) => {
                                const next = new Set(cur);
                                if (e.target.checked) next.add(r.name);
                                else next.delete(r.name);
                                return next;
                              })
                            }
                          />
                        )}
                      </Td>
                    )}
                    <Td className="max-w-52">
                      <button
                        type="button"
                        className="flex w-full min-w-0 flex-col text-left"
                        onClick={() => setCurId(r.id)}
                      >
                        <span className="truncate font-mono text-sm font-medium">{r.name}</span>
                        {r.description && (
                          <span className="truncate text-xs text-muted-foreground">{r.description}</span>
                        )}
                      </button>
                    </Td>
                    <Td>
                      <Pill tone={SCOPE_TONE[r.scope]}>{r.scopeLabel}</Pill>
                    </Td>
                    <Td>
                      <Pill tone={STATE_TONE[r.state]}>{t.state[r.state]}</Pill>
                    </Td>
                    <Td className="font-mono text-xs whitespace-nowrap">{versionText(r)}</Td>
                    {/* Bản bị che không nạp vào CLI: không chiếm ngữ cảnh, không ai gọi được. */}
                    <Td className="text-right font-mono text-xs">
                      {r.hub && r.state !== "shadowed" ? `~${idleTokens(r.hub)}` : "—"}
                    </Td>
                    <Td className="text-right font-mono text-xs">
                      {r.state === "shadowed" ? "—" : r.uses.toLocaleString(lang)}
                    </Td>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          {filtered.length > PAGE && (
            <div className="flex items-center justify-end gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
              <span>{t.page(pageNo * PAGE + 1, Math.min(filtered.length, pageNo * PAGE + PAGE), filtered.length)}</span>
              <Button size="xs" variant="outline" disabled={pageNo === 0} onClick={() => setPage(pageNo - 1)}>
                {t.prev}
              </Button>
              <Button size="xs" variant="outline" disabled={pageNo >= pages - 1} onClick={() => setPage(pageNo + 1)}>
                {t.next}
              </Button>
            </div>
          )}
        </section>

        <aside className="flex w-full min-w-0 flex-col overflow-hidden rounded-xl border bg-card min-[1000px]:w-[min(400px,36%)] min-[1000px]:flex-none">
          {!cur ? (
            <p className="px-3.5 py-3 text-sm text-muted-foreground">{t.pickRow}</p>
          ) : (
            <>
              <div className="flex flex-col gap-1.5 border-b px-3.5 py-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Pill tone={SCOPE_TONE[cur.scope]}>{cur.scopeLabel}</Pill>
                  <Pill tone={STATE_TONE[cur.state]}>{t.state[cur.state]}</Pill>
                </div>
                <strong className="font-mono text-[15px]">{cur.name}</strong>
                {cur.description && <span className="text-sm text-muted-foreground">{cur.description}</span>}
                <span className="font-mono text-xs break-all text-muted-foreground">
                  {repoPath(cur) ? `${repoPath(cur)} → ` : ""}
                  {dirs.claude}/{cur.name}/
                </span>
              </div>
              <div className="flex flex-col gap-2 px-3.5 py-2.5">
                {cur.state === "own" || cur.state === "gone" || cur.state === "shadowed" ? (
                  <p className="text-sm text-muted-foreground">
                    {cur.state === "own" ? t.ownNote : cur.state === "gone" ? t.goneNote : t.shadowNote}
                  </p>
                ) : cur.state === "installed" ? (
                  <p className="text-sm text-success">{t.upToDate}</p>
                ) : (
                  <>
                    <span className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
                      {diff
                        ? cur.state === "modified"
                          ? t.localVsHub(cur.hub?.version ?? 0)
                          : `${t.whatChanged} · v${cur.local?.version} → v${cur.hub?.version}`
                        : t.content(cur.hub?.version ?? 0)}
                    </span>
                    {curHubText === undefined ? (
                      <p className="text-sm text-muted-foreground">{t.loading}</p>
                    ) : (
                      <div className="max-h-72 overflow-auto rounded-lg border py-1.5 font-mono text-xs leading-relaxed">
                        {numbered(
                          diff ??
                            curHubText
                              .split("\n")
                              .slice(0, 40)
                              .map((text) => ({ kind: "same" as const, text })),
                        ).map(({ key, line }) =>
                          line === null ? (
                            <div key={key} className="px-2.5 text-muted-foreground">
                              …
                            </div>
                          ) : (
                            <div
                              key={key}
                              className={cn(
                                "px-2.5 whitespace-pre-wrap",
                                line.kind === "add" && "bg-success-soft text-success",
                                line.kind === "del" && "bg-destructive-soft text-destructive",
                              )}
                            >
                              {line.kind === "add" ? "+ " : line.kind === "del" ? "- " : ""}
                              {line.text}
                            </div>
                          ),
                        )}
                      </div>
                    )}
                  </>
                )}
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span>
                    {t.ctxCost}{" "}
                    <strong className="font-mono text-foreground">{cur.hub ? `~${idleTokens(cur.hub)}` : "—"}</strong>{" "}
                    token
                  </span>
                  <span>·</span>
                  <span title={t.usedNote}>
                    {t.usedBy} <strong className="font-mono text-foreground">{cur.uses.toLocaleString(lang)}</strong>
                  </span>
                </div>
                {proposing === cur.id ? (
                  <ProposeForm
                    t={t}
                    busy={busy}
                    onCancel={() => setProposing(null)}
                    onSend={(note) => sendProposal(cur, note)}
                  />
                ) : (
                  canSync &&
                  cur.state !== "own" &&
                  cur.state !== "shadowed" && (
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {cur.state === "off" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => setOffNames([cur.name], false)}
                        >
                          {t.enableMe}
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => disable([cur.name])}>
                          {t.disableMe}
                        </Button>
                      )}
                      {canPropose && cur.state === "modified" && cur.hub && cur.hub.scope !== "hive" && (
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => setProposing(cur.id)}>
                          {t.propose}
                        </Button>
                      )}
                      {cur.hub && cur.state === "modified" ? (
                        <Button
                          size="sm"
                          variant={armed ? "destructive-solid" : "default"}
                          disabled={busy}
                          onClick={() => (armed ? install([cur.name], true) : setArmed(true))}
                        >
                          {armed ? t.confirmOverwrite : t.overwrite(cur.hub.version)}
                        </Button>
                      ) : cur.hub && (cur.state === "update" || cur.state === "missing" || cur.state === "off") ? (
                        <Button size="sm" disabled={busy} onClick={() => install([cur.name])}>
                          {cur.state === "update" ? t.updateTo(cur.hub.version) : t.installV(cur.hub.version)}
                        </Button>
                      ) : null}
                    </div>
                  )
                )}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

/** Dòng diff không có khoá riêng; thứ tự cố định nên đánh số trước khi vẽ. */
const numbered = (lines: (DiffLine | null)[]) => lines.map((line, n) => ({ key: `l${n}`, line }));

function ProposeForm({
  t,
  busy,
  onCancel,
  onSend,
}: {
  t: (typeof text)["vi"];
  busy: boolean;
  onCancel: () => void;
  onSend: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (note.trim()) onSend(note.trim());
      }}
    >
      <Textarea
        aria-label={t.proposeNote}
        placeholder={t.proposeNote}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        className="min-h-16 text-sm"
      />
      <div className="flex justify-end gap-1.5">
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          {t.cancel}
        </Button>
        <Button type="submit" size="sm" disabled={busy || !note.trim()}>
          {t.proposeSend}
        </Button>
      </div>
    </form>
  );
}
