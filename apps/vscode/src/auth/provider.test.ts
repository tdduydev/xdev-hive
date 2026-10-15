import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createConnection, createServer as createProxy } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as VSCode from "vscode";
import * as vscode from "vscode";
import { setHubUrl } from "@/auth/hub-url.ts";
import { HiveAuthenticationProvider } from "@/auth/provider.ts";
import { secretKey, TokenStore } from "@/auth/store.ts";
import { orgId, secrets, token } from "@/auth/test-support.ts";
import { initLog } from "@/lib/log.ts";

vi.mock("@/auth/hub-url.ts", async (original) => {
  const base = await original<typeof import("@/auth/hub-url.ts")>();
  return { ...base, setHubUrl: vi.fn() };
});

vi.mock("vscode", async (original) => {
  const base = await original<typeof VSCode>();
  return {
    ...base,
    env: { ...base.env, openExternal: vi.fn(), asExternalUri: vi.fn(), remoteName: undefined },
    window: { ...base.window, showWarningMessage: vi.fn() },
  };
});

let server: Server;
let hub: string;
let unauthorized = false;
let exchange: { code: string; verifier: string } | undefined;
let browserUrl: URL | undefined;
const providers: HiveAuthenticationProvider[] = [];
const seenHeaders: string[] = [];
const output: string[] = [];

beforeEach(async () => {
  unauthorized = false;
  exchange = undefined;
  browserUrl = undefined;
  seenHeaders.length = 0;
  output.length = 0;
  vi.clearAllMocks();
  vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined);
  vi.spyOn(vscode.window, "createOutputChannel").mockReturnValue({
    appendLine: (line: string) => output.push(line),
    dispose() {},
  } as unknown as VSCode.LogOutputChannel);
  initLog({ subscriptions: [] } as unknown as VSCode.ExtensionContext);
  server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/v1/desktop/connect/exchange") {
      let body = "";
      for await (const chunk of req) body += chunk;
      exchange = JSON.parse(body);
      res.end(JSON.stringify({ personalToken: token, purpose: "cli" }));
      return;
    }
    seenHeaders.push(`${req.headers.authorization}|${req.headers["x-hive-org"]}`);
    if (unauthorized) {
      res.writeHead(401).end(JSON.stringify({ error: token }));
      return;
    }
    if (req.url === "/api/v1/me") res.end(JSON.stringify({ id: "dev", name: "Người dùng", email: "dev@example.com" }));
    else if (req.url === `/api/v1/orgs/${orgId}`)
      res.end(JSON.stringify({ id: orgId, name: "Đội Hive", role: "member" }));
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Không mở được hub giả");
  hub = `http://127.0.0.1:${addr.port}`;
  Object.assign(vscode.env, { remoteName: undefined });
  vi.mocked(vscode.env.asExternalUri).mockImplementation(async (uri) => uri);
  vi.mocked(vscode.env.openExternal).mockImplementation(async (uri) => {
    browserUrl = new URL(uri.toString());
    const params = browserUrl.searchParams;
    const callback = `http://127.0.0.1:${params.get("port")}/callback`;
    expect((await fetch(`${callback}?state=wrong&code=bad`)).status).toBe(400);
    await fetch(`${callback}?${new URLSearchParams({ state: params.get("state") ?? "", code: "one-use-code" })}`);
    return true;
  });
});

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.dispose();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function setup(secret = secrets(), run = vi.fn().mockRejectedValue(new Error("ENOENT"))) {
  const provider = new HiveAuthenticationProvider(new TokenStore(secret, run, () => "fake-hive"), async () => hub);
  providers.push(provider);
  return { provider, secret, run };
}

