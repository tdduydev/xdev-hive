import * as vscode from "vscode";
import { t } from "@/lib/i18n.ts";
import type { ContextPack } from "@/local/context-pack.ts";
import { documentUri, PACK_DOC } from "@/local/document.ts";
import { type MemoryFile, type MemoryProject, memoryProjects, memoryScan } from "@/local/memory.ts";
import { type OptimizeProfile, optimizeStatus } from "@/local/optimize.ts";
import { LocalError, localAvailable } from "@/local/worker.ts";
import "@/local/strings.ts";

type Section = "worker" | "optimize" | "memory" | "contextPack";
export type MachineNode =
  | { type: "section"; id: Section }
  | { type: "profile"; profile: OptimizeProfile }
  | { type: "project"; project: MemoryProject }
  | { type: "file"; file: MemoryFile }
  | { type: "pack"; pack: ContextPack }
  | { type: "info"; text: string; error?: boolean };

export type MachineOptions = {
  workspaces: () => string[];
  /** Trạng thái worker để hiện ở đầu view; thiếu thì bỏ mục này. `missing` là chưa có binary. */
  worker: () => { text: string; description?: string; missing: boolean } | undefined;
};

const info = (text: string, error = false): MachineNode => ({ type: "info", text, error });
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** View "Máy này": chỉ gọi hive-worker tại máy, không mạng, nên dùng được khi chưa đăng nhập hub. */
export class MachineTree implements vscode.TreeDataProvider<MachineNode> {
  private readonly changed = new vscode.EventEmitter<MachineNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  // Mỗi mục đọc một lần cho tới khi làm mới: quét memory và gọi optimize chậm hơn một lần vẽ cây.
  private readonly cache = new Map<Section, Promise<MachineNode[]>>();
  private lastPack: ContextPack | undefined;
  private readonly options: MachineOptions;

  constructor(options: MachineOptions) {
    this.options = options;
  }

  refresh(section?: Section): void {
    if (section) this.cache.delete(section);
    else this.cache.clear();
    this.changed.fire(undefined);
  }

  setPack(pack: ContextPack): void {
    this.lastPack = pack;
    this.refresh("contextPack");
  }

  pack(): ContextPack | undefined {
    return this.lastPack;
  }

  getChildren(node?: MachineNode): Promise<MachineNode[]> | MachineNode[] {
    if (!node) return this.roots();
    if (node.type === "section") return this.section(node.id);
    if (node.type === "project") return node.project.files.map((file) => ({ type: "file", file }));
    return [];
  }

  private roots(): MachineNode[] {
    const worker = this.options.worker();
    // Chưa có binary thì để trống: `viewsWelcome` hiện lời mời cài.
    if (worker?.missing) return [];
    const sections: Section[] = ["optimize", "memory", "contextPack"];
    return [...(worker ? (["worker"] as const) : []), ...sections].map((id) => ({ type: "section", id }));
  }

  private section(id: Section): Promise<MachineNode[]> | MachineNode[] {
    if (id === "worker") return [];
    if (id === "contextPack") {
      return [this.lastPack ? { type: "pack", pack: this.lastPack } : info(t("view.contextPack.empty"))];
    }
    const state = localAvailable();
    if (state !== "ok") return [info(t(state === "untrusted" ? "local.untrusted" : "local.unavailable"))];
    let loaded = this.cache.get(id);
    if (!loaded) {
      loaded = (id === "optimize" ? this.loadOptimize() : this.loadMemory()).catch((e) => [
        info(t("view.error", { message: e instanceof LocalError ? e.message : message(e) }), true),
      ]);
      this.cache.set(id, loaded);
    }
    return loaded;
  }

  private async loadOptimize(): Promise<MachineNode[]> {
    const profiles = await optimizeStatus();
    if (profiles.length === 0) return [info(t("view.optimize.empty"))];
    return profiles.map((profile) => ({ type: "profile", profile }));
  }

  private async loadMemory(): Promise<MachineNode[]> {
    const projects = memoryProjects(await memoryScan(), this.options.workspaces());
    if (projects.length === 0) return [info(t("view.memory.empty"))];
    return projects.map((project) => ({ type: "project", project }));
  }

  getTreeItem(node: MachineNode): vscode.TreeItem {
    switch (node.type) {
      case "section": {
        if (node.id === "worker") {
          const w = this.options.worker();
          const item = new vscode.TreeItem(w?.text ?? t("view.worker"), vscode.TreeItemCollapsibleState.None);
          if (w?.description) item.description = w.description;
          item.iconPath = new vscode.ThemeIcon("server");
          item.contextValue = "machine.worker";
          return item;
        }
        const icons = { optimize: "dashboard", memory: "book", contextPack: "package" } as const;
        const item = new vscode.TreeItem(
          t(`view.${node.id}`),
          node.id === "memory" ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
        );
        item.id = `section.${node.id}`;
        item.iconPath = new vscode.ThemeIcon(icons[node.id]);
        item.contextValue = `machine.section.${node.id}`;
        return item;
      }
      case "profile": {
        const p = node.profile;
        const item = new vscode.TreeItem(p.label || p.id, vscode.TreeItemCollapsibleState.None);
        item.id = `profile.${p.id}`;
        const state = !p.supported ? "unsupported" : p.enabled ? "on" : "off";
        item.description = [t(`view.optimize.${state}`), p.enabled ? p.level : undefined].filter(Boolean).join(" · ");
        if (p.reason) item.tooltip = p.reason;
        item.iconPath = new vscode.ThemeIcon(p.enabled ? "pass-filled" : "circle-outline");
        // Gói không hỗ trợ không có nút Bật/Tắt (khớp `when` trong manifest).
        item.contextValue = p.supported
          ? `machine.optimize.${p.enabled ? "on" : "off"}`
          : "machine.optimize.unsupported";
        return item;
      }
      case "project": {
        const p = node.project;
        const item = new vscode.TreeItem(p.label || t("view.memory.shared"), vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `project.${p.id}`;
        item.description = t("view.memory.tokens", { tokens: p.tokens });
        item.tooltip = p.path;
        item.iconPath = new vscode.ThemeIcon("folder");
        item.contextValue = "machine.project";
        return item;
      }
      case "file": {
        const f = node.file;
        const flags = f.flags ?? [];
        const item = new vscode.TreeItem(f.name, vscode.TreeItemCollapsibleState.None);
        item.description = [`~${f.tokens}`, ...flags.map((x) => x.message)].join(" · ");
        item.tooltip = [f.path, ...flags.map((x) => x.message)].join("\n");
        item.iconPath = new vscode.ThemeIcon(flags.length > 0 ? "warning" : "file");
        item.resourceUri = vscode.Uri.file(f.path);
        item.command = { command: "vscode.open", title: f.name, arguments: [vscode.Uri.file(f.path)] };
        item.contextValue = "machine.memoryFile";
        return item;
      }
      case "pack": {
        const item = new vscode.TreeItem(t("view.contextPack"), vscode.TreeItemCollapsibleState.None);
        item.description = t("view.contextPack.last", { files: node.pack.files.length, tokens: node.pack.tokens });
        item.tooltip = node.pack.files.join("\n");
        item.iconPath = new vscode.ThemeIcon("markdown");
        item.command = { command: "vscode.open", title: t("view.contextPack"), arguments: [documentUri(PACK_DOC)] };
        item.contextValue = "machine.contextPack";
        return item;
      }
      case "info": {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(node.error ? "error" : "info");
        return item;
      }
    }
  }
}
