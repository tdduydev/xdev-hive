import type { MachineStatus } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import {
  hasSharedMachine,
  type OnboardingInput,
  onboardingPending,
  onboardingSteps,
  shareCandidate,
} from "@/lib/onboarding.ts";

const all = { scm: true, project: true, machine: true, shared: true, task: true };
const machine = (
  fields: Partial<{ kind: "worker" | "host"; shared: boolean; status: MachineStatus; capacity: number }>,
) => ({
  kind: "worker" as const,
  shared: false,
  status: "online" as MachineStatus,
  capacity: 1,
  ...fields,
});
/** Hub mới cài: một đội, một máy cá nhân, chưa có dự án, chưa kết nối Git. */
const fresh: OnboardingInput = {
  can: all,
  connections: 0,
  ownSystems: 0,
  projects: 0,
  machines: [machine({})],
  tasks: 0,
};

describe("onboardingSteps", () => {
  it("hub mới cài: chỉ bước đăng ký máy đã xong; bước sau chờ bước trước", () => {
    expect(onboardingSteps(fresh)).toEqual([
      { id: "scm", done: false, waitingFor: null },
      { id: "project", done: false, waitingFor: "scm" },
      { id: "machine", done: true, waitingFor: null },
      { id: "shared", done: false, waitingFor: null },
      { id: "task", done: false, waitingFor: "project" },
    ]);
    expect(onboardingPending(onboardingSteps(fresh))).toBe(true);
  });

  it("làm xong hết thì không còn bước chờ, thẻ ẩn", () => {
    const steps = onboardingSteps({
      ...fresh,
      connections: 1,
      ownSystems: 1,
      projects: 1,
      machines: [machine({ shared: true })],
      tasks: 3,
    });
    expect(steps.every((s) => s.done && s.waitingFor === null)).toBe(true);
    expect(onboardingPending(steps)).toBe(false);
  });

  it("chỉ trả bước người đang xem làm được", () => {
    const steps = onboardingSteps({
      ...fresh,
      can: { scm: false, project: false, machine: false, shared: false, task: true },
    });
    expect(steps.map((s) => s.id)).toEqual(["task"]);
    // Bước chờ có thể là bước người khác làm (quản trị tạo dự án), vẫn báo để người xem biết vì sao chưa làm được.
    expect(steps[0]?.waitingFor).toBe("project");
  });

  it("không làm được bước nào thì thẻ ẩn", () => {
    const none = { scm: false, project: false, machine: false, shared: false, task: false };
    expect(onboardingPending(onboardingSteps({ ...fresh, can: none }))).toBe(false);
  });

  it("máy đã thu hồi không tính là đã đăng ký hay dùng chung", () => {
    const steps = onboardingSteps({ ...fresh, machines: [machine({ status: "revoked", shared: true })] });
    expect(steps.find((s) => s.id === "machine")?.done).toBe(false);
    expect(steps.find((s) => s.id === "shared")).toEqual({ id: "shared", done: false, waitingFor: "machine" });
  });

  it("dự án đã có thì bước dự án xong dù kết nối Git đã bị xoá", () => {
    const steps = onboardingSteps({ ...fresh, projects: 1 });
    expect(steps.find((s) => s.id === "project")).toEqual({ id: "project", done: true, waitingFor: null });
    expect(steps.find((s) => s.id === "task")?.waitingFor).toBeNull();
  });
});

describe("hasSharedMachine", () => {
  it("runner host luôn là máy dùng chung", () => expect(hasSharedMachine([machine({ kind: "host" })])).toBe(true));
  it("máy cá nhân không đủ", () => expect(hasSharedMachine([machine({}), machine({ status: "offline" })])).toBe(false));
  it("máy dùng chung tạm dừng vẫn tính", () =>
    expect(hasSharedMachine([machine({ shared: true, status: "paused" })])).toBe(true));
});

describe("shareCandidate", () => {
  it("ưu tiên máy trực tuyến, rồi máy nhiều chỗ chạy", () => {
    const off = { ...machine({ status: "offline", capacity: 8 }), name: "off" };
    const small = { ...machine({ capacity: 1 }), name: "small" };
    const big = { ...machine({ capacity: 4 }), name: "big" };
    expect(shareCandidate([off, small, big])?.name).toBe("big");
    expect(shareCandidate([off])?.name).toBe("off");
  });
  it("bỏ qua runner host, máy đã dùng chung và máy đã thu hồi", () => {
    expect(
      shareCandidate([machine({ kind: "host" }), machine({ shared: true }), machine({ status: "revoked" })]),
    ).toBeNull();
  });
});
