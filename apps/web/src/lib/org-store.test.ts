import { describe, expect, it, vi } from "vitest";
import { createOrgStore, type KeyValueStorage, ORG_STORAGE_KEY, pickOrg } from "./org-store.ts";

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe("createOrgStore", () => {
  it("đọc lựa chọn đã nhớ", () => expect(createOrgStore(memoryStorage({ [ORG_STORAGE_KEY]: "b" })).get()).toBe("b"));

  it("chọn tổ chức: ghi vào storage và báo người nghe", () => {
    const storage = memoryStorage();
    const store = createOrgStore(storage);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set("a");
    expect(store.get()).toBe("a");
    expect(storage.data.get(ORG_STORAGE_KEY)).toBe("a");
    expect(listener).toHaveBeenCalledTimes(1);
    store.set("a");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.set("b");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("storage bị chặn: vẫn đổi được trong phiên", () => {
    const blocked: KeyValueStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const store = createOrgStore(blocked);
    expect(store.get()).toBeNull();
    store.set("a");
    expect(store.get()).toBe("a");
  });

  it("không có storage (ngoài trình duyệt)", () => {
    const store = createOrgStore(null);
    store.set("a");
    expect(store.get()).toBe("a");
  });
});

describe("pickOrg", () => {
  const orgs = [{ id: "a" }, { id: "b" }];
  it("giữ tổ chức đã chọn", () => expect(pickOrg(orgs, "b")).toEqual({ id: "b" }));
  it("đã rời tổ chức đã chọn thì về tổ chức đầu tiên", () => expect(pickOrg(orgs, "x")).toEqual({ id: "a" }));
  it("chưa chọn thì lấy tổ chức đầu tiên", () => expect(pickOrg(orgs, null)).toEqual({ id: "a" }));
  it("không thuộc tổ chức nào", () => expect(pickOrg([], "a")).toBeNull());
});
