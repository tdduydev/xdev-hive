/** Phần của Web Storage mà kho cần; localStorage trong trình duyệt, Map giả trong test. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const ORG_STORAGE_KEY = "hive.org";

export interface OrgStore {
  get(): string | null;
  set(id: string): void;
  subscribe(listener: () => void): () => void;
}

/**
 * Tổ chức đang làm việc, nhớ qua lần tải sau. Giữ bản trong bộ nhớ vì localStorage có thể bị chặn (chế độ riêng tư,
 * chính sách công ty): khi đó vẫn đổi được tổ chức, chỉ không nhớ được. Không nghe sự kiện `storage` từ tab khác:
 * tab đang mở tự đổi tổ chức theo tab khác thì người dùng dễ thao tác nhầm tổ chức.
 */
export function createOrgStore(storage: KeyValueStorage | null): OrgStore {
  let current: string | null = null;
  try {
    current = storage?.getItem(ORG_STORAGE_KEY) ?? null;
  } catch {
    current = null;
  }
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(id) {
      if (id === current) return;
      current = id;
      try {
        storage?.setItem(ORG_STORAGE_KEY, id);
      } catch {
        /* Không nhớ được qua lần tải sau; tổ chức vẫn đổi trong phiên này. */
      }
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Tổ chức đã chọn nếu người dùng còn ở trong đó; không thì tổ chức đầu tiên (đã xếp theo tên). */
export function pickOrg<T extends { id: string }>(orgs: readonly T[], storedId: string | null): T | null {
  return orgs.find((o) => o.id === storedId) ?? orgs[0] ?? null;
}

function browserStorage(): KeyValueStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export const orgStore = createOrgStore(browserStorage());
