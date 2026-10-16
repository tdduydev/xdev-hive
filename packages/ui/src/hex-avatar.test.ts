import { describe, expect, it } from "vitest";
import { agentHex, hexInitials, machineHex } from "./hex-avatar.tsx";

describe("hexInitials", () => {
  it.each([
    ["sdlc-box-01", "SB"],
    ["mac-mini-lan", "ML"],
    ["dev-ha", "DH"],
    ["win-build-02", "WB"],
    ["runner", "R"],
    ["01-box", "B"],
    ["", "?"],
  ])("%s → %s", (name, mark) => {
    expect(hexInitials(name)).toBe(mark);
  });
});

describe("machineHex", () => {
  const base = { name: "sdlc-box-01", shared: true };
  it("màu theo trạng thái và loại máy", () => {
    expect(machineHex({ ...base, status: "online" }).tone).toBe("navy");
    expect(machineHex({ ...base, shared: false, status: "online" }).tone).toBe("success");
    expect(machineHex({ ...base, status: "paused" }).tone).toBe("warning");
    expect(machineHex({ ...base, status: "offline" }).tone).toBe("muted");
    expect(machineHex({ ...base, status: "revoked" }).tone).toBe("muted");
  });
});

describe("agentHex", () => {
  it("CLI đã biết có chữ cố định, CLI lạ lấy chữ đầu", () => {
    expect(agentHex("claude")).toEqual({ mark: "CC", tone: "navy" });
    expect(agentHex("codex").mark).toBe("CX");
    expect(agentHex("aider")).toEqual({ mark: "A", tone: "muted" });
  });
});
