import type { DocResolvedLink } from "@xdev-hive/contracts";
import type { DocLinkTarget } from "@xdev-hive/doc-editor";
import { hubFetchImage } from "@/lib/hub-bytes.ts";

/** Hợp đồng giới hạn 1.000 link cho mỗi lần phân giải. */
const MAX_HREFS = 1000;

type Waiting = {
  docKey: string;
  href: string;
  done: (target: DocLinkTarget | null) => void;
  fail: (error: unknown) => void;
};

/**
 * Phân giải link và ảnh tương đối của tài liệu cho `DocEditorEnv.resolveLink`. Mọi ảnh trong cùng một lượt vẽ gom vào
 * một lời gọi `docAssets.resolve`; ảnh của hub được đọc qua Rust rồi trả dạng `data:`, vì thẻ img không mang được token.
 * Nội dung Markdown vẫn giữ đường dẫn repo, chỉ nơi hiển thị mới thấy địa chỉ đã phân giải.
 */
export function createAssetResolver(
  resolve: (input: { docKey: string; hrefs: string[] }) => Promise<DocResolvedLink[]>,
  fetchImage: (path: string) => Promise<string | null> = hubFetchImage,
) {
  const cache = new Map<string, Promise<DocLinkTarget | null>>();
  let waiting: Waiting[] = [];

  const toTarget = async (link: DocResolvedLink | undefined): Promise<DocLinkTarget | null> => {
    if (!link || link.kind === "missing") return null;
    if (link.kind === "doc") return { kind: "doc", key: link.key };
    if (link.kind === "external") return { kind: "external", url: link.url };
    // Đường dẫn tải file có `org` và `doc` trong query vì web dùng thẻ img; Rust vẫn gắn token và tổ chức của máy.
    const url = await fetchImage(link.url);
    return url ? { kind: "asset", url } : null;
  };

  const flush = () => {
    const batch = waiting;
    waiting = [];
    for (const [docKey, group] of Map.groupBy(batch, (item) => item.docKey)) {
      for (let start = 0; start < group.length; start += MAX_HREFS) {
        const part = group.slice(start, start + MAX_HREFS);
        resolve({ docKey, hrefs: part.map((item) => item.href) }).then(
          (links) => {
            for (const item of part) {
              toTarget(links.find((link) => link.href === item.href)).then(item.done, (error: unknown) => {
                // Lỗi tải một ảnh không được nhớ: lần vẽ sau thử lại.
                cache.delete(JSON.stringify([item.docKey, item.href]));
                item.fail(error);
              });
            }
          },
          (error: unknown) => {
            for (const item of part) {
              cache.delete(JSON.stringify([item.docKey, item.href]));
              item.fail(error);
            }
          },
        );
      }
    }
  };

  const resolveLink = (docKey: string, href: string): Promise<DocLinkTarget | null> => {
    const id = JSON.stringify([docKey, href]);
    const found = cache.get(id);
    if (found) return found;
    const result = new Promise<DocLinkTarget | null>((done, fail) => {
      waiting.push({ docKey, href, done, fail });
      if (waiting.length === 1) queueMicrotask(flush);
    });
    cache.set(id, result);
    return result;
  };

  return { resolveLink, clear: () => cache.clear() };
}
