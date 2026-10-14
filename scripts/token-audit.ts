/**
 * Đo token và memory của CLI agent trên máy từ transcript (chỉ đọc): `node scripts/token-audit.ts [--days N] [--json]`.
 * Nguồn: Claude Code `<thư mục cấu hình>/projects/**\/*.jsonl` của mọi gói trong ~/.xdev-hive/accounts và ~/.claude,
 * Codex `<CODEX_HOME>/sessions/**\/rollout-*.jsonl`. Chỉ in số tổng hợp: không in prompt, output tool hay đường dẫn
 * dự án, để chép kết quả vào báo cáo hay issue không lộ dữ liệu người dùng.
 *
 * Phiên chia theo nguồn: "worker" (run do hub giao, cwd trong worktree của worker ~/.xdev-hive/worktrees),
 * "hub-terminal" (phiên tương tác trong worktree của worker: terminal Leader điều khiển từ xa), "headless" (`claude -p`
 * ngoài worker: agent chạy song song, script), "interactive" (người gõ: terminal của app, terminal thường), "test" (test
 * Go/Rust tạo repo tạm). Token output tool ước lượng bằng ký tự / 4 vì transcript không ghi số token của từng khối.
 */
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

type Source = "worker" | "hub-terminal" | "headless" | "interactive" | "test";

interface ToolStat {
  calls: number;
  chars: number;
  // Ký tự output nhân số lượt gọi API sau nó trong cùng ngữ cảnh: phần bị đọc lại qua cache mỗi lượt.
  carried: number;
}

interface Session {
  cli: "claude" | "codex";
  source: Source;
  account: string;
  rtk: boolean;
  guard: boolean;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  tools: Map<string, ToolStat>;
  bash: Map<string, ToolStat>;
  reads: number;
  rereads: number;
  rereadChars: number;
  // Ký tự instruction nạp vào phiên theo loại (Project = CLAUDE.md/AGENTS.md, AutoMem = MEMORY.md, User...).
  memory: Map<string, number>;
  compactions: number;
  models: Set<string>;
  versions: Set<string>;
  peakContext: number;
  // Ngữ cảnh ở lượt gọi đầu: system prompt, định nghĩa tool/MCP, CLAUDE.md, memory; phần trả mỗi lượt dù chưa làm gì.
  firstContext: number;
}

const args = process.argv.slice(2);
const days = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) || 0 : 0;
const sinceMs = days > 0 ? Date.now() - days * 86_400_000 : 0;
const asJSON = args.includes("--json");
const home = homedir();
const accountsDir = join(home, ".xdev-hive", "accounts");

function walk(dir: string, match: (name: string) => boolean, out: string[] = []): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      // memory/ chỉ chứa .md; tool-results/ là output đã tách ra file, đọc qua transcript.
      if (e.name !== "memory" && e.name !== "tool-results") walk(p, match, out);
    } else if (match(e.name)) {
      if (!sinceMs || statSync(p).mtimeMs >= sinceMs) out.push(p);
    }
  }
  return out;
}

function claudeRoots(): Array<{ account: string; dir: string }> {
  const roots: Array<{ account: string; dir: string }> = [];
  if (existsSync(accountsDir)) {
    for (const a of readdirSync(accountsDir)) {
      if (a.startsWith("claude")) roots.push({ account: a, dir: join(accountsDir, a, "projects") });
    }
  }
  roots.push({ account: "default", dir: join(home, ".claude", "projects") });
  return roots.filter((r) => existsSync(r.dir));
}

function codexRoots(): Array<{ account: string; dir: string }> {
  const roots: Array<{ account: string; dir: string }> = [];
  if (existsSync(accountsDir)) {
    for (const a of readdirSync(accountsDir)) {
      if (a.startsWith("codex")) roots.push({ account: a, dir: join(accountsDir, a, "sessions") });
    }
  }
  roots.push({ account: "default", dir: join(home, ".codex", "sessions") });
  return roots.filter((r) => existsSync(r.dir));
}

