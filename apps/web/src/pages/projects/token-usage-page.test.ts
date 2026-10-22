import { ORPCError } from "@orpc/client";
import type { ProjectTokenUsageRow } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { isOutsideProject, totalsOf } from "@/pages/projects/token-usage-page.tsx";

const row = (tokens: number, sessions: number): ProjectTokenUsageRow => ({
  userId: "u1",
  userName: "Lan",
  machineId: `m-${tokens}`,
  machineName: "máy",
  periodEnd: "2026-10-20T03:00:00.000Z",
  tokens,
  sessions,
  score: null,
  policyDrift: [],
});

describe("totalsOf", () => {
  it("sums tokens and sessions and counts machines", () => {
    expect(totalsOf([row(1000, 3), row(250, 1)])).toEqual({ tokens: 1250, sessions: 4, machines: 2 });
  });

  it("is zero for no rows", () => {
    expect(totalsOf([])).toEqual({ tokens: 0, sessions: 0, machines: 0 });
  });
});

describe("isOutsideProject", () => {
  it("treats FORBIDDEN and NOT_FOUND as outside the project", () => {
    expect(isOutsideProject(new ORPCError("FORBIDDEN"))).toBe(true);
    expect(isOutsideProject(new ORPCError("NOT_FOUND"))).toBe(true);
  });

  it("keeps other failures as load errors", () => {
    expect(isOutsideProject(new ORPCError("INTERNAL_SERVER_ERROR"))).toBe(false);
    expect(isOutsideProject(new Error("network"))).toBe(false);
  });
});
