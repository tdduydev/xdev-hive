import { describe, expect, it } from "vitest";
import { DbEpochCache, type DbEpochInfo } from "./db-epoch.ts";

const A: DbEpochInfo = { dbEpoch: "0b3c6f1e-6a43-4c55-9d4c-2f1d8f9a0c11", dbRestoredTo: null };
const B: DbEpochInfo = { dbEpoch: "7e0f3f5d-1d0a-4b7e-8a1f-5c2b9e4d6a22", dbRestoredTo: "2026-10-11T03:00:00.000Z" };

describe("DbEpochCache", () => {
  it("hub không có database thì health không có mốc", async () => {
    expect(await new DbEpochCache().current()).toEqual({});
  });

  it("giữ bản đọc trong một phút rồi đọc lại", async () => {
    let t = 0;
    let value = A;
    let reads = 0;
    const cache = new DbEpochCache(60_000, () => t);
    cache.provide(async () => {
      reads++;
      return value;
    });
    expect(await cache.current()).toEqual(A);
    value = B;
    t = 59_999;
    expect(await cache.current()).toEqual(A);
    t = 60_000;
    expect(await cache.current()).toEqual(B);
    expect(reads).toBe(2);
  });

  it("lỗi database không làm hỏng health và không bị giữ lại", async () => {
    let fail = true;
    const cache = new DbEpochCache(60_000, () => 0);
    cache.provide(async () => {
      if (fail) throw new Error("mất kết nối");
      return A;
    });
    expect(await cache.current()).toEqual({});
    fail = false;
    expect(await cache.current()).toEqual(A);
  });
});
