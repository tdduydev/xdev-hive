import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "@/lib/i18n.ts";
import { WorkScreen } from "@/screens/work-screen.tsx";

const at = "2026-10-13T00:00:00.000Z";
const team = "0a0a0a0a-0000-4000-8000-000000000002";
const project = "0a0a0a0a-0000-4000-8000-000000000003";
const taskId = "0a0a0a0a-0000-4000-8000-000000000004";
const runId = "0a0a0a0a-0000-4000-8000-000000000005";

const task = {
  id: taskId,
  projectId: project,
  teamId: team,
  key: "HIVE-7",
  number: 7,
  title: "Hoàn tiền một phần",
  body: "",
  type: null,
  status: "todo",
  preferredCli: null,
  source: {},
  createdBy: "u1",
  createdAt: at,
  updatedAt: at,
};

const run = (state: string) => ({
  id: runId,
  taskId,
  projectId: project,
  teamId: team,
  kind: "code",
  parentRunId: null,
  state,
  attempt: 1,
  maxAttempts: 3,
  machineId: null,
  machineName: null,
  cli: null,
  model: null,
  pinnedMachineId: null,
  branch: "ai/HIVE-7",
  policySnapshot: [],
  result: null,
  headSha: null,
  prUrl: null,
  timeoutSec: 3600,
  cost: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: null, turns: null },
  createdBy: "u1",
  createdAt: at,
  startedAt: null,
  finishedAt: null,
  updatedAt: at,
});

const waiting = {
  id: 9,
  attempt: 1,
  seq: null,
  type: "waiting_machine",
  data: { message: "Chờ máy của người giao việc hoặc máy dùng chung của đội online." },
  createdAt: at,
};

const b64 = (s: string) => Buffer.from(s).toString("base64");

interface Call {
  path: string;
  query: string;
  body: unknown;
}

/** Hub giả sau lệnh hub_rpc: trả theo thủ tục RPC, ghi lại thủ tục, query và thân request. */
function fakeHub(replies: Record<string, unknown>) {
  const calls: Call[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        if (command !== "hub_rpc") throw new Error(`lệnh chưa giả: ${command}`);
        const [path = "", query = ""] = String(args?.path)
          .replace(/^\/rpc\//, "")
          .split("?");
        calls.push({ path, query: decodeURIComponent(query), body: args?.body ? JSON.parse(String(args.body)) : null });
        const body = replies[path];
        return {
          status: body === undefined ? 404 : 200,
          contentType: "application/json",
          body: JSON.stringify(
            body === undefined
              ? { json: { defined: false, code: "NOT_FOUND", status: 404, message: "x" } }
              : { json: body },
          ),
        } as T;
      },
    },
  };
  return calls;
}

describe("WorkScreen", () => {
  beforeEach(() => {
    setLang("vi");
    location.hash = "#/work";
  });

  it("chỉ hỏi task và run của tôi, giao task cho agent rồi mở lượt chạy vừa tạo", async () => {
    const calls = fakeHub({
      "tasks/list": [task],
      "runs/search": { items: [], nextCursor: null, machines: [] },
      "runs/start": run("queued"),
      "runs/get": run("queued"),
      "runs/events": [],
      "runs/logs": [],
    });
    render(<WorkScreen />);
    const startButton = await screen.findByRole("button", { name: "Giao HIVE-7 cho agent" });
    expect(await screen.findByText("Bạn chưa giao run nào.")).toBeTruthy();
    // Lọc `mine` đi trong query của GET: thiếu thì hub trả cả bảng việc của đội.
    expect(calls.find((c) => c.path === "tasks/list")?.query).toContain('"mine":true');
    expect(calls.find((c) => c.path === "runs/search")?.query).toContain('"mine":true');

    await userEvent.setup().click(startButton);
    expect(calls.find((c) => c.path === "runs/start")?.body).toEqual({ json: { taskId } });
    await waitFor(() => expect(location.hash).toBe(`#/work/${runId}`));
  });

  it("lượt chạy đang chờ máy hiện lý do và log trực tiếp", async () => {
    location.hash = `#/work/${runId}`;
    const calls = fakeHub({
      "runs/get": run("queued"),
      "runs/events": [waiting],
      "runs/logs": [{ id: 1, attempt: 1, offset: 0, bytes: b64("đang chờ\n"), createdAt: at }],
    });
    render(<WorkScreen />);
    expect(await screen.findByText(/Chờ máy của người giao việc/)).toBeTruthy();
    expect(screen.getByText("Đang chờ máy.")).toBeTruthy();
    expect(screen.getByText(/đang chờ/, { selector: "pre" })).toBeTruthy();
    expect(calls.map((c) => c.path)).toEqual(expect.arrayContaining(["runs/get", "runs/events", "runs/logs"]));
  });

  it("lượt chạy đã nhận máy thì không còn báo chờ, bấm danh sách thì quay lại", async () => {
    location.hash = `#/work/${runId}`;
    fakeHub({ "runs/get": run("succeeded"), "runs/events": [waiting], "runs/logs": [] });
    render(<WorkScreen />);
    expect(await screen.findByText("Chưa có log.")).toBeTruthy();
    expect(screen.queryByText("Đang chờ máy.")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Việc của tôi" }));
    expect(location.hash).toBe("#/work");
  });

  it("task đang chạy thì không có nút giao thêm", async () => {
    fakeHub({
      "tasks/list": [{ ...task, status: "running" }],
      "runs/search": {
        items: [{ ...run("running"), taskKey: "HIVE-7", taskTitle: task.title }],
        nextCursor: null,
        machines: [],
      },
    });
    render(<WorkScreen />);
    expect(await screen.findByRole("button", { name: "Xem lượt chạy HIVE-7" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Giao HIVE-7 cho agent" })).toBeNull();
  });
});