function classify(cwd: string, entrypoint: string): Source {
  if (/[/\\]\.xdev-hive[/\\](worktrees|runs)[/\\]/.test(cwd)) {
    return entrypoint === "sdk-cli" ? "worker" : "hub-terminal";
  }
  if (/\/T\/|TestZZ|\/tmp\/.*probe|\/tmp\/.*-test/.test(cwd)) return "test";
  return entrypoint === "sdk-cli" ? "headless" : "interactive";
}

function newSession(cli: Session["cli"], account: string): Session {
  return {
    cli,
    source: "interactive",
    account,
    rtk: false,
    guard: false,
    calls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    tools: new Map(),
    bash: new Map(),
    reads: 0,
    rereads: 0,
    rereadChars: 0,
    memory: new Map(),
    compactions: 0,
    models: new Set(),
    versions: new Set(),
    peakContext: 0,
    firstContext: 0,
  };
}

function bump(m: Map<string, ToolStat>, key: string, chars: number, carried: number): void {
  const s = m.get(key) ?? { calls: 0, chars: 0, carried: 0 };
  s.calls++;
  s.chars += chars;
  s.carried += carried;
  m.set(key, s);
}

function textLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let n = 0;
    for (const b of content) {
      if (b && typeof b === "object") {
        const blk = b as { type?: string; text?: string; source?: { data?: string } };
        if (typeof blk.text === "string") n += blk.text.length;
        // Ảnh tính theo cỡ base64 / 4 cho có bậc độ lớn; không cố đoán token ảnh.
        else if (blk.type === "image") n += (blk.source?.data?.length ?? 0) / 4;
      }
    }
    return n;
  }
  return 0;
}

// bashKey lấy lệnh chính, bỏ `cd x &&` và biến môi trường đứng đầu: đủ để biết loại lệnh nào sinh output lớn.
function bashKey(cmd: string): string {
  const seg =
    cmd
      .split(/&&|;|\|\|/)
      .map((s) => s.trim())
      .find((s) => s && !s.startsWith("cd ")) ?? "";
  const words = seg.split(/\s+/).filter((w) => !/^[A-Z_][A-Z0-9_]*=/.test(w));
  const first = basename(words[0] ?? "?");
  if (["pnpm", "npm", "go", "git", "cargo", "npx", "rtk", "docker", "gh"].includes(first) && words[1]) {
    const sub = words[1] === "--filter" || words[1] === "-C" ? (words[3] ?? "") : words[1];
    return `${first} ${sub}`.trim();
  }
  return first;
}

async function lines(file: string, fn: (o: Record<string, unknown>) => void): Promise<void> {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of rl) {
    if (!line) continue;
    try {
      fn(JSON.parse(line));
    } catch {
      // Dòng ghi dở khi CLI đang chạy.
    }
  }
}

