import { inferRPCMethodFromContractRouter, isContractProcedure } from "@orpc/contract";
import { contract } from "@xdev-hive/contracts";
import { RUN_STATES, RUN_STATUS_GROUPS, TERMINAL_RUN_STATES } from "@xdev-hive/contracts/run-states";
import { describe, expect, it } from "vitest";
import { contractMethods, methodOf } from "@/lib/rpc-methods.ts";
import { validateRunsSearch } from "@/lib/run-list.ts";

const procedures = (node: unknown, path: string[] = []): string[][] =>
  isContractProcedure(node)
    ? [path]
    : node && typeof node === "object"
      ? Object.entries(node).flatMap(([key, child]) => procedures(child, [...path, key]))
      : [];

describe("contractMethods", () => {
  const methods = contractMethods(contract);

  it("cho mọi thủ tục cùng method với inferRPCMethodFromContractRouter(contract)", () => {
    const infer = inferRPCMethodFromContractRouter(contract);
    const paths = procedures(contract);
    expect(paths.length).toBeGreaterThan(100);
    for (const path of paths)
      expect([path.join("."), methodOf(methods, path)]).toEqual([path.join("."), infer({}, path)]);
  });

  it("thủ tục chỉ đọc đi bằng GET, thủ tục ghi đi bằng POST", () => {
    expect(methodOf(methods, ["me", "get"])).toBe("GET");
    expect(methodOf(methods, ["runs", "latest"])).toBe("GET");
    expect(methodOf(methods, ["runs", "start"])).toBe("POST");
    expect(Object.values(methods)).not.toContain("POST");
  });
});

describe("run-states không zod", () => {
  it("khớp schema zod của hợp đồng", async () => {
    const { runState, runStatusGroup } = await import("@xdev-hive/contracts");
    expect(runState.options).toEqual([...RUN_STATES]);
    expect(runStatusGroup.options).toEqual(Object.keys(RUN_STATUS_GROUPS));
    expect(TERMINAL_RUN_STATES.every((s) => RUN_STATES.includes(s))).toBe(true);
  });

  it("validateRunsSearch chỉ nhận nhóm trạng thái có thật", () => {
    expect(validateRunsSearch({ status: "waiting" })).toEqual({ status: "waiting" });
    expect(validateRunsSearch({ status: "lost" })).toEqual({});
    expect(validateRunsSearch({ status: 1 })).toEqual({});
  });
});
