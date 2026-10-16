import { describe, expect, it } from "vitest";
import { type GitProvider, GitProviderError } from "../scm/index.ts";
import { readRepoFiles } from "./scan.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const files: Record<string, string | Uint8Array> = { "docs/a.md": "# A\n", "docs/logo.png": PNG };

// Có GitLab tự host trả 406 cho repository/archive trong khi đọc file theo đường dẫn vẫn được.
function providerWithArchiveError(error: GitProviderError): GitProvider {
  return {
    archive: async () => {
      throw error;
    },
    readFile: async (_ref: unknown, path: string) => {
      const file = files[path];
      return typeof file === "string" ? file : null;
    },
    readFileBytes: async (_ref: unknown, path: string) => {
      const file = files[path];
      if (file === undefined) return null;
      return typeof file === "string" ? new TextEncoder().encode(file) : file;
    },
  } as unknown as GitProvider;
}

async function readAll(provider: GitProvider, wanted: string[]) {
  const out: Array<[string, number[]]> = [];
  for await (const e of readRepoFiles(provider, { owner: "o", name: "r" }, "s", new Set(wanted), {
    archive: true,
    maxBytes: 1024 ** 2,
    keep: () => true,
  }))
    out.push([e.path, [...(e.bytes ?? [])]]);
  return out;
}

describe("readRepoFiles khi nhà cung cấp không cho tải archive", () => {
  it("đọc từng file theo đường dẫn, giữ nguyên byte của file nhị phân", async () => {
    const provider = providerWithArchiveError(
      new GitProviderError("invalid", "GitLab: yêu cầu không hợp lệ (406 Not Acceptable)", { status: 406 }),
    );
    expect(await readAll(provider, ["docs/a.md", "docs/logo.png", "docs/missing.md"])).toEqual([
      ["docs/a.md", [...new TextEncoder().encode("# A\n")]],
      ["docs/logo.png", [...PNG]],
    ]);
  });

  it("lỗi quyền hay token thì vẫn ném ra để báo người cấu hình", async () => {
    const provider = providerWithArchiveError(
      new GitProviderError("unauthorized", "GitLab: token không hợp lệ hoặc đã hết hạn", { status: 401 }),
    );
    await expect(readAll(provider, ["docs/a.md"])).rejects.toMatchObject({ code: "unauthorized" });
  });
});