async function readClaude(file: string, account: string): Promise<Session> {
  const s = newSession("claude", account);
  const seen = new Set<string>();
  const toolName = new Map<string, { name: string; key: string; reread: boolean; at: number }>();
  const readCount = new Map<string, number>();
  // Lượt gọi API (đã gộp theo message.id) của từng output tool, để tính phần bị đọc lại tới lần nén kế tiếp.
  const pending: Array<{ name: string; key: string; chars: number; at: number }> = [];
  let cwd = "";
  let entrypoint = "";
  const settle = (until: number) => {
    for (const p of pending.splice(0)) {
      const carried = p.chars * Math.max(0, until - p.at);
      bump(s.tools, p.name, p.chars, carried);
      if (p.name === "Bash") bump(s.bash, p.key, p.chars, carried);
    }
  };
  await lines(file, (o) => {
    if (typeof o.cwd === "string" && !cwd) cwd = o.cwd;
    if (typeof o.entrypoint === "string" && !entrypoint) entrypoint = o.entrypoint;
    if (typeof o.version === "string") s.versions.add(o.version);
    const type = o.type;
    if (type === "system" && o.subtype === "compact_boundary") {
      s.compactions++;
      settle(s.calls);
      return;
    }
    if (type === "attachment") {
      const a = (o.attachment ?? {}) as Record<string, unknown>;
      if (a.type === "instructions" && Array.isArray(a.files)) {
        for (const f of a.files as Array<{ type?: string; content?: string }>) {
          const k = f.type ?? "?";
          s.memory.set(k, (s.memory.get(k) ?? 0) + (f.content?.length ?? 0));
        }
      }
      if (a.type === "hook_success" || a.type === "hook_non_blocking_error") {
        const cmd = String(a.command ?? "");
        if (/\brtk\b.*hook/.test(cmd)) s.rtk = true;
        if (/hive-worker.*hook|hook (pre|post)-tool/.test(cmd)) s.guard = true;
      }
      return;
    }
    const msg = (o.message ?? {}) as Record<string, unknown>;
    if (type === "assistant") {
      const id = String(msg.id ?? o.requestId ?? o.uuid);
      const content = Array.isArray(msg.content) ? (msg.content as Array<Record<string, unknown>>) : [];
      for (const b of content) {
        if (b.type !== "tool_use") continue;
        const name = String(b.name ?? "?");
        const input = (b.input ?? {}) as Record<string, unknown>;
        const key = name === "Bash" ? bashKey(String(input.command ?? "")) : name;
        let reread = false;
        if (name === "Read" && typeof input.file_path === "string") {
          s.reads++;
          const rk = `${input.file_path}:${input.offset ?? ""}:${input.limit ?? ""}`;
          const n = (readCount.get(rk) ?? 0) + 1;
          readCount.set(rk, n);
          reread = n > 1;
          if (reread) s.rereads++;
        }
        toolName.set(String(b.id), { name, key, reread, at: s.calls + 1 });
      }
      if (seen.has(id)) return;
      seen.add(id);
      const u = msg.usage as Record<string, number> | undefined;
      if (!u) return;
      s.calls++;
      if (typeof msg.model === "string" && msg.model !== "<synthetic>") s.models.add(msg.model);
      const cc = (u.cache_creation ?? {}) as unknown as Record<string, number>;
      const w1h = cc.ephemeral_1h_input_tokens ?? 0;
      const w5m = cc.ephemeral_5m_input_tokens ?? (u.cache_creation_input_tokens ?? 0) - w1h;
      s.input += u.input_tokens ?? 0;
      s.output += u.output_tokens ?? 0;
      s.cacheRead += u.cache_read_input_tokens ?? 0;
      s.cacheWrite5m += w5m;
      s.cacheWrite1h += w1h;
      const context = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      s.peakContext = Math.max(s.peakContext, context);
      if (!s.firstContext) s.firstContext = context;
      return;
    }
    if (type === "user" && Array.isArray(msg.content)) {
      for (const b of msg.content as Array<Record<string, unknown>>) {
        if (b.type !== "tool_result") continue;
        const t = toolName.get(String(b.tool_use_id));
        const chars = textLength(b.content);
        const name = t?.name ?? "?";
        pending.push({ name, key: t?.key ?? name, chars, at: t?.at ?? s.calls });
        if (t?.reread) s.rereadChars += chars;
      }
    }
  });
  settle(s.calls);
  s.source = classify(cwd, entrypoint);
  return s;
}

