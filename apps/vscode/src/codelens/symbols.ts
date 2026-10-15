import * as vscode from "vscode";
import { isTasksFile } from "@/codelens/tasks-md.ts";
import { t } from "@/lib/i18n.ts";
import "@/codelens/strings.ts";

// Trần để file sinh ra hàng nghìn hàm không làm editor chậm.
const MAX_LENSES = 200;
// Tra `vscode.SymbolKind` khi dùng chứ không ở mức module, để nạp file này không cần API `vscode` đầy đủ.
const kinds = () => ({
  leaf: new Set<vscode.SymbolKind>([
    vscode.SymbolKind.Function,
    vscode.SymbolKind.Method,
    vscode.SymbolKind.Constructor,
  ]),
  container: new Set<vscode.SymbolKind>([
    vscode.SymbolKind.Class,
    vscode.SymbolKind.Namespace,
    vscode.SymbolKind.Module,
    vscode.SymbolKind.Interface,
    vscode.SymbolKind.Struct,
    vscode.SymbolKind.Object,
  ]),
});

export interface SymbolLensDeps {
  enabled(): boolean;
  trusted(): boolean;
  symbols(uri: vscode.Uri): Thenable<vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined>;
}

function collect(symbols: vscode.DocumentSymbol[], out: vscode.DocumentSymbol[], set = kinds()): void {
  for (const symbol of symbols) {
    if (out.length >= MAX_LENSES) return;
    if (set.leaf.has(symbol.kind)) out.push(symbol);
    // Hàm lồng trong hàm không có lens riêng; chỉ đi vào lớp/module để lấy phương thức.
    else if (set.container.has(symbol.kind)) collect(symbol.children, out, set);
  }
}

export class SymbolLensProvider implements vscode.CodeLensProvider {
  private readonly deps: SymbolLensDeps;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(deps: SymbolLensDeps) {
    this.deps = deps;
  }

  refresh(): void {
    this.changed.fire();
  }

  async provideCodeLenses(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    // Restricted Mode: lens "Giao agent" tắt hẳn, kể cả khi người dùng bật setting.
    if (!this.deps.enabled() || !this.deps.trusted() || isTasksFile(document.uri.fsPath)) return [];
    const result = await this.deps.symbols(document.uri);
    if (token?.isCancellationRequested || !result?.length) return [];
    // `SymbolInformation` không có cây con và không có vùng thân hàm đáng tin; chỉ dùng `DocumentSymbol`.
    const documentSymbols = result.filter((s): s is vscode.DocumentSymbol => "children" in s);
    const picked: vscode.DocumentSymbol[] = [];
    collect(documentSymbols, picked);
    return picked.map(
      (symbol) =>
        new vscode.CodeLens(symbol.range, {
          title: t("codelens.assignSymbol"),
          command: "xdevHive.codelens.assignSymbol",
          arguments: [
            {
              uri: document.uri.toString(),
              name: symbol.name,
              kind: vscode.SymbolKind[symbol.kind]?.toLowerCase() ?? "function",
              startLine: symbol.range.start.line,
              endLine: symbol.range.end.line,
            },
          ],
        }),
    );
  }
}
