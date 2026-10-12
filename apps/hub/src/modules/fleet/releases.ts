import { type MachineKind, validVersion, type WorkerRelease, workerRelease } from "@xdev-hive/contracts";

/** Nơi tải script cài và bản dựng sẵn của worker (worker/.goreleaser.yaml). */
export const WORKER_DOWNLOADS = "https://github.com/tdduydev/xdev-hive/releases/latest/download";

/**
 * Lệnh cài một dòng hiện trong hộp thoại thêm máy. Script tải bản đúng nền tảng, kiểm chữ ký và sha256, đăng ký máy rồi
 * cài dịch vụ; runner host thì không cài dịch vụ vì chạy bằng `hive-worker host`.
 */
export function installCommands(hubUrl: string, token: string, kind: MachineKind) {
  return {
    installCommand: `curl -fsSL ${WORKER_DOWNLOADS}/install.sh | sh -s -- --hub ${hubUrl} --token ${token}${kind === "host" ? " --no-service" : ""}`,
    installCommandWindows: `& ([scriptblock]::Create((irm ${WORKER_DOWNLOADS}/install.ps1))) -Hub ${hubUrl} -Token ${token}`,
  };
}

/**
 * Bản worker mới nhất, hỏi API release của GitHub tối đa mỗi giờ một lần (API không xác thực giới hạn 60 lượt mỗi giờ
 * cho một IP). Không có nguồn (HIVE_WORKER_RELEASES=off, mạng nội bộ không ra được GitHub) thì luôn trả null.
 */
export class WorkerReleaseCache {
  private value: WorkerRelease | null = null;
  private expiresAt = Number.NEGATIVE_INFINITY;
  private pending: Promise<WorkerRelease | null> | null = null;
  private readonly source: string | undefined;
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;

  constructor(source: string | undefined, now: () => number = Date.now, fetcher: typeof fetch = fetch) {
    this.source = source;
    this.now = now;
    this.fetcher = fetcher;
  }

  async get(): Promise<WorkerRelease | null> {
    if (!this.source) return null;
    if (this.now() < this.expiresAt) return this.value;
    // Nhiều request cùng lúc khi cache hết hạn chỉ tạo một lượt hỏi GitHub.
    this.pending ??= this.load(this.source).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async load(source: string): Promise<WorkerRelease | null> {
    try {
      const res = await this.fetcher(source, {
        headers: { accept: "application/vnd.github+json", "user-agent": "xdev-hive-hub" },
        signal: AbortSignal.timeout(10_000),
      });
      // Repo chưa có bản phát hành nào.
      if (res.status === 404) {
        this.value = null;
        this.expiresAt = this.now() + 3_600_000;
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown; published_at?: unknown };
      const version = typeof body.tag_name === "string" ? body.tag_name.replace(/^v/, "") : "";
      const parsed = workerRelease.safeParse({
        version,
        url: body.html_url,
        publishedAt: typeof body.published_at === "string" ? new Date(body.published_at).toISOString() : null,
      });
      if (!validVersion(version) || !parsed.success) throw new Error("phản hồi không có tag semver hoặc URL");
      this.value = parsed.data;
      this.expiresAt = this.now() + 3_600_000;
    } catch (error) {
      // Giữ kết quả cũ nếu có; thử lại sau 5 phút để lỗi tạm của GitHub không bị hỏi dồn.
      console.warn("Không tra được bản worker mới nhất:", error);
      this.expiresAt = this.now() + 300_000;
    }
    return this.value;
  }
}