async function readCodex(file: string, account: string): Promise<Session> {
  const s = newSession("codex", account);
  s.source = "interactive";
  let last: Record<string, number> | undefined;
  const callName = new Map<string, string>();
  let cwd = "";
  let originator = "";
  const pending: Array<{ name: string; chars: number; at: number }> = [];
  await lines(file, (o) => {
    const p = (o.payload ?? {}) as Record<string, unknown>;
    if (o.type === "session_meta") {
      cwd = String(p.cwd ?? "");
      originator = String(p.originator ?? "");
      if (typeof p.cli_version === "string") s.versions.add(p.cli_version);
    }
    if (o.type === "turn_context" && typeof p.model === "string") s.models.add(p.model);
    if (p.type === "token_count") {
      const info = p.info as { total_token_usage?: Record<string, number> } | null;
      if (info?.total_token_usage) {
        s.calls++;
        last = info.total_token_usage;
        const l = (info as { last_token_usage?: Record<string, number> }).last_token_usage;
        if (l) {
          s.peakContext = Math.max(s.peakContext, l.input_tokens ?? 0);
          if (!s.firstContext) s.firstContext = l.input_tokens ?? 0;
        }
      }
    }
    if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
      callName.set(String(p.call_id), String(p.name ?? p.type));
    }
    if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const out = p.output;
      const chars = typeof out === "string" ? out.length : JSON.stringify(out ?? "").length;
      pending.push({ name: callName.get(String(p.call_id)) ?? "?", chars, at: s.calls });
    }
  });
  for (const t of pending) bump(s.tools, t.name, t.chars, t.chars * Math.max(0, s.calls - t.at));
  if (last) {
    // Codex tính input gồm cả phần cache; tách ra cho cùng nghĩa với Claude.
    s.cacheRead = last.cached_input_tokens ?? 0;
    s.input = (last.input_tokens ?? 0) - s.cacheRead;
    s.cacheWrite5m = last.cache_write_input_tokens ?? 0;
    s.output = (last.output_tokens ?? 0) + (last.reasoning_output_tokens ?? 0);
  }
  s.source = classify(cwd, originator === "codex_exec" ? "sdk-cli" : "cli");
  return s;
}

// Chi phí quy về "token input tương đương" theo tỉ lệ giá của Anthropic (cache đọc 0,1×, ghi 5 phút 1,25×, ghi 1 giờ
// 2×, output 5×). Codex khác giá nhưng tỉ lệ đọc cache/ghi tương tự; chỉ dùng để so phần trăm trong cùng CLI.
function weighted(s: Session): number {
  return s.input + 0.1 * s.cacheRead + 1.25 * s.cacheWrite5m + 2 * s.cacheWrite1h + 5 * s.output;
}

interface Group {
  sessions: number;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  weighted: number;
  peakOver150k: number;
  // Vượt cửa sổ 200k: phiên đang chạy bằng ngữ cảnh 1M, mỗi lượt đọc lại cả phần đó qua cache.
  peakOver400k: number;
  weightedOver400k: number;
  compactions: number;
}

function group(list: Session[]): Group {
  const g: Group = {
    sessions: list.length,
    calls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    weighted: 0,
    peakOver150k: 0,
    peakOver400k: 0,
    weightedOver400k: 0,
    compactions: 0,
  };
  for (const s of list) {
    g.calls += s.calls;
    g.input += s.input;
    g.output += s.output;
    g.cacheRead += s.cacheRead;
    g.cacheWrite5m += s.cacheWrite5m;
    g.cacheWrite1h += s.cacheWrite1h;
    g.weighted += weighted(s);
    if (s.peakContext > 150_000) g.peakOver150k++;
    if (s.peakContext > 400_000) {
      g.peakOver400k++;
      g.weightedOver400k += weighted(s);
    }
    g.compactions += s.compactions;
  }
  return g;
}

function hitRate(g: Group): number {
  const total = g.input + g.cacheRead + g.cacheWrite5m + g.cacheWrite1h;
  return total ? g.cacheRead / total : 0;
}

function mergeTools(list: Session[], pick: (s: Session) => Map<string, ToolStat>): Array<[string, ToolStat]> {
  const m = new Map<string, ToolStat>();
  for (const s of list) {
    for (const [k, v] of pick(s)) {
      const t = m.get(k) ?? { calls: 0, chars: 0, carried: 0 };
      t.calls += v.calls;
      t.chars += v.chars;
      t.carried += v.carried;
      m.set(k, t);
    }
  }
  return [...m.entries()].sort((a, b) => b[1].carried - a[1].carried);
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)] ?? 0;
}

