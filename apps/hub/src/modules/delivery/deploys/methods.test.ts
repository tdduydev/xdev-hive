import { DEPLOY_METHODS } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import type { Tx } from "../../platform/index.ts";
import { DeployMethodNotImplementedError } from "./method.ts";
import { deployMethods, methodFor } from "./methods.ts";

describe("cách triển khai", () => {
  it("mỗi cách trong hợp đồng có đúng một cài đặt mang tên của nó", () => {
    expect(Object.keys(deployMethods).sort()).toEqual([...DEPLOY_METHODS].sort());
    for (const method of DEPLOY_METHODS) expect(methodFor(method).method).toBe(method);
  });

  it("cách chưa làm báo NOT_IMPLEMENTED ở mọi thao tác, không chạy dở", async () => {
    const ctx = { tx: {} as Tx, deps: {} };
    for (const method of DEPLOY_METHODS) {
      const impl = methodFor(method);
      const run = {
        orgId: "o",
        deployId: "d",
        targetId: "t",
        config: { method } as never,
        version: { ref: "main" } as never,
        requestedBy: null,
        remote: null,
        external: null,
        signal: new AbortController().signal,
      };
      for (const call of [
        () => impl.start(ctx, run),
        () => impl.poll(ctx, run),
        () => impl.cancel(ctx, run),
        () => impl.version(ctx, { targetId: "t", config: run.config }),
      ]) {
        const error = await call().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DeployMethodNotImplementedError);
        expect(error).toMatchObject({ code: "NOT_IMPLEMENTED", method });
      }
      expect(impl.rollback).toBeUndefined();
    }
  });
});
