import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "@/chat/participant/index.ts";
import { commands, createContext, settings, workspace } from "../../../test/vscode-mock.ts";

const chatApi = vi.hoisted(() => ({ createChatParticipant: vi.fn() }));
vi.mock("vscode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vscode")>();
  return {
    ...actual,
    chat: chatApi,
    LanguageModelChatMessage: { User: (content: string) => ({ role: "user", content }) },
  };
});

const temporary: string[] = [];

afterEach(async () => {
  chatApi.createChatParticipant.mockClear();
  commands.registerCommand.mockClear();
  settings.clear();
  workspace.workspaceFolders = undefined;
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

async function workspaceWithProject() {
  const folder = await mkdtemp(join(tmpdir(), "hive-chat-"));
  temporary.push(folder);
  await writeFile(
    join(folder, ".mcp.json"),
    JSON.stringify({ mcpServers: { hive: { headers: { "x-hive-project": "00000000-0000-0000-0000-000000000001" } } } }),
  );
  workspace.workspaceFolders = [{ uri: { fsPath: folder } }];
}

describe("chat participant @hive", () => {
  it("does not register when the editor has no Chat API", () => {
    const create = chatApi.createChatParticipant;
    (chatApi as unknown as { createChatParticipant?: unknown }).createChatParticipant = undefined;
    register(createContext() as never);
    expect(create).not.toHaveBeenCalled();
    (chatApi as unknown as { createChatParticipant: typeof create }).createChatParticipant = create;
  });

  it("prepares /giao with the selected model and does not create a task before the action button", async () => {
    await workspaceWithProject();
    settings.set("xdevHive.hubUrl", "https://hub.example.test");
    let handler: ((request: unknown, context: unknown, response: unknown, token: unknown) => Promise<void>) | undefined;
    chatApi.createChatParticipant.mockImplementation((_id, candidate) => {
      handler = candidate as typeof handler;
      return { handler: candidate, dispose: vi.fn() };
    });
    register(createContext() as never);
    const input = `title api_key="SECRET_SAMPLE_123456789"`;
    const model = {
      sendRequest: vi.fn(async () => ({
        text: (async function* () {
          yield JSON.stringify({ title: "Sửa lỗi", description: input, acceptance: [], files: [] });
        })(),
      })),
    };
    const response = {
      markdown: vi.fn(),
      button: vi.fn(),
      filetree: vi.fn(),
      anchor: vi.fn(),
      progress: vi.fn(),
      reference: vi.fn(),
      push: vi.fn(),
    };
    await handler?.({ command: "giao", prompt: "Sửa lỗi", model }, {}, response, { isCancellationRequested: false });
    expect(model.sendRequest).toHaveBeenCalledOnce();
    expect(JSON.stringify(model.sendRequest.mock.calls)).not.toContain("SECRET_SAMPLE_123456789");
    expect(response.button).toHaveBeenCalledWith(expect.objectContaining({ command: "xdevHive.chat.createTask" }));
    expect(response.markdown).toHaveBeenCalledWith(expect.stringContaining("đã ẩn dòng có thể chứa bí mật"));
  });

  it("sends /review diff to the model only after secret scanning", async () => {
    const folder = await mkdtemp(join(tmpdir(), "hive-review-"));
    temporary.push(folder);
    execFileSync("git", ["init", "-q"], { cwd: folder });
    execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: folder });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: folder });
    await writeFile(join(folder, "sample.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "sample.ts"], { cwd: folder });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: folder });
    await writeFile(join(folder, "sample.ts"), 'export const value = 1;\nconst API_KEY="SECRET_SAMPLE_123456789";\n');
    workspace.workspaceFolders = [{ uri: { fsPath: folder } }];
    let handler: ((request: unknown, context: unknown, response: unknown, token: unknown) => Promise<void>) | undefined;
    chatApi.createChatParticipant.mockImplementation((_id, candidate) => {
      handler = candidate as typeof handler;
      return { handler: candidate, dispose: vi.fn() };
    });
    register(createContext() as never);
    const model = {
      sendRequest: vi.fn(async () => ({
        text: (async function* () {
          yield "Review kết quả";
        })(),
      })),
    };
    const response = { markdown: vi.fn(), button: vi.fn() };
    await handler?.({ command: "review", prompt: "", model }, {}, response, { isCancellationRequested: false });
    expect(model.sendRequest).toHaveBeenCalledOnce();
    expect(JSON.stringify(model.sendRequest.mock.calls)).not.toContain("SECRET_SAMPLE_123456789");
    expect(JSON.stringify(model.sendRequest.mock.calls)).toContain("đã ẩn dòng có thể chứa bí mật");
  });
});
