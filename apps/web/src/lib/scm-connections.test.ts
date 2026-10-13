import { describe, expect, it } from "vitest";
import {
  type ConnectionDraft,
  connectionAuthLabel,
  connectionHost,
  createTaskBlockedReason,
  issuesToConnectionErrors,
  parseConnectionDraft,
  provisionInFlight,
  showsProvision,
} from "@/lib/scm-connections.ts";

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----";

const draft = (over: Partial<ConnectionDraft> = {}): ConnectionDraft => ({
  kind: "github",
  authMode: "token",
  name: "GitHub Acme",
  baseUrl: "",
  defaultOwner: "acme",
  token: "ghp_testtoken",
  appId: "",
  installationId: "",
  privateKey: "",
  ...over,
});

describe("parseConnectionDraft", () => {
  it("GitHub token: bỏ baseUrl trống, gửi authMode token", () => {
    const r = parseConnectionDraft(draft());
    expect(r).toEqual({
      ok: true,
      input: { kind: "github", authMode: "token", name: "GitHub Acme", defaultOwner: "acme", token: "ghp_testtoken" },
    });
  });

  it("GitHub App: installation là số, bỏ dấu / cuối URL", () => {
    const r = parseConnectionDraft(
      draft({
        authMode: "app",
        token: "",
        appId: "123",
        installationId: "456",
        privateKey: PEM,
        baseUrl: "https://ghe.acme.vn/api/v3/",
      }),
    );
    expect(r.ok && r.input).toMatchObject({
      kind: "github",
      authMode: "app",
      appId: "123",
      installationId: 456,
      baseUrl: "https://ghe.acme.vn/api/v3",
    });
    expect(r.ok && "token" in r.input).toBe(false);
  });

  it("GitLab: baseUrl trống thì dùng gitlab.com, owner không bắt buộc", () => {
    const r = parseConnectionDraft(draft({ kind: "gitlab", defaultOwner: "", token: "glpat-testtoken" }));
    expect(r).toEqual({
      ok: true,
      input: { kind: "gitlab", name: "GitHub Acme", baseUrl: "https://gitlab.com", token: "glpat-testtoken" },
    });
  });

  it("gắn lỗi vào đúng ô, viết lại lỗi tiếng Anh của zod", () => {
    const r = parseConnectionDraft(draft({ name: " ", defaultOwner: "", token: "ngan", baseUrl: "http://x.vn" }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors).toEqual({
      name: "Tên không được để trống.",
      defaultOwner: "Không được để trống.",
      token: "Token quá ngắn.",
      baseUrl: "Chỉ nhận địa chỉ https.",
    });
  });

  it("GitHub App: thiếu khoá PEM và installation không phải số", () => {
    const r = parseConnectionDraft(draft({ authMode: "app", appId: "abc", installationId: "12a", privateKey: "x" }));
    expect(!r.ok && r.errors).toEqual({
      appId: "App ID là số.",
      installationId: "Installation ID là số nguyên dương.",
      privateKey: "Khoá riêng phải ở dạng PEM của GitHub App.",
    });
  });
});

describe("issuesToConnectionErrors", () => {
  it("bỏ lỗi không thuộc ô nào, giữ lỗi đầu tiên của mỗi ô", () => {
    expect(
      issuesToConnectionErrors([
        { path: ["kind"], message: "x" },
        { path: ["token"], message: "a" },
        { path: ["token"], message: "b" },
      ]),
    ).toEqual({ token: "a" });
  });
});

describe("hiển thị kết nối", () => {
  it("máy chủ: github.com khi không có baseUrl, host khi có", () => {
    expect(connectionHost({ kind: "github", baseUrl: null })).toBe("github.com");
    expect(connectionHost({ kind: "gitlab", baseUrl: "https://git.acme.vn" })).toBe("git.acme.vn");
    expect(connectionHost({ kind: "github", baseUrl: "https://ghe.acme.vn/api/v3" })).toBe("ghe.acme.vn");
  });

  it("cách xác thực", () => {
    expect(connectionAuthLabel({ authMode: "token", appId: null, installationId: null })).toBe("Access token");
    expect(connectionAuthLabel({ authMode: "app", appId: "12", installationId: 34 })).toBe(
      "GitHub App #12, installation 34",
    );
  });
});

describe("khởi tạo dự án", () => {
  it("hiện các bước khi đang khởi tạo hoặc lỗi", () => {
    expect([showsProvision("provisioning"), showsProvision("failed"), showsProvision("active")]).toEqual([
      true,
      true,
      false,
    ]);
    expect(provisionInFlight([{ state: "done" }, { state: "failed" }])).toBe(false);
    expect(provisionInFlight([{ state: "done" }, { state: "running" }])).toBe(true);
  });

  it("lý do khoá nút Tạo việc", () => {
    expect(createTaskBlockedReason("active", 1, "vi")).toBeNull();
    expect(createTaskBlockedReason("failed", 0, "vi")).toMatch(/khởi tạo dự án bị lỗi/);
    expect(createTaskBlockedReason("provisioning", 0, "en")).toMatch(/being set up/);
    expect(createTaskBlockedReason(undefined, 0, "vi")).toMatch(/chưa có dự án nào đang hoạt động/);
  });
});