// memoryInventory kiểm memory trên đĩa: số file, cỡ, MEMORY.md, link chết, file cũ, tên trùng giữa các gói.
function memoryInventory() {
  const dirs: Array<{ account: string; project: string; dir: string }> = [];
  for (const r of claudeRoots()) {
    for (const p of readdirSync(r.dir)) {
      const dir = join(r.dir, p, "memory");
      if (existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".md"))) {
        dirs.push({ account: r.account, project: p, dir });
      }
    }
  }
  const byName = new Map<string, Set<string>>();
  let files = 0;
  let bytes = 0;
  let indexBytes = 0;
  let dead = 0;
  let stale = 0;
  let orphan = 0;
  for (const d of dirs) {
    const names = readdirSync(d.dir).filter((f) => f.endsWith(".md"));
    const slugs = new Set<string>();
    for (const f of names) {
      const p = join(d.dir, f);
      const st = statSync(p);
      files++;
      bytes += st.size;
      if (Date.now() - st.mtimeMs > 30 * 86_400_000) stale++;
      const m = /^name:\s*(.+)$/m.exec(readFileSync(p, "utf8"));
      if (m?.[1]) slugs.add(m[1].trim());
      const key = `${d.project}/${f}`;
      byName.set(key, (byName.get(key) ?? new Set()).add(d.account));
    }
    const index = join(d.dir, "MEMORY.md");
    const indexText = existsSync(index) ? readFileSync(index, "utf8") : "";
    indexBytes += indexText.length;
    for (const f of names) {
      if (f !== "MEMORY.md" && !indexText.includes(f)) orphan++;
    }
    for (const f of names) {
      const text = readFileSync(join(d.dir, f), "utf8");
      for (const m of text.matchAll(/\]\(([^)]+\.md)\)/g)) {
        if (m[1] && !existsSync(join(d.dir, m[1]))) dead++;
      }
      for (const m of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
        if (m[1] && !slugs.has(m[1]) && !existsSync(join(d.dir, `${m[1]}.md`))) dead++;
      }
    }
  }
  const duplicated = [...byName.values()].filter((s) => s.size > 1).length;
  const projectsWithMemory = new Set(dirs.map((d) => d.project)).size;
  return { dirs: dirs.length, projectsWithMemory, files, bytes, indexBytes, dead, stale, orphan, duplicated };
}

function codexMemory() {
  const out: Array<{ account: string; agentsMd: number; memoriesDb: number }> = [];
  const homes = existsSync(accountsDir)
    ? readdirSync(accountsDir)
        .filter((a) => a.startsWith("codex"))
        .map((a) => ({ account: a, dir: join(accountsDir, a) }))
    : [];
  homes.push({ account: "default", dir: join(home, ".codex") });
  for (const h of homes) {
    if (!existsSync(h.dir)) continue;
    const size = (f: string) => (existsSync(join(h.dir, f)) ? statSync(join(h.dir, f)).size : 0);
    out.push({ account: h.account, agentsMd: size("AGENTS.md"), memoriesDb: size("memories_1.sqlite") });
  }
  const gemini = join(home, ".gemini", "GEMINI.md");
  return { codex: out, geminiMd: existsSync(gemini) ? statSync(gemini).size : 0 };
}

