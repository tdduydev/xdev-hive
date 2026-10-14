import { ARTIFACT_LIMITS, DEFAULT_ORG_ARTIFACT_POLICY, orgArtifactPolicy } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { clampPolicy, operatorCeilings } from "./limits.ts";

describe("trần người vận hành (D13)", () => {
  it("không đặt hay đặt sai thì dùng mặc định C10", () => {
    expect(operatorCeilings({})).toEqual({
      maxVersionBytes: ARTIFACT_LIMITS.defaultVersionBytes,
      maxBlobBytes: ARTIFACT_LIMITS.defaultBlobBytes,
      orgQuotaBytes: ARTIFACT_LIMITS.defaultOrgQuotaBytes,
      linkMaxDays: ARTIFACT_LIMITS.publicLinkMaxDays,
    });
    expect(operatorCeilings({ HIVE_ARTIFACT_MAX_VERSION_BYTES: "abc" }).maxVersionBytes).toBe(
      ARTIFACT_LIMITS.defaultVersionBytes,
    );
    expect(operatorCeilings({ HIVE_ARTIFACT_MAX_VERSION_BYTES: "-5" }).maxVersionBytes).toBe(
      ARTIFACT_LIMITS.defaultVersionBytes,
    );
  });

  it("giá trị vượt trần cứng bị hạ về trần cứng", () => {
    const c = operatorCeilings({
      HIVE_ARTIFACT_MAX_VERSION_BYTES: String(1024 ** 4),
      HIVE_ARTIFACT_LINK_MAX_DAYS: "90",
    });
    expect(c.maxVersionBytes).toBe(ARTIFACT_LIMITS.versionBytesCeiling);
    expect(c.linkMaxDays).toBe(ARTIFACT_LIMITS.publicLinkMaxDays);
  });

  it("chính sách tổ chức chỉ hạ được dưới trần, không nâng được", () => {
    const ceilings = operatorCeilings({ HIVE_ARTIFACT_MAX_VERSION_BYTES: "4096", HIVE_ARTIFACT_LINK_MAX_DAYS: "7" });
    const high = orgArtifactPolicy.parse({ maxVersionBytes: 8 * 1024 * 1024, publicLinks: { maxDays: 30 } });
    expect(clampPolicy(high, ceilings)).toMatchObject({ maxVersionBytes: 4096, publicLinks: { maxDays: 7 } });
    const low = orgArtifactPolicy.parse({ maxVersionBytes: 2048 });
    expect(clampPolicy(low, ceilings).maxVersionBytes).toBe(2048);
    expect(clampPolicy(DEFAULT_ORG_ARTIFACT_POLICY, operatorCeilings({}))).toEqual(DEFAULT_ORG_ARTIFACT_POLICY);
  });
});
