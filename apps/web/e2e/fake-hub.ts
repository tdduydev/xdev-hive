import type { Page } from "@playwright/test";

export const USER = { id: "u1", name: "Trần Đức Duy", email: "duy@fpt.com", image: null };

type Reply = { status: number; json: unknown };

export interface FakeHub {
  signedIn: boolean;
  /** Lời gọi Better Auth đã nhận, theo thứ tự. `path` bỏ tiền tố /api/auth. */
  authCalls: { path: string; body: unknown }[];
  meMethods: string[];
}

/**
 * Thay hub bằng route giả trong trình duyệt. Định dạng oRPC (`{"json": ...}`) và lỗi UNAUTHORIZED chép từ phản hồi
 * thật của apps/hub; Better Auth trả `{ code, message }` khi lỗi.
 */
export async function fakeHub(
  page: Page,
  opts: { signedIn?: boolean; auth?: Record<string, (body: unknown, hub: FakeHub) => Reply> } = {},
): Promise<FakeHub> {
  const hub: FakeHub = { signedIn: opts.signedIn ?? false, authCalls: [], meMethods: [] };
  await page.route("**/rpc/me/get**", (route) => {
    hub.meMethods.push(route.request().method());
    return route.fulfill(
      hub.signedIn
        ? { status: 200, json: { json: USER } }
        : {
            status: 401,
            json: { json: { defined: true, code: "UNAUTHORIZED", status: 401, message: "Chưa đăng nhập." } },
          },
    );
  });
  await page.route("**/api/auth/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api\/auth/, "");
    const body = route.request().postDataJSON();
    hub.authCalls.push({ path, body });
    const handler = opts.auth?.[path];
    return route.fulfill(handler ? handler(body, hub) : { status: 404, json: { message: "Not Found" } });
  });
  return hub;
}
