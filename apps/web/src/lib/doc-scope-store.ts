import { browserStorage, type KeyValueStorage } from "@/lib/org-store.ts";
import type { DocScopeFilter } from "@/pages/knowledge/doc-scope.ts";

export const DOC_SCOPE_STORAGE_PREFIX = "hive.docScope.";

const isFilter = (value: unknown): value is DocScopeFilter => value === "mine" || value === "all";

/**
 * Bộ lọc phạm vi của trang Tài liệu theo từng tổ chức. Giữ bản trong bộ nhớ vì localStorage có thể bị chặn:
 * khi đó bộ lọc vẫn đổi được trong phiên, chỉ không nhớ qua lần tải sau.
 */
export function createDocScopeStore(storage: KeyValueStorage | null) {
  const memory = new Map<string, DocScopeFilter>();
  return {
    get(orgId: string): DocScopeFilter | null {
      const cached = memory.get(orgId);
      if (cached) return cached;
      try {
        const stored = storage?.getItem(`${DOC_SCOPE_STORAGE_PREFIX}${orgId}`);
        // Giá trị lạ (bản cũ, bị sửa tay) coi như chưa lưu để trang quay về mặc định.
        return isFilter(stored) ? stored : null;
      } catch {
        return null;
      }
    },
    set(orgId: string, filter: DocScopeFilter): void {
      memory.set(orgId, filter);
      try {
        storage?.setItem(`${DOC_SCOPE_STORAGE_PREFIX}${orgId}`, filter);
      } catch {
        /* Không nhớ được qua lần tải sau; bộ lọc vẫn đổi trong phiên này. */
      }
    },
  };
}

export const docScopeStore = createDocScopeStore(browserStorage());
