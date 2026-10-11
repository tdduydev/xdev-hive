import { describe, expect, it, vi } from "vitest";
import { isBlockedSmtpAddress, PrivateSmtpHostError, resolveSmtpHost } from "./smtp-host.ts";

describe("địa chỉ SMTP", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.5",
    "127.0.0.1",
    "127.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.1.1",
    "100.64.0.1",
    "100.127.255.255",
    "224.0.0.1",
    "239.255.255.255",
    "::",
    "::1",
    "0:0:0:0:0:0:0:1",
    "fc00::1",
    "fdff::1",
    "fe80::1",
    "febf::1",
    "fe80::1%lo0",
    "ff02::1",
    "::ffff:10.0.0.5",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:c0a8:101",
    "::ffff:100.64.0.1",
    "::ffff:169.254.1.1",
    "::ffff:224.0.0.1",
    "không phải IP",
  ])("chặn %s", (address) => expect(isBlockedSmtpAddress(address)).toBe(true));

  it.each([
    "8.8.8.8",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "192.169.1.1",
    "169.253.1.1",
    "223.255.255.255",
    "2001:4860:4860::8888",
    "fbff::1",
    "fec0::1",
    "::ffff:8.8.8.8",
    "::ffff:808:808",
  ])("cho phép %s", (address) => expect(isBlockedSmtpAddress(address)).toBe(false));

  it("từ chối nếu chỉ một kết quả DNS là nội bộ, kể cả khi IP công khai đứng đầu", async () => {
    const lookup = vi.fn(async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "::1", family: 6 },
    ]);
    await expect(resolveSmtpHost("smtp.example.com", { lookup })).rejects.toBeInstanceOf(PrivateSmtpHostError);
    expect(lookup).toHaveBeenCalledWith("smtp.example.com", { all: true });
  });

  it("không có kết quả DNS thì không kết nối", async () => {
    await expect(resolveSmtpHost("smtp.example.com", { lookup: async () => [] })).rejects.toThrow("Không phân giải");
  });
});
