import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { config } from "@/lib/config.ts";
import { t } from "@/lib/i18n.ts";
import "@/auth/strings.ts";

export function normalizeHub(raw: string): string {
  try {
    const url = new URL(raw.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw 0;
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw new Error(t("auth.badUrl"));
  }
}

export function configFiles(): string[] {
  const dir =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : process.platform === "win32"
        ? process.env.APPDATA || join(homedir(), "AppData", "Roaming")
        : process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return [
    process.env.HIVE_CLI_CONFIG || join(dir, "xdev-hive", "hive.json"),
    process.env.HIVE_WORKER_CONFIG || join(dir, "xdev-hive", "worker.json"),
  ];
}

export async function hubUrl(files = configFiles()): Promise<string | undefined> {
  if (config.hubUrl()) return normalizeHub(config.hubUrl());
  for (const file of files) {
    try {
      const data = JSON.parse(await readFile(file, "utf8"));
      if (typeof data.hubUrl === "string" && data.hubUrl) return normalizeHub(data.hubUrl);
    } catch {
      // Cấu hình CLI hỏng không được chặn người dùng nhập URL trong editor.
    }
  }
  return undefined;
}

export async function setHubUrl(): Promise<string | undefined> {
  const raw = await vscode.window.showInputBox({ title: t("auth.url"), value: config.hubUrl(), ignoreFocusOut: true });
  if (raw === undefined) return undefined;
  const hub = normalizeHub(raw);
  try {
    const response = await fetch(`${hub}/api/v1/health`, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    const data = (await response.json()) as { status?: string };
    if (!response.ok || data.status !== "ok") throw 0;
  } catch {
    throw new Error(t("auth.health"));
  }
  await vscode.workspace.getConfiguration("xdevHive").update("hubUrl", hub, vscode.ConfigurationTarget.Global);
  return hub;
}