async function main(): Promise<void> {
  const sessions: Session[] = [];
  for (const r of claudeRoots()) {
    for (const f of walk(r.dir, (n) => n.endsWith(".jsonl"))) {
      // Transcript của subagent nằm trong <phiên>/subagents/; tính là phiên riêng cùng nguồn.
      const s = await readClaude(f, r.account);
      if (s.calls) sessions.push(s);
    }
  }
  for (const r of codexRoots()) {
    for (const f of walk(r.dir, (n) => n.startsWith("rollout-") && n.endsWith(".jsonl"))) {
      const s = await readCodex(f, r.account);
      if (s.calls) sessions.push(s);
    }
  }

  const report: Record<string, unknown> = { days: days || "all", generatedAt: new Date().toISOString() };
  const bySource: Record<string, unknown> = {};
  for (const cli of ["claude", "codex"] as const) {
    for (const src of ["worker", "hub-terminal", "headless", "interactive", "test"] as const) {
      const list = sessions.filter((s) => s.cli === cli && s.source === src);
      if (!list.length) continue;
      const g = group(list);
      bySource[`${cli}/${src}`] = {
        ...g,
        cacheHit: Number(hitRate(g).toFixed(3)),
        rtkSessions: list.filter((s) => s.rtk).length,
        guardSessions: list.filter((s) => s.guard).length,
        medianCalls: median(list.map((s) => s.calls)),
        medianFirstContext: median(list.map((s) => s.firstContext).filter((n) => n > 0)),
        medianPeakContext: median(list.map((s) => s.peakContext)),
        weightedShare: {
          input: Number((g.input / g.weighted).toFixed(3)),
          cacheRead: Number(((0.1 * g.cacheRead) / g.weighted).toFixed(3)),
          cacheWrite: Number(((1.25 * g.cacheWrite5m + 2 * g.cacheWrite1h) / g.weighted).toFixed(3)),
          output: Number(((5 * g.output) / g.weighted).toFixed(3)),
        },
      };
    }
  }
  report.bySource = bySource;
  // Phiên tương tác bằng gói của app (~/.xdev-hive/accounts) là phiên app mở hoặc đặt CLAUDE_CONFIG_DIR tới gói; còn
  // lại là đăng nhập mặc định của CLI.
  const interactiveHome: Record<string, unknown> = {};
  for (const plan of [true, false]) {
    const list = sessions.filter(
      (s) => s.cli === "claude" && s.source === "interactive" && (s.account !== "default") === plan,
    );
    if (!list.length) continue;
    const g = group(list);
    interactiveHome[plan ? "plan" : "default"] = {
      sessions: g.sessions,
      calls: g.calls,
      cacheRead: g.cacheRead,
      cacheWrite1h: g.cacheWrite1h,
      weighted: Math.round(g.weighted),
      peakOver150k: g.peakOver150k,
      rtkSessions: list.filter((s) => s.rtk).length,
      medianPeakContext: median(list.map((s) => s.peakContext)),
    };
  }
  report.interactiveHome = interactiveHome;

  const claude = sessions.filter((s) => s.cli === "claude" && s.source !== "test");
  const totalCarried = mergeTools(claude, (s) => s.tools).reduce((n, [, t]) => n + t.carried, 0);
  report.tools = mergeTools(claude, (s) => s.tools)
    .slice(0, 12)
    .map(([name, t]) => ({
      name,
      calls: t.calls,
      outputTokens: Math.round(t.chars / 4),
      avgTokens: Math.round(t.chars / 4 / t.calls),
      carriedTokens: Math.round(t.carried / 4),
      carriedShare: Number((t.carried / totalCarried).toFixed(3)),
    }));
  report.bash = mergeTools(claude, (s) => s.bash)
    .slice(0, 15)
    .map(([name, t]) => ({
      name,
      calls: t.calls,
      avgTokens: Math.round(t.chars / 4 / t.calls),
      carriedTokens: Math.round(t.carried / 4),
    }));
  report.codexTools = mergeTools(
    sessions.filter((s) => s.cli === "codex"),
    (s) => s.tools,
  )
    .slice(0, 8)
    .map(([name, t]) => ({ name, calls: t.calls, avgTokens: Math.round(t.chars / 4 / t.calls) }));

  const reads = claude.reduce((n, s) => n + s.reads, 0);
  const rereads = claude.reduce((n, s) => n + s.rereads, 0);
  report.rereads = {
    reads,
    rereads,
    share: Number((rereads / Math.max(1, reads)).toFixed(3)),
    rereadTokens: Math.round(claude.reduce((n, s) => n + s.rereadChars, 0) / 4),
    sessionsWithReread: claude.filter((s) => s.rereads > 0).length,
  };

  // RTK: so output Bash trung bình mỗi lệnh của phiên có/không hook RTK, chỉ trong cùng nguồn để công bằng.
  const rtk: Record<string, unknown> = {};
  for (const src of ["worker", "headless", "interactive"] as const) {
    const list = claude.filter((s) => s.source === src);
    const per = (xs: Session[]) => {
      const calls = xs.reduce((n, s) => n + (s.tools.get("Bash")?.calls ?? 0), 0);
      const chars = xs.reduce((n, s) => n + (s.tools.get("Bash")?.chars ?? 0), 0);
      return {
        sessions: xs.length,
        bashCalls: calls,
        avgBashTokens: Math.round(chars / 4 / Math.max(1, calls)),
        medianSessionWeighted: Math.round(median(xs.map(weighted))),
      };
    };
    rtk[src] = { withRTK: per(list.filter((s) => s.rtk)), withoutRTK: per(list.filter((s) => !s.rtk)) };
  }
  report.rtk = rtk;

  const memSessions = claude.filter((s) => s.memory.size);
  const memKinds = new Set(memSessions.flatMap((s) => [...s.memory.keys()]));
  report.instructionsPerSession = Object.fromEntries(
    [...memKinds].map((k) => {
      const xs = memSessions.map((s) => s.memory.get(k) ?? 0).filter((n) => n > 0);
      return [
        k,
        { sessions: xs.length, medianTokens: Math.round(median(xs) / 4), maxTokens: Math.round(Math.max(...xs) / 4) },
      ];
    }),
  );
  report.memoryInventory = memoryInventory();
  report.otherMemory = codexMemory();
  report.versions = [...new Set(sessions.flatMap((s) => [...s.versions]))].sort().slice(-6);

  if (asJSON) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const fmt = (n: number) =>
    n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n);
  console.log(`Phiên đã đọc: ${sessions.length} (${days ? `${days} ngày` : "toàn bộ"})\n`);
  console.log("Nguồn                  phiên  lượt   input  out    c.read  c.w5m  c.w1h  hit    RTK  guard >150k");
  for (const [k, v] of Object.entries(bySource) as Array<[string, Group & Record<string, number>]>) {
    console.log(
      `${k.padEnd(22)} ${String(v.sessions).padStart(5)} ${fmt(v.calls).padStart(6)} ${fmt(v.input).padStart(6)} ${fmt(v.output).padStart(6)} ${fmt(v.cacheRead).padStart(7)} ${fmt(v.cacheWrite5m).padStart(6)} ${fmt(v.cacheWrite1h).padStart(6)} ${(v.cacheHit * 100).toFixed(1).padStart(5)}% ${String(v.rtkSessions).padStart(4)} ${String(v.guardSessions).padStart(5)} ${String(v.peakOver150k).padStart(5)}`,
    );
  }
  console.log("\nTool (Claude, không tính test)  lượt   tb/lần  tổng   bị đọc lại  phần");
  for (const t of report.tools as Array<Record<string, number | string>>) {
    console.log(
      `${String(t.name).padEnd(30)} ${fmt(Number(t.calls)).padStart(6)} ${fmt(Number(t.avgTokens)).padStart(7)} ${fmt(Number(t.outputTokens)).padStart(6)} ${fmt(Number(t.carriedTokens)).padStart(10)} ${(Number(t.carriedShare) * 100).toFixed(1).padStart(5)}%`,
    );
  }
  console.log("\nLệnh Bash                      lượt   tb/lần  bị đọc lại");
  for (const t of report.bash as Array<Record<string, number | string>>) {
    console.log(
      `${String(t.name).padEnd(30)} ${fmt(Number(t.calls)).padStart(6)} ${fmt(Number(t.avgTokens)).padStart(7)} ${fmt(Number(t.carriedTokens)).padStart(10)}`,
    );
  }
  console.log("\nĐọc lại file:", JSON.stringify(report.rereads));
  console.log("RTK:", JSON.stringify(report.rtk));
  console.log("Instruction nạp mỗi phiên (token ≈ ký tự/4):", JSON.stringify(report.instructionsPerSession));
  console.log("Memory trên đĩa:", JSON.stringify(report.memoryInventory));
  console.log("Memory CLI khác:", JSON.stringify(report.otherMemory));
  console.log("Phiên bản CLI:", (report.versions as string[]).join(", "));
  console.log("Codex tool:", JSON.stringify(report.codexTools));
}

await main();
