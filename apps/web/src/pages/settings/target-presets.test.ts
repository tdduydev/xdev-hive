import { targetConfigInput, targetUpsertInput } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import {
  draftFromConfig,
  draftToConfig,
  emptyDraft,
  HIVE_COMPOSE_PRESET_ID,
  presetById,
  validateDraft,
} from "@/pages/settings/target-presets.ts";

const SERVER_ID = "5a5a5a5a-0000-4000-8000-0000000000aa";

describe("preset Hub xDev Hive (docker compose)", () => {
  const preset = presetById(HIVE_COMPOSE_PRESET_ID);

  it("không chọn sẵn máy chủ nên chưa lưu được", () => {
    const draft = preset?.draft();
    expect(draft?.serverId).toBe("");
    expect(validateDraft(draft ?? emptyDraft("ssh-script")).serverId).toBeTruthy();
  });

  it("hợp lệ với hợp đồng khi đã chọn máy chủ", () => {
    const draft = { ...(preset?.draft() ?? emptyDraft("ssh-script")), serverId: SERVER_ID };
    expect(validateDraft(draft)).toEqual({});
    const parsed = targetConfigInput.safeParse(draftToConfig(draft));
    expect(parsed.error?.issues).toBeUndefined();
    expect(parsed.success).toBe(true);
  });

  it("kiểm health theo commit8", () => {
    const draft = preset?.draft();
    expect(draft?.healthMatchEquals).toBe("{{commit8}}");
    expect(draft?.healthMatchPath).toBe("version");
  });
});

describe("bản nháp", () => {
  it("biến bí mật mới phải có giá trị, biến đã lưu thì bỏ trống được", () => {
    const draft = { ...emptyDraft("ssh-script"), serverId: SERVER_ID };
    draft.variables = [
      { name: "TOKEN", secret: true, value: "", stored: false },
      { name: "OLD", secret: true, value: "", stored: true },
    ];
    expect(Object.keys(validateDraft(draft))).toEqual(["variables.0.value"]);
  });

  it("không gửi giá trị khi biến bí mật để trống (giữ giá trị đã lưu)", () => {
    const draft = { ...emptyDraft("ssh-script"), serverId: SERVER_ID };
    draft.variables = [{ name: "OLD", secret: true, value: "", stored: true }];
    const config = draftToConfig(draft) as { variables: unknown[] };
    expect(config.variables).toEqual([{ name: "OLD", secret: true }]);
  });

  it("đi vòng cấu hình ssh-script không mất dữ liệu", () => {
    const preset = presetById(HIVE_COMPOSE_PRESET_ID);
    const draft = { ...(preset?.draft() ?? emptyDraft("ssh-script")), serverId: SERVER_ID };
    const parsed = targetConfigInput.parse(draftToConfig(draft));
    const back = draftFromConfig(parsed as never);
    expect(back).toEqual(draft);
  });

  it("jenkins: bật đẩy từ môi trường thì phải chọn nguồn", () => {
    const draft = { ...emptyDraft("jenkins-job"), connectionId: SERVER_ID, promoteOn: true };
    expect(Object.keys(validateDraft(draft))).toEqual(["promote.fromEnvironmentId", "promote.buildParam"]);
  });

  it("kubectl cần {{tag}} trong mẫu image", () => {
    const draft = {
      ...emptyDraft("kubectl"),
      connectionId: SERVER_ID,
      namespace: "app",
      workload: "web",
      container: "web",
      imageTemplate: "registry.example.com/web:latest",
    };
    const parsed = targetUpsertInput.safeParse({
      projectId: SERVER_ID,
      environmentId: SERVER_ID,
      config: draftToConfig(draft),
      expectedConfigVersion: null,
    });
    expect(parsed.success).toBe(false);
  });
});
