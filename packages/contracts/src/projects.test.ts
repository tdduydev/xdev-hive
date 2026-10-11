import { describe, expect, it } from "vitest";
import { defaultProjectSettings, projectSettings } from "./projects.ts";

describe("quyền CLI trong dự án", () => {
  it("chấp nhận settings cũ và hai chế độ quyền", () => {
    const settings = defaultProjectSettings();
    expect(projectSettings.parse(settings).runPermissions).toBeUndefined();
    for (const mode of ["workspace", "full"] as const) {
      expect(projectSettings.parse({ ...settings, runPermissions: { mode } }).runPermissions).toEqual({ mode });
    }
    expect(projectSettings.safeParse({ ...settings, runPermissions: { mode: "unknown" } }).success).toBe(false);
  });
});
