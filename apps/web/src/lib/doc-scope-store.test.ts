import { describe, expect, it } from "vitest";
import { createDocScopeStore, DOC_SCOPE_STORAGE_PREFIX } from "@/lib/doc-scope-store.ts";
import type { KeyValueStorage } from "@/lib/org-store.ts";

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

describe("kho bộ lọc phạm vi tài liệu", () => {
  it("nhớ bộ lọc theo tổ chức", () => {
    const storage = memoryStorage();
    const store = createDocScopeStore(storage);
    store.set("o1", "all");
    expect(store.get("o1")).toBe("all");
    expect(store.get("o2")).toBeNull();
    expect(storage.data.get(`${DOC_SCOPE_STORAGE_PREFIX}o1`)).toBe("all");
    expect(createDocScopeStore(storage).get("o1")).toBe("all");
  });
  it("vẫn chạy khi localStorage ném lỗi", () => {
    const store = createDocScopeStore({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(store.get("o1")).toBeNull();
    expect(() => store.set("o1", "mine")).not.toThrow();
    expect(store.get("o1")).toBe("mine");
  });
  it("bỏ giá trị lạ trong storage", () => {
    const store = createDocScopeStore({ getItem: () => "xyz", setItem: () => undefined });
    expect(store.get("o1")).toBeNull();
  });
  it("chạy khi không có storage", () => {
    const store = createDocScopeStore(null);
    expect(store.get("o1")).toBeNull();
    store.set("o1", "all");
    expect(store.get("o1")).toBe("all");
  });
});
