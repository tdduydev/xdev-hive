import * as vscode from "vscode";

export type Lang = "vi" | "en";
export type Dict = Record<string, string>;

// Từ điển gom theo phần: mỗi phần có `strings.ts` riêng và đăng ký ở đây để `t()` tra được.
const dicts: Record<Lang, Dict> = { vi: {}, en: {} };

export function addStrings(vi: Dict, en: Dict): void {
  Object.assign(dicts.vi, vi);
  Object.assign(dicts.en, en);
}

export function lang(): Lang {
  const setting = vscode.workspace.getConfiguration("xdevHive").get<string>("language", "vi");
  return setting === "en" ? "en" : "vi";
}

/** Thiếu khoá ở en thì lùi về vi; thiếu cả hai thì trả chính khoá để lộ ra khi test. */
export function t(key: string, params: Record<string, string | number> = {}): string {
  const text = dicts[lang()][key] ?? dicts.vi[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}
