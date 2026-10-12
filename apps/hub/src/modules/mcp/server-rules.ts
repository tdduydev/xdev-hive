import { type JobMcpServer, type McpServerLaunch, mcpServerKey, RESERVED_MCP_SERVER_KEYS } from "@xdev-hive/contracts";

/** Phần của một dòng mcp_server_rules mà bộ quyết định cần; không phụ thuộc database để test thuần. */
export interface ServerRule {
  id: string;
  name: string;
  rule: "allow" | "deny";
  matchType: "name" | "url" | "command" | "wildcard";
  pattern: string;
  projectId: string | null;
  launch: McpServerLaunch | null;
  createdAt: Date;
}

/** Server đem ra so với quy tắc: tên trong cấu hình CLI, tên hiển thị, dòng lệnh (stdio) hoặc URL (HTTP). */
export interface ServerIdentity {
  key: string;
  name: string;
  command: string[] | null;
  url: string | null;
}

export interface Decision {
  allowed: boolean;
  /** null khi không quy tắc nào khớp: server không có trong danh sách cho phép thì bị chặn. */
  by: ServerRule | null;
}

export interface EffectiveServer {
  rule: ServerRule;
  key: string;
  launch: McpServerLaunch;
  decision: Decision;
}

const escapeRegex = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
/** `*` khớp mọi chuỗi (kể cả rỗng); mọi ký tự khác khớp đúng nó. */
function glob(pattern: string, value: string, caseInsensitive: boolean): boolean {
  const source = `^${pattern.split("*").map(escapeRegex).join(".*")}$`;
  return new RegExp(source, caseInsensitive ? "i" : "").test(value);
}

export const commandTokens = (text: string) => text.trim().split(/\s+/).filter(Boolean);
const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * Một từ của mẫu lệnh khớp một tham số khi khớp glob, hoặc tham số là chính gói đó kèm phiên bản npm
 * ("@playwright/mcp" khớp "@playwright/mcp@latest"); không thì chỉ cần thêm "@phiên-bản" là lách được quy tắc chặn.
 */
function tokenMatches(pattern: string, token: string): boolean {
  if (glob(pattern, token, false)) return true;
  const at = token.lastIndexOf("@");
  return at > 0 && glob(pattern, token.slice(0, at), false);
}

/**
 * Mẫu lệnh khớp khi từ đầu khớp chương trình (so tên file nếu mẫu không có đường dẫn) và các từ còn lại xuất hiện theo
 * đúng thứ tự trong tham số. Cho phép xen cờ ở giữa vì "npx -y @modelcontextprotocol/server-filesystem" vẫn là
 * server-filesystem; so khớp đúng từng vị trí thì quy tắc chặn bị lách bằng một cờ thừa.
 */
function commandMatches(pattern: string, command: string[]): boolean {
  const [program, ...rest] = commandTokens(pattern);
  const [actual, ...args] = command;
  if (!program || !actual) return false;
  const exe = /[\\/]/.test(program) ? actual : basename(actual);
  if (!glob(program, exe, false) && !glob(program, exe.replace(/\.(cmd|exe|bat)$/i, ""), false)) return false;
  let i = 0;
  for (const want of rest) {
    while (i < args.length && !tokenMatches(want, args[i] ?? "")) i++;
    if (i >= args.length) return false;
    i++;
  }
  return true;
}

export function ruleMatches(rule: Pick<ServerRule, "matchType" | "pattern">, server: ServerIdentity): boolean {
  switch (rule.matchType) {
    case "wildcard":
      return true;
    case "name":
      return glob(rule.pattern, server.key, true) || glob(rule.pattern, server.name, true);
    case "url":
      return server.url !== null && glob(rule.pattern.replace(/\/+$/, ""), server.url.replace(/\/+$/, ""), true);
    case "command":
      return server.command !== null && commandMatches(rule.pattern, server.command);
  }
}

export function identityOf(name: string, launch: McpServerLaunch): ServerIdentity {
  return {
    key: mcpServerKey(name),
    name,
    command: launch.transport === "stdio" ? [launch.command, ...launch.args] : null,
    url: launch.transport === "http" ? launch.url : null,
  };
}

/**
 * Chặn thắng cho phép. Quy tắc cụ thể (tên, URL, lệnh) quyết định trước; quy tắc `*` chỉ áp cho server không khớp quy
 * tắc cụ thể nào, nên "* chặn" cùng "github cho phép" nghĩa là chỉ github được dùng (spec 003, Edge Cases). Không quy
 * tắc nào khớp thì chặn. Quy tắc của dự án cộng thêm vào quy tắc tổ chức, không thay được quy tắc chặn của tổ chức.
 */
export function decide(rules: readonly ServerRule[], server: ServerIdentity): Decision {
  const specific = rules.filter((r) => r.matchType !== "wildcard" && ruleMatches(r, server));
  const tier = specific.length ? specific : rules.filter((r) => r.matchType === "wildcard");
  const deny = tier.find((r) => r.rule === "deny");
  if (deny) return { allowed: false, by: deny };
  const allow = tier.find((r) => r.rule === "allow");
  return allow ? { allowed: true, by: allow } : { allowed: false, by: null };
}

const byAge = (a: ServerRule, b: ServerRule) =>
  a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);

/**
 * Server ngoài của tổ chức (`projectId` null) hoặc của một dự án: mọi dòng có cấu hình khởi chạy trong phạm vi, mỗi
 * dòng kèm quyết định. Dự án định nghĩa lại cùng tên thì thay định nghĩa của tổ chức; tên dành cho cổng MCP của hub
 * không bao giờ được phát.
 */
export function resolveServers(rules: readonly ServerRule[], projectId: string | null): EffectiveServer[] {
  const applicable = rules.filter((r) => r.projectId === null || r.projectId === projectId).sort(byAge);
  const chosen = new Map<string, ServerRule>();
  for (const rule of applicable) {
    if (!rule.launch) continue;
    const key = mcpServerKey(rule.name);
    if (RESERVED_MCP_SERVER_KEYS.includes(key)) continue;
    const current = chosen.get(key);
    if (!current || (current.projectId === null && rule.projectId !== null)) chosen.set(key, rule);
  }
  return [...chosen.entries()]
    .map(([key, rule]) => {
      const launch = rule.launch as McpServerLaunch;
      return { rule, key, launch, decision: decide(applicable, identityOf(rule.name, launch)) };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Gói `mcpServers` của job_offer: chỉ server được phép, chỉ những trường cần để khởi chạy. */
export function jobServers(effective: readonly EffectiveServer[]): JobMcpServer[] {
  return effective
    .filter((s) => s.decision.allowed)
    .map(({ key, launch }) =>
      launch.transport === "stdio"
        ? { name: key, transport: "stdio", command: launch.command, args: [...launch.args] }
        : { name: key, transport: "http", url: launch.url },
    );
}
