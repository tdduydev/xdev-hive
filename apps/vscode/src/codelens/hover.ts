import * as vscode from "vscode";
import { isInstructionFile, type MemoryTokens } from "@/codelens/memory-tokens.ts";
import type { ScopeIndex } from "@/codelens/scope-index.ts";
import { t } from "@/lib/i18n.ts";
import "@/codelens/strings.ts";

// Ký tự có thể nằm trong đường dẫn repo; dấu `*` để hover cả mẫu glob ghi ở PHẠM VI.
const PATH_TOKEN = /[\w@.*\\/-]+/g;
const MAX_LINE = 2000;

export interface HoverDeps {
  enabled(): boolean;
  index: ScopeIndex;
  tokens: MemoryTokens;
}

function markdown(value: string): vscode.MarkdownString {
  // Nội dung gồm tên file và số; không bao giờ cho lệnh hay HTML.
  const md = new vscode.MarkdownString(value);
  md.isTrusted = false;
  md.supportHtml = false;
  return md;
}

function pathAt(line: string, character: number): { value: string; start: number } | undefined {
  if (line.length > MAX_LINE) return undefined;
  for (const match of line.matchAll(PATH_TOKEN)) {
    const start = match.index;
    if (character < start || character > start + match[0].length) continue;
    // Dấu chấm câu cuối câu không thuộc đường dẫn.
    const value = match[0].replace(/[.,]+$/, "");
    return value ? { value, start } : undefined;
  }
  return undefined;
}

export class Hovers implements vscode.HoverProvider {
  private readonly deps: HoverDeps;

  constructor(deps: HoverDeps) {
    this.deps = deps;
  }

  async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    if (!this.deps.enabled()) return undefined;
    const parts: vscode.MarkdownString[] = [];
    let range: vscode.Range | undefined;

    const found = pathAt(document.lineAt(position.line).text, position.character);
    const root = this.deps.index.rootOf(document.uri.fsPath);
    if (found && root) {
      const owners = this.deps.index.lookup(root, found.value);
      for (const owner of owners) parts.push(markdown(t("codelens.hoverScope", owner)));
      if (owners.length)
        range = new vscode.Range(position.line, found.start, position.line, found.start + found.value.length);
    }

    if (isInstructionFile(document.uri.fsPath) && position.line === firstContentLine(document)) {
      const { tokens, rough } = await this.deps.tokens.estimate(document.uri.fsPath, document.getText());
      parts.push(markdown(t(rough ? "codelens.hoverTokensRough" : "codelens.hoverTokens", { tokens })));
      range ??= document.lineAt(position.line).range;
    }
    return parts.length ? new vscode.Hover(parts, range) : undefined;
  }
}

function firstContentLine(document: vscode.TextDocument): number {
  const limit = Math.min(document.lineCount, 20);
  for (let i = 0; i < limit; i++) if (document.lineAt(i).text.trim()) return i;
  return 0;
}
