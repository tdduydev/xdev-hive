import * as vscode from "vscode";
import { lang, t } from "@/lib/i18n.ts";
import type { Binary } from "@/worker/bin.ts";
import "@/terminal/strings.ts";

export type TerminalDeps = {
  find: () => Promise<Binary | undefined>;
  sessions: () => Promise<{ sessions: unknown[] }>;
  allowed: () => boolean;
  installCommand?: string;
};

export type SessionItem = {
  id: string;
  cli: string;
  cwd: string;
  started?: string | undefined;
  controlled: boolean;
  viewers: number;
};

export type LaunchSpec = { name: string; shellPath: string; shellArgs: string[]; cwd?: string | undefined };

// Mã phiên đi thẳng vào argv của `hive attach`; chỉ nhận ký tự an toàn để mã lạ không thành cờ.
const SESSION_ID = /^[A-Za-z0-9][\w.-]*$/;

export function attachArgs(id: string, viewOnly: boolean): string[] {
  return viewOnly ? ["attach", id, "--view"] : ["attach", id];
}

// Danh sách đến từ socket của worker nên không tin kiểu dữ liệu: bỏ dòng hỏng thay vì làm hỏng cả menu.
export function parseSessions(raw: unknown[]): SessionItem[] {
  const items: SessionItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const s = entry as Record<string, unknown>;
    if (typeof s.id !== "string" || !SESSION_ID.test(s.id)) continue;
    items.push({
      id: s.id,
      cli: typeof s.cli === "string" ? s.cli : "",
      cwd: typeof s.cwd === "string" ? s.cwd : "",
      started: typeof s.started === "string" ? s.started : undefined,
      controlled: s.controlled === true,
      viewers: Number.isSafeInteger(s.viewers) ? (s.viewers as number) : 0,
    });
  }
  return items;
}

function workspaceCwd(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.scheme === "file" ? folder.uri.fsPath : undefined;
}

function startedLabel(value: string | undefined): string {
  const date = value ? new Date(value) : undefined;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString(lang() === "en" ? "en-US" : "vi-VN") : "?";
}

export class TerminalProfiles {
  private readonly deps: TerminalDeps;
  constructor(deps: TerminalDeps) {
    this.deps = deps;
  }

  /** Trả về binary `hive` hoặc báo lỗi đúng chữ rồi trả `undefined`. */
  private async binary(): Promise<Binary | undefined> {
    if (!this.deps.allowed()) {
      void vscode.window.showWarningMessage(t("terminal.restricted"));
      return undefined;
    }
    const binary = await this.deps.find();
    if (binary) return binary;
    const install = this.deps.installCommand;
    const choice = await vscode.window.showErrorMessage(
      t("terminal.missing"),
      ...(install ? [t("terminal.install")] : []),
    );
    if (install && choice === t("terminal.install")) void vscode.commands.executeCommand(install);
    return undefined;
  }

  async leader(): Promise<LaunchSpec | undefined> {
    const binary = await this.binary();
    if (!binary) return undefined;
    return { name: t("terminal.leader"), shellPath: binary.path, shellArgs: ["chat"], cwd: workspaceCwd() };
  }

  async attach(): Promise<LaunchSpec | undefined> {
    const binary = await this.binary();
    if (!binary) return undefined;
    let sessions: SessionItem[];
    try {
      sessions = parseSessions((await this.deps.sessions()).sessions);
    } catch (error) {
      void vscode.window.showErrorMessage(
        t("terminal.attach.failed", { error: error instanceof Error ? error.message : String(error) }),
      );
      return undefined;
    }
    if (sessions.length === 0) {
      void vscode.window.showInformationMessage(t("terminal.attach.none"));
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      sessions.map((s) => ({
        label: s.id,
        description: [
          s.cli,
          s.controlled ? t("terminal.attach.controlled") : "",
          s.viewers > 0 ? t("terminal.attach.viewers", { count: s.viewers }) : "",
        ]
          .filter(Boolean)
          .join(" · "),
        detail: t("terminal.attach.detail", { cwd: s.cwd, started: startedLabel(s.started) }),
        id: s.id,
      })),
      { placeHolder: t("terminal.attach.placeholder"), matchOnDescription: true, matchOnDetail: true },
    );
    if (!picked) return undefined;
    const mode = await vscode.window.showQuickPick(
      [
        {
          label: t("terminal.attach.mode.control"),
          detail: t("terminal.attach.mode.control.detail"),
          view: false,
        },
        { label: t("terminal.attach.mode.view"), detail: t("terminal.attach.mode.view.detail"), view: true },
      ],
      { placeHolder: t("terminal.attach.mode.placeholder", { id: picked.id }) },
    );
    if (!mode) return undefined;
    return {
      name: t("terminal.attach.name", { id: picked.id }),
      shellPath: binary.path,
      shellArgs: attachArgs(picked.id, mode.view),
      cwd: workspaceCwd(),
    };
  }
}
