import { useCallback, useSyncExternalStore } from "react";
import { invoke } from "@/lib/tauri.ts";

/** Nơi cài skill, khớp `Target` trong src-tauri/src/skills.rs. */
export type Target = "project" | "user";

/** Skill đang có trên máy (installed_skills). `version` null là skill người dùng tự đặt, app không quản. */
export interface InstalledSkill {
  name: string;
  version: number | null;
  modified: boolean;
  dirs: string[];
  text: string;
}

export interface ApplyResult {
  done: string[];
  conflicts: string[];
}

/** Skill trên hub theo skill_list; `hidden` là bản phạm vi rộng hơn bị bản hẹp hơn che. */
export interface HubSkillItem {
  name: string;
  description: string;
  scope: "org" | "team" | "project";
  version: number;
  teamId?: string;
  repoPath?: string;
}

export interface SkillFile {
  name: string;
  version: number;
  text: string;
}

export const CLI_DIRS: Record<Target, { claude: string; codex: string }> = {
  project: { claude: ".claude/skills", codex: ".agents/skills" },
  user: { claude: "~/.claude/skills", codex: "~/.codex/skills" },
};

const folderArg = (target: Target, folder: string) => (target === "project" ? folder : null);

export const installedSkills = (target: Target, folder: string) =>
  invoke<InstalledSkill[]>("installed_skills", { target, folder: folderArg(target, folder) });

export const installSkills = (target: Target, folder: string, files: SkillFile[], force = false) =>
  invoke<ApplyResult>("install_skills", { target, folder: folderArg(target, folder), files, force });

export const removeSkills = (target: Target, folder: string, names: string[], force = false) =>
  invoke<ApplyResult>("remove_skills", { target, folder: folderArg(target, folder), names, force });

/** Số lần agent gọi từng skill trong 30 ngày, theo phiên Claude Code trên máy. */
export const skillUses = (folder: string | null) =>
  invoke<Record<string, number>>("skill_uses", { folder: folder || null });

export const proposeSkill = (input: {
  name: string;
  project: string | null;
  baseVersion: number;
  text: string;
  note: string;
}) => invoke<{ proposalId: string }>("propose_skill", input);

/** Giống renderSkillFile của hub (knowledge/skill-repo.ts): file cài trên máy trùng file trong kho skill Git. */
export function renderSkillFile(name: string, description: string, content: string): string {
  if (/^---\r?\n/.test(content)) return content.endsWith("\n") ? content : `${content}\n`;
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${content.trim()}\n`;
}

/**
 * Token skill chiếm khi chưa dùng: CLI chỉ nạp tên và mô tả vào ngữ cảnh cho tới khi gọi skill. Ước lượng 4 ký tự
 * một token, cộng phần khung; giao diện ghi "~".
 */
export const idleTokens = (s: { name: string; description: string }) =>
  Math.ceil((s.name.length + s.description.length + 24) / 4);

export type SkillState = "installed" | "update" | "missing" | "off" | "modified" | "own" | "shadowed" | "gone";

/** Trạng thái trên máy của một skill hub (hoặc chỉ có trên máy khi `hub` null). */
export function skillState(hub: HubSkillItem | null, local: InstalledSkill | undefined, off: boolean): SkillState {
  if (!hub) return local?.version == null ? "own" : "gone";
  if (!local) return off ? "off" : "missing";
  if (local.version == null) return "own";
  if (local.modified) return "modified";
  return local.version < hub.version ? "update" : "installed";
}

/** Skill người dùng đã tắt, theo nơi cài: "Đồng bộ" không cài lại. Nhớ trên máy này. */
const OFF_KEY = "hive.skills.off";
const offListeners = new Set<() => void>();

function readOffRaw(): string {
  try {
    return localStorage.getItem(OFF_KEY) ?? "{}";
  } catch {
    return "{}";
  }
}

function offMap(): Record<string, string[]> {
  try {
    return JSON.parse(readOffRaw()) as Record<string, string[]>;
  } catch {
    return {};
  }
}

export const offKey = (target: Target, folder: string) => (target === "user" ? "user" : `project:${folder}`);

export function setOff(key: string, names: string[], off: boolean): void {
  const map = offMap();
  const cur = new Set(map[key] ?? []);
  for (const n of names) {
    if (off) cur.add(n);
    else cur.delete(n);
  }
  map[key] = [...cur].sort();
  try {
    localStorage.setItem(OFF_KEY, JSON.stringify(map));
  } catch {
    /* Không nhớ được thì lần đồng bộ sau có thể cài lại; người dùng tắt lại được. */
  }
  for (const l of offListeners) l();
}

function subscribeOff(listener: () => void) {
  offListeners.add(listener);
  return () => {
    offListeners.delete(listener);
  };
}

/** Danh sách skill đã tắt ở nơi cài đang chọn. */
export function useOff(key: string): [Set<string>, (names: string[], off: boolean) => void] {
  const raw = useSyncExternalStore(subscribeOff, readOffRaw, () => "{}");
  const set = new Set<string>(
    ((): string[] => {
      try {
        return (JSON.parse(raw) as Record<string, string[]>)[key] ?? [];
      } catch {
        return [];
      }
    })(),
  );
  return [set, useCallback((names: string[], off: boolean) => setOff(key, names, off), [key])];
}

export type DiffLine = { kind: "same" | "add" | "del"; text: string };

/**
 * So dòng giữa bản trên máy và bản trên hub (LCS). SKILL.md thường vài trăm dòng; quá 600 dòng thì chỉ báo khác cả
 * file để khỏi tốn bộ nhớ O(n·m).
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const b = after.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  if (a.length * b.length > 360_000) {
    return [...a.map((text) => ({ kind: "del" as const, text })), ...b.map((text) => ({ kind: "add" as const, text }))];
  }
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      row[j] = a[i] === b[j] ? (lcs[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] as string });
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      out.push({ kind: "del", text: a[i++] as string });
    } else {
      out.push({ kind: "add", text: b[j++] as string });
    }
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++] as string });
  while (j < b.length) out.push({ kind: "add", text: b[j++] as string });
  return out;
}

/** Chỉ giữ dòng đổi và 1 dòng quanh mỗi chỗ đổi, như phần "Thay đổi" của thiết kế. */
export function diffHunks(lines: DiffLine[], context = 1): (DiffLine | null)[] {
  const keep = lines.map(() => false);
  lines.forEach((l, i) => {
    if (l.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: (DiffLine | null)[] = [];
  lines.forEach((l, i) => {
    if (keep[i]) out.push(l);
    else if (out.length && out.at(-1) !== null) out.push(null);
  });
  if (out.at(-1) === null) out.pop();
  return out;
}
