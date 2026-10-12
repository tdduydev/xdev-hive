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

// So dòng dùng chung với màn Tài liệu; giữ export ở đây cho màn Skills.
export { type DiffLine, diffHunks, lineDiff } from "@/lib/diff.ts";
