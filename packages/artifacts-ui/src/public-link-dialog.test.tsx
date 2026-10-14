import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ArtifactPublicLink } from "@xdev-hive/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { PublicLinkDialog } from "./public-link-dialog.tsx";
import { PublicLinksTable } from "./public-links-table.tsx";
import { detail, fakeClient, ID_A, renderWithEnv, testEnv } from "./test-fixtures.tsx";

const NOW = "2026-10-14T03:42:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";

function link(over: Partial<ArtifactPublicLink> = {}): ArtifactPublicLink {
  return {
    id: "00000000-0000-4000-8000-0000000000f1",
    artifactId: ID_A,
    version: 1,
    createdBy: "u1",
    createdAt: NOW,
    expiresAt: FUTURE,
    revokedAt: null,
    revokedBy: null,
    revokeReason: null,
    viewCount: 3,
    lastViewedAt: null,
    active: true,
    ...over,
  };
}

function setup(opts: { owner?: boolean; links?: ArtifactPublicLink[]; enabled?: boolean } = {}) {
  const found = detail({ owner: opts.owner ?? true, manage: opts.owner ?? true });
  const base = fakeClient({ [ID_A]: found });
  const links = opts.links ?? [];
  const client = {
    artifacts: {
      ...base.artifacts,
      settings: vi.fn(async () => ({
        enabled: true,
        types: ["markdown"],
        scopes: ["private"],
        maxVersionBytes: 1_000_000,
        maxVersions: 200,
        publicLinks: { enabled: opts.enabled ?? true, maxDays: 14 },
      })),
      publicLinks: {
        list: vi.fn(async () => links),
        create: vi.fn(async (input: { id: string; version: number; expiresInDays: number }) => ({
          link: link({ version: input.version }),
          url: "/_artifact/s/SECRET_CODE",
        })),
        revoke: vi.fn(async (_input: { linkId: string }) => link({ revokedAt: NOW, active: false })),
      },
    },
  };
  const env = testEnv(client as never);
  const onOpenChange = vi.fn();
  const view = (open: boolean) => (
    <PublicLinkDialog artifact={found.artifact} version={1} open={open} onOpenChange={onOpenChange} />
  );
  return { client, env, view, found };
}

describe("PublicLinkDialog", () => {
  it("hiện link đúng một lần và mất khi đóng hộp", async () => {
    const { client, env, view } = setup();
    const { rerender } = renderWithEnv(view(true), env);
    await userEvent.click(await screen.findByRole("button", { name: "Tạo link" }));

    const field = (await screen.findByLabelText("Link công khai vừa tạo")) as HTMLInputElement;
    expect(field.value).toBe("http://hub.test/_artifact/s/SECRET_CODE");
    expect(screen.getByText("Link chỉ hiện một lần")).toBeTruthy();
    expect(client.artifacts.publicLinks.create).toHaveBeenCalledWith(
      { id: ID_A, version: 1, expiresInDays: 7 },
      expect.anything(),
    );

    rerender(view(false));
    rerender(view(true));
    await screen.findByRole("button", { name: "Tạo link" });
    expect(screen.queryByLabelText("Link công khai vừa tạo")).toBeNull();
    expect(document.body.textContent).not.toContain("SECRET_CODE");
  });

  it("người không phải chủ không thấy nút tạo và không gọi danh sách link", async () => {
    const { client, env, view } = setup({ owner: false });
    renderWithEnv(view(true), env);
    expect(await screen.findByText("Chỉ chủ artifact tạo được link công khai.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Tạo link" })).toBeNull();
    expect(client.artifacts.publicLinks.list).not.toHaveBeenCalled();
  });

  it("chặn hạn ngoài mức tối đa của tổ chức", async () => {
    const { client, env, view } = setup();
    renderWithEnv(view(true), env);
    const days = await screen.findByLabelText("Hết hạn sau (ngày)");
    await userEvent.clear(days);
    await userEvent.type(days, "15");
    expect(screen.getByText("Chọn số nguyên từ 1 đến 14 ngày.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Tạo link" }) as HTMLButtonElement).disabled).toBe(true);
    expect(client.artifacts.publicLinks.create).not.toHaveBeenCalled();
  });

  it("báo khi chính sách tắt và khi đủ 10 link", async () => {
    const off = setup({ enabled: false });
    const first = renderWithEnv(off.view(true), off.env);
    expect(await screen.findByText(/Tổ chức đã tắt link công khai/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Tạo link" })).toBeNull();
    first.unmount();

    const many = Array.from({ length: 10 }, (_, i) =>
      link({ id: `00000000-0000-4000-8000-0000000001${i}0`.slice(0, 36) }),
    );
    const full = setup({ links: many });
    renderWithEnv(full.view(true), full.env);
    expect(await screen.findByText(/Đã đủ 10 link còn hiệu lực/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Tạo link" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("thu hồi một link sau khi xác nhận", async () => {
    const item = link();
    const { client, env, view } = setup({ links: [item] });
    renderWithEnv(view(true), env);
    const dialog = await screen.findByRole("dialog");
    const [revoke] = await within(dialog).findAllByRole("button", { name: "Thu hồi…" });
    await userEvent.click(revoke as HTMLElement);
    expect(within(dialog).getByText(/Không thể lấy lại link đã thu hồi/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Thu hồi link" }));
    await waitFor(() => expect(client.artifacts.publicLinks.revoke).toHaveBeenCalled());
    expect(client.artifacts.publicLinks.revoke.mock.calls[0]?.[0]).toEqual({ linkId: item.id });
  });

  it("hiện dòng bí mật khi hub từ chối tạo link", async () => {
    const { client, env, view } = setup();
    client.artifacts.publicLinks.create.mockRejectedValueOnce(
      Object.assign(new Error("bí mật"), {
        data: { code: "ARTIFACT_SECRET_FOUND", findings: [{ line: 12, kind: "x" }] },
      }),
    );
    renderWithEnv(view(true), env);
    await userEvent.click(await screen.findByRole("button", { name: "Tạo link" }));
    expect(await screen.findByText(/dòng 12 có chuỗi giống bí mật/)).toBeTruthy();
  });
});

describe("PublicLinksTable", () => {
  it("chỉ đọc khi không có onRevoke", () => {
    const { env } = setup();
    renderWithEnv(<PublicLinksTable items={[link(), link({ id: "x", revokedAt: NOW, active: false })]} />, env);
    expect(screen.queryByRole("button", { name: "Thu hồi…" })).toBeNull();
    expect(screen.getAllByText("Đã thu hồi").length).toBeGreaterThan(0);
  });

  it("không cho thu hồi link đã hết hiệu lực", () => {
    const { env } = setup();
    const Harness = () => {
      const [calls, setCalls] = useState(0);
      return (
        <>
          <output>{calls}</output>
          <PublicLinksTable items={[link({ active: false, expiresAt: NOW })]} onRevoke={() => setCalls(calls + 1)} />
        </>
      );
    };
    renderWithEnv(<Harness />, env);
    expect(screen.queryByRole("button", { name: "Thu hồi…" })).toBeNull();
  });
});
