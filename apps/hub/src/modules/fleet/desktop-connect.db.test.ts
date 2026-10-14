import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { createPool, type Tx, withTenant } from "../platform/index.ts";
import { approveDesktopConnect, desktopConnectOptions, exchangeDesktopConnect } from "./desktop-connect.ts";
import { registerMachine } from "./registration.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const tag = randomUUID().slice(0, 6);

let org: OrgFixture & { user: (n: string) => string };
const issued: string[] = [];
const deps = {
  publicUrl: "http://hub.test:3000/",
  issuePersonalToken: async (_tx: Tx, userId: string, purpose: "desktop" | "cli") => {
    issued.push(`${purpose}:${userId}`);
    return { token: `hive_pat_fake_${userId}`, expiresAt: new Date("2027-01-10T00:00:00.000Z") };
  },
};
const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, fn);

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
const state = () => randomBytes(16).toString("base64url");
const codeOf = (url: string) => new URL(url).searchParams.get("code") ?? "";

beforeAll(async () => {
  org = await seedOrg(admin, `dc-${tag}`);
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("đăng nhập app desktop bằng trình duyệt", () => {
  it("chỉ hiện đội người dùng được đăng ký máy", async () => {
    expect((await as("tadmin", (tx) => desktopConnectOptions(tx, org.user("tadmin")))).teams.map((t) => t.id)).toEqual([
      org.teamId,
    ]);
    expect((await as("tmember", (tx) => desktopConnectOptions(tx, org.user("tmember")))).teams).toEqual([]);
    expect(
      await errorCode(() =>
        as("tmember", (tx) =>
          approveDesktopConnect(tx, org.user("tmember"), {
            teamId: org.teamId,
            machine: "mac-ha",
            port: 50_123,
            state: state(),
            ...pkce(),
          }),
        ),
      ),
    ).toBe("TEAM_ROLE_REQUIRED");
  });

  it("cho phép rồi đổi mã: về 127.0.0.1 kèm state, đổi một lần lấy mã đăng ký dùng được và token cá nhân", async () => {
    const { verifier, challenge } = pkce();
    const s = state();
    const { redirectUrl } = await as("tadmin", (tx) =>
      approveDesktopConnect(tx, org.user("tadmin"), {
        teamId: org.teamId,
        machine: `mac-${tag}`,
        port: 50_123,
        state: s,
        challenge,
      }),
    );
    const url = new URL(redirectUrl);
    expect(url.origin).toBe("http://127.0.0.1:50123");
    expect(url.pathname).toBe("/callback");
    expect(url.searchParams.get("state")).toBe(s);
    const code = codeOf(redirectUrl);
    expect(code.startsWith("hdc_")).toBe(true);

    // Verifier sai không tiêu mã: app thật vẫn đổi được.
    expect(await errorCode(() => exchangeDesktopConnect(app, { code, verifier: pkce().verifier }, deps))).toBe(
      "DESKTOP_CONNECT_INVALID",
    );
    const out = await exchangeDesktopConnect(app, { code, verifier }, deps);
    expect(out).toMatchObject({
      hubUrl: "http://hub.test:3000",
      machine: `mac-${tag}`,
      teamId: org.teamId,
      personalToken: `hive_pat_fake_${org.user("tadmin")}`,
      personalTokenExpiresAt: "2027-01-10T00:00:00.000Z",
    });
    expect(issued).toContain(`desktop:${org.user("tadmin")}`);
    expect(await errorCode(() => exchangeDesktopConnect(app, { code, verifier }, deps))).toBe(
      "DESKTOP_CONNECT_INVALID",
    );

    if (out.purpose !== "desktop") throw new Error("thiếu mã đăng ký máy");
    const reg = await registerMachine(app, {
      registrationToken: out.registrationToken,
      machineId: out.machine,
      os: "darwin",
      version: "0.2.1",
      clis: ["claude"],
      capacity: 1,
    });
    expect(reg.teamId).toBe(org.teamId);
    const { rows } = await admin.query("select registered_by from hive.machines where org_id = $1 and name = $2", [
      org.orgId,
      reg.machineId,
    ]);
    expect(rows[0].registered_by).toBe(org.user("tadmin"));
  });

  it("mã hết hạn hoặc người dùng mất quyền thì không đổi được", async () => {
    const a = pkce();
    const expired = codeOf(
      (
        await as("tadmin", (tx) =>
          approveDesktopConnect(tx, org.user("tadmin"), {
            teamId: org.teamId,
            machine: "old",
            port: 50_124,
            state: state(),
            challenge: a.challenge,
          }),
        )
      ).redirectUrl,
    );
    await admin.query(
      "update hive.desktop_connect_codes set expires_at = now() - interval '1 second' where org_id = $1 and machine = 'old'",
      [org.orgId],
    );
    expect(await errorCode(() => exchangeDesktopConnect(app, { code: expired, verifier: a.verifier }, deps))).toBe(
      "DESKTOP_CONNECT_INVALID",
    );

    const b = pkce();
    const demoted = codeOf(
      (
        await as("tadmin", (tx) =>
          approveDesktopConnect(tx, org.user("tadmin"), {
            teamId: org.teamId,
            machine: "gone",
            port: 50_125,
            state: state(),
            challenge: b.challenge,
          }),
        )
      ).redirectUrl,
    );
    await admin.query("update hive.team_members set role = 'member' where team_id = $1 and user_id = $2", [
      org.teamId,
      org.user("tadmin"),
    ]);
    try {
      expect(await errorCode(() => exchangeDesktopConnect(app, { code: demoted, verifier: b.verifier }, deps))).toBe(
        "TEAM_ROLE_REQUIRED",
      );
    } finally {
      await admin.query("update hive.team_members set role = 'admin' where team_id = $1 and user_id = $2", [
        org.teamId,
        org.user("tadmin"),
      ]);
    }
  });

  it("`hive login` (purpose cli): người không có quyền đăng ký máy vẫn lấy được token cá nhân, không có mã đăng ký", async () => {
    const { verifier, challenge } = pkce();
    const { redirectUrl } = await as("tmember", (tx) =>
      approveDesktopConnect(tx, org.user("tmember"), {
        purpose: "cli",
        machine: `cli-${tag}`,
        port: 50_126,
        state: state(),
        challenge,
      }),
    );
    const out = await exchangeDesktopConnect(app, { code: codeOf(redirectUrl), verifier }, deps);
    expect(out).toEqual({
      purpose: "cli",
      hubUrl: "http://hub.test:3000",
      machine: `cli-${tag}`,
      personalToken: `hive_pat_fake_${org.user("tmember")}`,
      personalTokenExpiresAt: "2027-01-10T00:00:00.000Z",
    });
    expect(issued).toContain(`cli:${org.user("tmember")}`);
    const { rows } = await admin.query(
      "select action from hive.audit_log where org_id = $1 and actor_user_id = $2 and action like '%connect.exchange'",
      [org.orgId, org.user("tmember")],
    );
    expect(rows.map((r) => r.action)).toEqual(["cli.connect.exchange"]);
    const { rows: codes } = await admin.query(
      "select team_id, purpose from hive.desktop_connect_codes where org_id = $1 and machine = $2",
      [org.orgId, `cli-${tag}`],
    );
    expect(codes).toEqual([{ team_id: null, purpose: "cli" }]);
  });

  it("thiếu `purpose` là app desktop cũ và vẫn phải chọn đội", async () => {
    await expect(
      as("tadmin", (tx) =>
        approveDesktopConnect(tx, org.user("tadmin"), {
          machine: "no-team",
          port: 50_127,
          state: state(),
          ...pkce(),
        } as never),
      ),
    ).rejects.toThrow();
  });
});