describe("Authentication Provider với hub HTTP giả", () => {
  it("PKCE, purpose cli, hồ sơ, vai trò, SecretStorage và không lọt token vào Output", async () => {
    const { provider, secret } = setup();
    const changes = vi.fn();
    provider.onDidChangeSessions(changes);
    const session = await provider.createSession();
    expect(session).toMatchObject({
      accessToken: token,
      orgId,
      role: "member",
      account: { label: "Người dùng · Đội Hive" },
    });
    expect(browserUrl?.searchParams.get("purpose")).toBe("cli");
    expect(exchange?.code).toBe("one-use-code");
    expect(
      createHash("sha256")
        .update(exchange?.verifier ?? "")
        .digest("base64url"),
    ).toBe(browserUrl?.searchParams.get("challenge"));
    expect(secret.data.get(secretKey(hub))).toBe(token);
    expect(seenHeaders).toEqual([`Bearer ${token}|${orgId}`, `Bearer ${token}|${orgId}`]);
    expect(changes).toHaveBeenCalledWith(expect.objectContaining({ added: [session] }));
    expect(output.join("\n")).not.toContain(token);
    expect(output.join("\n")).not.toContain("hive_pat_");
  });

  it("khôi phục âm thầm từ CLI; cửa sổ thứ hai thấy phiên và thay đổi", async () => {
    const secret = secrets();
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: JSON.stringify({ hubUrl: hub, token }), stderr: "" });
    const first = setup(secret, run).provider;
    const second = setup(secret, run).provider;
    expect(await first.getSessions()).toHaveLength(1);
    expect(await second.getSessions()).toHaveLength(1);
    expect(vscode.env.openExternal).not.toHaveBeenCalled();
    const changed = vi.fn();
    second.onDidChangeSessions(changed);
    run.mockResolvedValue({ code: 3, stdout: "{}", stderr: "" });
    expect(await second.getSessions()).toEqual([]);
    expect(changed.mock.calls.at(-1)?.[0].removed).toHaveLength(1);
  });

  it("401 gỡ phiên và không hỏi đăng nhập liên tục", async () => {
    const { provider } = setup();
    await provider.createSession();
    const events = vi.fn();
    provider.onDidChangeSessions(events);
    unauthorized = true;
    await expect(provider.getSessions()).rejects.toThrow("hết hạn");
    expect(await provider.getSessions()).toEqual([]);
    expect(await provider.getSessions()).toEqual([]);
    expect(events.mock.calls.at(-1)?.[0].removed).toHaveLength(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(output.join("\n")).not.toContain(token);
  });

  it("hỏi phạm vi đăng xuất; huỷ giữ phiên; chỉ editor không gọi CLI logout", async () => {
    const { provider, run } = setup();
    const session = await provider.createSession();
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined);
    await provider.removeSession(session.id);
    expect(await provider.getSessions()).toHaveLength(1);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce("Chỉ VS Code" as never);
    run.mockClear();
    await provider.removeSession(session.id);
    expect(await provider.getSessions()).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("Remote gọi asExternalUri và gửi cổng đã chuyển tiếp", async () => {
    Object.assign(vscode.env, { remoteName: "ssh-remote" });
    let targetPort = 0;
    const proxy = createProxy((socket) => {
      const target = createConnection(targetPort, "127.0.0.1");
      socket.pipe(target).pipe(socket);
      socket.on("error", () => target.destroy());
      target.on("error", () => socket.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Không mở được cổng chuyển tiếp giả");
    vi.mocked(vscode.env.asExternalUri).mockImplementation(async (uri) => {
      targetPort = Number(new URL(uri.toString()).port);
      return vscode.Uri.parse(`http://127.0.0.1:${address.port}/callback`);
    });
    try {
      await setup().provider.createSession();
      expect(vscode.env.asExternalUri).toHaveBeenCalledTimes(1);
      expect(browserUrl?.searchParams.get("port")).toBe(String(address.port));
      expect(address.port).not.toBe(targetPort);
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it("lần đầu nhập URL hub không bị sự kiện cấu hình huỷ đăng nhập", async () => {
    const secret = secrets();
    const provider = new HiveAuthenticationProvider(
      new TokenStore(secret, vi.fn().mockRejectedValue(new Error("ENOENT")), () => "missing"),
      async () => undefined,
    );
    providers.push(provider);
    vi.mocked(setHubUrl).mockImplementationOnce(async () => {
      await provider.reload();
      return hub;
    });
    expect((await provider.createSession()).accessToken).toBe(token);
  });

  it("401 đồng thời chỉ nhắc đăng nhập một lần", async () => {
    const { provider } = setup();
    await provider.createSession();
    unauthorized = true;
    const results = await Promise.allSettled([
      provider.request(hub, "/v1/me", token),
      provider.request(hub, "/v1/me", token),
    ]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(await provider.getSessions()).toEqual([]);
  });

  it("Remote không có cổng loopback hợp lệ thì báo lỗi và đóng callback", async () => {
    Object.assign(vscode.env, { remoteName: "wsl" });
    vi.mocked(vscode.env.asExternalUri).mockImplementation(async () =>
      vscode.Uri.parse("https://forward.example/callback"),
    );
    await expect(setup().provider.createSession()).rejects.toThrow("chuyển tiếp");
    expect(vscode.env.openExternal).not.toHaveBeenCalled();
  });

  it("hai yêu cầu đăng nhập đồng thời chỉ mở một trình duyệt", async () => {
    const { provider } = setup();
    const [a, b] = await Promise.all([provider.createSession(), provider.createSession()]);
    expect(a).toBe(b);
    expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
  });
});
