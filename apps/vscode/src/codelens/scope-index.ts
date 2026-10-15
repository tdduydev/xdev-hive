import { resolve, sep } from "node:path";
import { parseScopes, specOf } from "@/codelens/tasks-md.ts";

export type ScopeOwner = { code: string; spec: string };
type Matcher = { root: string; test: RegExp; owner: ScopeOwner };

export interface ScopeIndexDeps {
  files(): Promise<string[]>;
  read(fsPath: string): Promise<string>;
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === "*" && pattern[i + 1] === "*") {
      source += ".*";
      i++;
      // `a/**/b` khớp cả `a/b`.
      if (pattern[i + 1] === "/") i++;
    } else if (char === "*") source += "[^/]*";
    else source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** Đường dẫn trong PHẠM VI → task sở hữu. Đọc mỗi `tasks.md` một lần; file đổi thì chỉ đọc lại file đó. */
export class ScopeIndex {
  private readonly deps: ScopeIndexDeps;
  private readonly files = new Map<string, { root: string; spec: string; entries: ReturnType<typeof parseScopes> }>();
  private exact = new Map<string, ScopeOwner[]>();
  private globs: Matcher[] = [];

  constructor(deps: ScopeIndexDeps) {
    this.deps = deps;
  }

  async rebuild(): Promise<void> {
    const paths = await this.deps.files();
    const known = new Set(paths);
    for (const path of this.files.keys()) if (!known.has(path)) this.files.delete(path);
    await Promise.all(paths.map((path) => this.load(path)));
    this.merge();
  }

  async update(fsPath: string): Promise<void> {
    await this.load(fsPath);
    this.merge();
  }

  /** `relative` tính từ `root` (thư mục gốc repo chứa `specs/`). */
  lookup(root: string, relative: string): ScopeOwner[] {
    const path = relative.replaceAll("\\", "/").replace(/^\.\//, "");
    const key = `${resolve(root)}\0${path}`;
    const owners = [...(this.exact.get(key) ?? [])];
    for (const matcher of this.globs) {
      if (matcher.root === resolve(root) && matcher.test.test(path) && !owners.includes(matcher.owner))
        owners.push(matcher.owner);
    }
    return owners;
  }

  rootOf(fsPath: string): string | undefined {
    const target = resolve(fsPath);
    let best: string | undefined;
    for (const { root } of this.files.values()) {
      if ((target === root || target.startsWith(root + sep)) && (!best || root.length > best.length)) best = root;
    }
    return best;
  }

  private async load(fsPath: string): Promise<void> {
    try {
      const { root, spec } = specOf(fsPath);
      this.files.set(fsPath, { root: resolve(root), spec, entries: parseScopes(await this.deps.read(fsPath)) });
    } catch {
      // File đang bị ghi dở hoặc không đọc được: bỏ nó khỏi chỉ mục, lần sửa sau sẽ nạp lại.
      this.files.delete(fsPath);
    }
  }

  private merge(): void {
    this.exact = new Map();
    this.globs = [];
    for (const { root, spec, entries } of this.files.values()) {
      for (const { code, paths } of entries) {
        const owner = { code, spec };
        for (const path of paths) {
          const key = `${root}\0${path}`;
          const list = this.exact.get(key) ?? [];
          list.push(owner);
          this.exact.set(key, list);
          if (path.includes("*")) this.globs.push({ root, test: globToRegExp(path), owner });
        }
      }
    }
  }
}
