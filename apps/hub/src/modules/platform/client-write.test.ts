import type pg from "pg";
import { describe, expect, it } from "vitest";
import { runClientWrite } from "./client-write.ts";
import { BadRequestError } from "./errors.ts";

describe("runClientWrite không cần database", () => {
  it("khoá sai dạng bị từ chối trước khi ghi", async () => {
    let runs = 0;
    // Pool không được dùng tới: lỗi phải ném trước khi mở transaction.
    const pool = {} as pg.Pool;
    const error = await runClientWrite(
      pool,
      { userId: "u", orgId: "o" },
      { headers: new Headers({ "Idempotency-Key": "short" }) },
      "memory.write",
      async () => ++runs,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestError);
    expect(error).toMatchObject({ code: "IDEMPOTENCY_KEY_INVALID" });
    expect(runs).toBe(0);
  });
});
