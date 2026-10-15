// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeContext } from "@/shell/me-context.ts";
import { UserMenu } from "@/shell/user-menu.tsx";

const signOut = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth-client.ts", () => ({ authClient: { signOut } }));

const me = { id: "u1", name: "Trần Đức Duy", email: "duy@example.com", image: null };
const assign = vi.fn();

function renderMenu() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MeContext value={me}>
        <UserMenu />
      </MeContext>
    </QueryClientProvider>,
  );
  // Base UI mở menu theo pointerdown, không theo click.
  const trigger = screen.getByRole("button", { name: /Tài khoản/ });
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  fireEvent.mouseDown(trigger, { button: 0 });
  fireEvent.click(trigger);
}

beforeEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: { assign } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("UserMenu", () => {
  it("shows the account and a Đăng xuất item", async () => {
    renderMenu();
    expect(await screen.findByRole("menuitem", { name: "Đăng xuất" })).toBeTruthy();
    expect(screen.getByText(me.email)).toBeTruthy();
  });

  it("signs out through Better Auth then goes to the login page", async () => {
    signOut.mockResolvedValue({ error: null });
    renderMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Đăng xuất" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("stays on the page and shows an error when sign-out fails", async () => {
    signOut.mockResolvedValue({ error: { message: "boom" } });
    renderMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Đăng xuất" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Không đăng xuất được. Thử lại.");
    expect(assign).not.toHaveBeenCalled();
  });
});
