import {
  ciRunStatus,
  ciSource,
  DELIVERY_ERRORS,
  deployMethod,
  deployOrigin,
  deployState,
  deployStepState,
} from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import {
  CI_SOURCE_LABEL,
  CI_STATUS_LABEL,
  CI_STATUS_TONE,
  DELIVERY_ERROR_LABEL,
  DEPLOY_METHOD_LABEL,
  DEPLOY_ORIGIN_LABEL,
  DEPLOY_STATE_LABEL,
  DEPLOY_STATE_TONE,
  DEPLOY_STEP_STATE_LABEL,
  DEPLOY_STEP_STATE_TONE,
  deliveryErrorLabel,
  deployStepLabel,
  isDeployActive,
} from "@/lib/delivery-text.ts";

const keys = (record: Record<string, unknown>) => Object.keys(record).sort();

describe("delivery labels", () => {
  it("cover every status, method and origin the contract can return", () => {
    expect(keys(DEPLOY_STATE_LABEL)).toEqual([...deployState.options].sort());
    expect(keys(DEPLOY_STATE_TONE)).toEqual([...deployState.options].sort());
    expect(keys(DEPLOY_STEP_STATE_LABEL)).toEqual([...deployStepState.options].sort());
    expect(keys(DEPLOY_STEP_STATE_TONE)).toEqual([...deployStepState.options].sort());
    expect(keys(DEPLOY_METHOD_LABEL)).toEqual([...deployMethod.options].sort());
    expect(keys(DEPLOY_ORIGIN_LABEL)).toEqual([...deployOrigin.options].sort());
    expect(keys(CI_SOURCE_LABEL)).toEqual([...ciSource.options].sort());
    expect(keys(CI_STATUS_LABEL)).toEqual([...ciRunStatus.options].sort());
    expect(keys(CI_STATUS_TONE)).toEqual([...ciRunStatus.options].sort());
  });

  it("has a short label for every business error code of the contract", () => {
    expect(keys(DELIVERY_ERROR_LABEL)).toEqual(expect.arrayContaining(Object.keys(DELIVERY_ERRORS).sort()));
    expect(deliveryErrorLabel("JENKINS_NO_TOKEN")).toBe("Chưa có token Jenkins");
    expect(deliveryErrorLabel("NOPE")).toBeUndefined();
    expect(deliveryErrorLabel(undefined)).toBeUndefined();
  });

  it("shows an unknown step key as is instead of breaking the screen", () => {
    expect(deployStepLabel("health")).toBe("Kiểm sức khoẻ");
    expect(deployStepLabel("brand-new-step")).toBe("brand-new-step");
  });

  it("treats only the states that still block the target as active", () => {
    const active = deployState.options.filter(isDeployActive);
    expect(active.sort()).toEqual(["pending_approval", "queued", "running"]);
  });
});
