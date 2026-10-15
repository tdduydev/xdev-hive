import { basename, dirname } from "node:path";

export type TaskLine = { line: number; code: string; title: string; done: boolean };
export type ScopeEntry = { code: string; paths: string[] };

const TASK_LINE = /^- \[([ xX])\] \*\*(T\d{3}[a-z]?)\b([^*]*)\*\*/;
const SCOPE_LINE = /^(\s*)- \*\*PHẠM VI\*\*:?(.*)$/;
const BACKTICK = /`([^`\s]+)`/g;

/** Chỉ `specs/<thư-mục>/tasks.md`; dùng cùng cho CodeLens và chỉ mục PHẠM VI. */
export function isTasksFile(fsPath: string): boolean {
  const normalized = fsPath.replaceAll("\\", "/");
  return /(^|\/)specs\/[^/]+\/tasks\.md$/.test(normalized);
}

/** `.../specs/017-vscode-extension/tasks.md` → thư mục gốc repo và số spec ("017"). */
export function specOf(fsPath: string): { root: string; spec: string } {
  const folder = dirname(fsPath);
  const name = basename(folder);
  return { root: dirname(dirname(folder)), spec: /^(\d+)/.exec(name)?.[1] ?? name };
}

export function parseTasks(text: string): TaskLine[] {
  const tasks: TaskLine[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    // Chặn sớm bằng ký tự đầu để tài liệu dài không chạy regex cho từng dòng.
    if (line.charCodeAt(0) !== 45) continue;
    const match = TASK_LINE.exec(line);
    if (!match) continue;
    const heading = (match[3] ?? "").trim();
    // "T023 [P] [US10] [vừa] · 1,5 ngày — CodeLens và Hover": tiêu đề là phần sau dấu gạch dài nếu có.
    const dash = heading.indexOf("—");
    tasks.push({
      line: i,
      code: match[2] as string,
      title: (dash >= 0 ? heading.slice(dash + 1) : heading).trim(),
      done: match[1] !== " ",
    });
  }
  return tasks;
}

function pathLike(value: string): boolean {
  return !value.startsWith("-") && (value.includes("/") || /\.\w+$/.test(value));
}

/** Đọc mục PHẠM VI của từng task: các đường dẫn nằm trong dấu huyền, ở dòng khai báo và các dòng thụt sâu hơn sau nó. */
export function parseScopes(text: string): ScopeEntry[] {
  const entries: ScopeEntry[] = [];
  let current: ScopeEntry | undefined;
  let scopeIndent = -1;
  const collect = (source: string) => {
    for (const match of source.matchAll(BACKTICK)) {
      const value = (match[1] as string).replaceAll("\\", "/").replace(/^\.\//, "");
      if (current && pathLike(value) && !current.paths.includes(value)) current.paths.push(value);
    }
  };
  for (const line of text.split("\n")) {
    const task = TASK_LINE.exec(line);
    if (task) {
      current = { code: task[2] as string, paths: [] };
      entries.push(current);
      scopeIndent = -1;
      continue;
    }
    if (/^#{1,6} /.test(line)) {
      current = undefined;
      scopeIndent = -1;
      continue;
    }
    if (!current) continue;
    const scope = SCOPE_LINE.exec(line);
    if (scope) {
      scopeIndent = (scope[1] as string).length;
      collect(scope[2] as string);
      continue;
    }
    if (scopeIndent < 0 || !line.trim()) continue;
    if ((/^\s*/.exec(line) as RegExpExecArray)[0].length > scopeIndent) collect(line);
    else scopeIndent = -1;
  }
  return entries.filter((entry) => entry.paths.length > 0);
}
