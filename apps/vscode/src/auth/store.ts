import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type * as vscode from "vscode";
import { tokenOrg } from "@/auth/pkce.ts";
import { config } from "@/lib/config.ts";
import { type ExecOptions, type ExecResult, exec } from "@/lib/exec.ts";
import { t } from "@/lib/i18n.ts";
import "@/auth/strings.ts";

type Run = (file: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;
export const secretKey = (hub: string) => `xdev-hive.token:${hub}`;
const blockedKey = (hub: string) => `xdev-hive.signedOut:${hub}`;

function binary(): string {
  const name = process.platform === "win32" ? "hive.exe" : "hive";
  if (config.binPath()) return join(config.binPath(), name);
  const shared = join(homedir(), ".xdev-hive", "bin", name);
  return existsSync(shared) ? shared : name;
}

export class TokenStore {
  private readonly secrets: vscode.SecretStorage;
  private readonly run: Run;
  private readonly executable: () => string;
  constructor(secrets: vscode.SecretStorage, run: Run = exec, executable = binary) {
    this.secrets = secrets;
    this.run = run;
    this.executable = executable;
  }

  private async cli(command: string, hub: string, token?: string): Promise<ExecResult | undefined> {
    try {
      const result = await this.run(this.executable(), ["auth", command, "--json", "--hub", hub], {
        ...(token === undefined ? {} : { input: token }),
        timeoutMs: 10_000,
      });
      // CLI cũ trả mã cách dùng khi chưa biết lệnh auth.
      return result.code === 2 ? undefined : result;
    } catch (error) {
      // Máy chưa cài CLI vẫn đăng nhập được bằng SecretStorage.
      if (error instanceof Error && /\bENOENT\b/.test(error.message)) return undefined;
      throw new Error(t("auth.storage"));
    }
  }

  async read(hub: string): Promise<string | undefined> {
    if (await this.secrets.get(blockedKey(hub))) return undefined;
    const result = await this.cli("token", hub);
    if (result?.code === 0) {
      try {
        const data = JSON.parse(result.stdout);
        if (data.hubUrl === hub && typeof data.token === "string" && tokenOrg(data.token)) return data.token;
      } catch {
        /* CLI cũ có thể chưa hỗ trợ JSON. */
      }
    }
    // Mã 3 là đăng xuất chung, không được khôi phục bản sao trong editor.
    if (result?.code === 3) return undefined;
    const token = await this.secrets.get(secretKey(hub));
    return token && tokenOrg(token) ? token : undefined;
  }

  async write(hub: string, token: string): Promise<void> {
    if (!tokenOrg(token)) throw new Error(t("auth.failed"));
    const result = await this.cli("store", hub, token);
    if (result && result.code !== 0) throw new Error(t("auth.storage"));
    await this.secrets.store(secretKey(hub), token);
    await this.secrets.delete(blockedKey(hub));
  }

  async remove(hub: string, shared = false): Promise<void> {
    if (shared) {
      const result = await this.cli("logout", hub);
      if (result && result.code !== 0) throw new Error(t("auth.storage"));
    }
    await this.secrets.store(blockedKey(hub), "true");
    await this.secrets.delete(secretKey(hub));
  }
}
