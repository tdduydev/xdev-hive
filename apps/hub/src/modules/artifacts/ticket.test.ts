import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseMasterKey } from "../platform/index.ts";
import { FRAME_TICKET_TTL_SEC, frameTicketKey, signFrameTicket, verifyFrameTicket } from "./ticket.ts";

const key = frameTicketKey(parseMasterKey(randomBytes(32).toString("base64")));
const orgA = randomUUID();
const orgB = randomUUID();
const artifact = randomUUID();
const now = Date.UTC(2026, 9, 14, 8, 0, 0);

const versionTicket = (extra: Record<string, unknown> = {}) =>
  signFrameTicket(key, { o: orgA, a: artifact, v: 3, t: "dark", ...extra }, { now }).ticket;

/** Đổi payload rồi ký lại bằng khoá khác (kẻ tấn công không có khoá của hub). */
function forge(ticket: string, change: (p: Record<string, unknown>) => void, signer = randomBytes(32)): string {
  const [payload] = ticket.split(".") as [string];
  const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  change(body);
  const next = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${next}.${createHmac("sha256", signer).update(next).digest("base64url")}`;
}

describe("vé khung", () => {
  it("ký rồi kiểm ra đúng phiên bản, tổ chức, giao diện", () => {
    const { ticket, expiresAt } = signFrameTicket(key, { o: orgA, a: artifact, v: 3, t: "dark" }, { now });
    expect(expiresAt.getTime()).toBe(now + FRAME_TICKET_TTL_SEC * 1000);
    expect(verifyFrameTicket(key, ticket, now)).toEqual({
      o: orgA,
      a: artifact,
      v: 3,
      t: "dark",
      e: now / 1000 + FRAME_TICKET_TTL_SEC,
    });
  });

  it("vé bản xem trước và vé có `s` của link công khai", () => {
    const preview = randomUUID();
    const p = signFrameTicket(key, { o: orgA, p: preview, t: "light" }, { now }).ticket;
    expect(verifyFrameTicket(key, p, now)).toMatchObject({ o: orgA, p: preview });
    const link = randomUUID();
    expect(verifyFrameTicket(key, versionTicket({ s: link }), now)).toMatchObject({ a: artifact, s: link });
  });

  it("hạn không vượt 5 phút dù người gọi xin dài hơn", () => {
    const { expiresAt } = signFrameTicket(key, { o: orgA, a: artifact, v: 1, t: "light" }, { now, ttlSec: 3600 });
    expect(expiresAt.getTime()).toBe(now + FRAME_TICKET_TTL_SEC * 1000);
  });

  it("hết hạn thì không nhận", () => {
    const ticket = versionTicket();
    expect(verifyFrameTicket(key, ticket, now + (FRAME_TICKET_TTL_SEC - 1) * 1000)).not.toBeNull();
    expect(verifyFrameTicket(key, ticket, now + FRAME_TICKET_TTL_SEC * 1000)).toBeNull();
  });

  it("sửa payload (phiên bản, tổ chức, hạn) mà giữ chữ ký thì không nhận", () => {
    const ticket = versionTicket();
    const [, sig] = ticket.split(".") as [string, string];
    for (const change of [
      (p: Record<string, unknown>) => {
        p.v = 4;
      },
      (p: Record<string, unknown>) => {
        p.o = orgB;
      },
      (p: Record<string, unknown>) => {
        p.e = (p.e as number) + 60;
      },
    ]) {
      const [payload] = forge(ticket, change).split(".") as [string];
      expect(verifyFrameTicket(key, `${payload}.${sig}`, now)).toBeNull();
    }
  });

  it("ký bằng khoá khác (sai tổ chức hay hub khác) thì không nhận", () => {
    expect(
      verifyFrameTicket(
        key,
        forge(versionTicket(), (p) => (p.o = orgB)),
        now,
      ),
    ).toBeNull();
    const otherHub = frameTicketKey(parseMasterKey(randomBytes(32).toString("base64")));
    expect(verifyFrameTicket(otherHub, versionTicket(), now)).toBeNull();
  });

  it("khoá vé khác khoá chủ: chữ ký bằng chính khoá chủ không thành vé", () => {
    const master = randomBytes(32);
    const derived = frameTicketKey({ key: master, id: "x" });
    expect(derived.equals(master)).toBe(false);
    expect(
      verifyFrameTicket(
        derived,
        forge(versionTicket(), () => {}, master),
        now,
      ),
    ).toBeNull();
  });

  it("hạn xa hơn TTL dù chữ ký đúng (khoá lộ hay đồng hồ sai) thì không nhận", () => {
    const far = signFrameTicket(key, { o: orgA, a: artifact, v: 1, t: "light" }, { now: now + 3600_000 }).ticket;
    expect(verifyFrameTicket(key, far, now)).toBeNull();
  });

  it("chuỗi hỏng, trường lạ hay vừa `v` vừa `p` thì không nhận, không ném lỗi", () => {
    for (const bad of ["", "abc", "a.b.c", ".", `${versionTicket()}x`, "%%%.###"]) {
      expect(verifyFrameTicket(key, bad, now)).toBeNull();
    }
    const resign = (change: (p: Record<string, unknown>) => void) => {
      const [payload] = forge(versionTicket(), change).split(".") as [string];
      return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
    };
    expect(
      verifyFrameTicket(
        key,
        resign(() => {}),
        now,
      ),
    ).not.toBeNull();
    expect(
      verifyFrameTicket(
        key,
        resign((p) => (p.p = randomUUID())),
        now,
      ),
    ).toBeNull();
    expect(
      verifyFrameTicket(
        key,
        resign((p) => (p.u = "user")),
        now,
      ),
    ).toBeNull();
    expect(
      verifyFrameTicket(
        key,
        resign((p) => (p.t = "neon")),
        now,
      ),
    ).toBeNull();
    expect(
      verifyFrameTicket(
        key,
        resign((p) => (p.o = "không-phải-uuid")),
        now,
      ),
    ).toBeNull();
  });
});
