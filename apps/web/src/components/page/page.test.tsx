// @vitest-environment jsdom
import { Tabs } from "@base-ui/react/tabs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Th } from "@xdev-hive/ui/table";
import { UsersIcon } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTable } from "@/components/data-table/data-table.tsx";
import { FilterBar, FilterSearch } from "@/components/page/filter-bar.tsx";
import { PageSection } from "@/components/page/page-section.tsx";
import { SegmentedControl } from "@/components/page/segmented-control.tsx";
import { FormRow, RadioCards, SettingsNav, SettingsSection, SwitchRow } from "@/components/page/settings.tsx";
import { StatCard, StatGrid } from "@/components/page/stat-card.tsx";
import { StickyFormFooter } from "@/components/page/sticky-form-footer.tsx";
import { EmptyState, SectionsSkeleton, TableSkeleton } from "@/components/ui/query-state.tsx";
import { PageBody, PageHeader, PageTab, PageTabList } from "@/shell/page-header.tsx";

afterEach(cleanup);

describe("PageHeader", () => {
  it("shows crumb, title, description, meta and actions in order", () => {
    render(
      <PageHeader crumb="Người và quyền" title="Thành viên" description="Ai được vào tổ chức." meta="12 người">
        <button type="button">Mời người</button>
      </PageHeader>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Thành viên" })).toBeTruthy();
    expect(screen.getByText("Ai được vào tổ chức.")).toBeTruthy();
    expect(screen.getByText("12 người")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mời người" })).toBeTruthy();
  });

  it("caps the width of form pages but not of tables", () => {
    const { container } = render(
      <>
        <PageBody>a</PageBody>
        <PageBody width="form">b</PageBody>
      </>,
    );
    const [full, form] = Array.from(container.children);
    expect(full?.className).not.toContain("max-w-");
    expect(form?.className).toContain("max-w-[1120px]");
  });
});

describe("PageTab", () => {
  it("keeps the count in the accessible name with a space, and marks waiting items", () => {
    render(
      <Tabs.Root value="a">
        <PageTabList label="Nhóm thành viên">
          <PageTab value="a" count={3}>
            Đang hoạt động
          </PageTab>
          <PageTab value="b" count={2} tone="warning">
            Chờ duyệt
          </PageTab>
          <PageTab value="c">Khác</PageTab>
        </PageTabList>
      </Tabs.Root>,
    );
    expect(screen.getByRole("tablist", { name: "Nhóm thành viên" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Đang hoạt động 3" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Chờ duyệt 2" }).querySelector(".bg-warning-soft")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Khác" })).toBeTruthy();
  });
});

describe("PageSection", () => {
  it("is a region named by its h2", () => {
    render(
      <PageSection title="Kênh thông báo" description="Nơi hub gửi tin." actions={<button type="button">Thêm</button>}>
        <p>nội dung</p>
      </PageSection>,
    );
    const region = screen.getByRole("region", { name: "Kênh thông báo" });
    expect(region.querySelector("h2")?.textContent).toBe("Kênh thông báo");
    expect(screen.getByRole("button", { name: "Thêm" })).toBeTruthy();
  });
});

describe("FilterBar", () => {
  it("labels the group and reports typed text", () => {
    const onChange = vi.fn();
    render(
      <FilterBar label="Lọc nhật ký" actions={<button type="button">Xuất CSV</button>}>
        <FilterSearch value="" onChange={onChange} placeholder="Tìm người…" />
      </FilterBar>,
    );
    expect(screen.getByRole("group", { name: "Lọc nhật ký" })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Tìm người…" }), { target: { value: "hà" } });
    expect(onChange).toHaveBeenCalledWith("hà");
  });
});

describe("StatCard", () => {
  it("spells out the trend and colours it by whether up is good", () => {
    render(
      <StatGrid>
        <StatCard
          label="Chi phí"
          value="12,40 USD"
          icon={UsersIcon}
          trend={{ direction: "up", label: "+8% so với tuần trước", good: false }}
        />
        <StatCard label="Run thành công" value="96%" hint="7 ngày qua" />
      </StatGrid>,
    );
    const trend = screen.getByText("+8% so với tuần trước");
    expect(trend.parentElement?.className).toContain("text-destructive");
    expect(screen.getByText("7 ngày qua")).toBeTruthy();
    expect(screen.getByText("12,40 USD").className).toContain("tabular-nums");
  });
});

describe("states", () => {
  it("empty state has a heading, the first action and an optional icon", () => {
    render(
      <EmptyState
        icon={UsersIcon}
        title="Chưa có lời mời nào"
        description="Mời đồng nghiệp bằng email."
        action={<button type="button">Mời người</button>}
      />,
    );
    expect(screen.getByRole("heading", { name: "Chưa có lời mời nào" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mời người" })).toBeTruthy();
  });

  it("skeletons are busy status regions with readable text", () => {
    render(
      <>
        <TableSkeleton label="Đang tải thành viên…" rows={2} columns={3} />
        <SectionsSkeleton sections={1} />
      </>,
    );
    const [table, sections] = screen.getAllByRole("status");
    expect(table?.getAttribute("aria-busy")).toBe("true");
    expect(table?.textContent).toBe("Đang tải thành viên…");
    expect(sections?.textContent).toBe("Đang tải…");
  });
});

describe("settings", () => {
  it("section is a group named by its title; rows wire labels to controls", () => {
    const onSwitch = vi.fn();
    render(
      <SettingsSection id="merge" title="Merge" description="Cách PR được merge.">
        <FormRow label="Cách merge" hint="Mặc định squash." htmlFor="method">
          <select id="method">
            <option>Squash</option>
          </select>
        </FormRow>
        <FormRow label="Claude">
          <input aria-label="Viết code (Claude)" />
        </FormRow>
        <SwitchRow label="Bắt buộc CI xanh" hint="Tắt thì repo không có CI vẫn merge." checked onChange={onSwitch}>
          <p>ô phụ</p>
        </SwitchRow>
      </SettingsSection>,
    );
    const group = screen.getByRole("group", { name: "Merge" });
    expect(group.id).toBe("merge");
    expect(screen.getByRole("combobox", { name: "Cách merge" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Claude" })).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Bắt buộc CI xanh" });
    fireEvent.click(toggle);
    expect(onSwitch).toHaveBeenCalledWith(false, expect.anything());
    expect(screen.getByText("ô phụ")).toBeTruthy();
  });

  it("radio cards are real radios; disabled options cannot be picked", () => {
    const onChange = vi.fn();
    render(
      <RadioCards
        name="perm"
        label="Quyền CLI của run"
        value="workspace"
        onChange={onChange}
        options={[
          { value: "workspace", title: "Trong worktree" },
          { value: "full", title: "Toàn quyền", tone: "destructive", disabled: true },
          { value: "other", title: "Khác" },
        ]}
      />,
    );
    expect(screen.getByRole("radiogroup", { name: "Quyền CLI của run" })).toBeTruthy();
    expect((screen.getByRole("radio", { name: "Trong worktree" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: "Toàn quyền" }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Khác" }));
    expect(onChange).toHaveBeenCalledWith("other");
  });

  it("nav links every section and marks the one being read", () => {
    render(
      <SettingsNav
        label="Các phần"
        items={[
          { id: "merge", label: "Merge" },
          { id: "review", label: "Review chéo" },
        ]}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Các phần" });
    expect(nav.querySelector('a[href="#review"]')).toBeTruthy();
    expect(screen.getByRole("link", { name: "Merge" }).getAttribute("aria-current")).toBe("location");
    fireEvent.click(screen.getByRole("link", { name: "Review chéo" }));
    expect(screen.getByRole("link", { name: "Review chéo" }).getAttribute("aria-current")).toBe("location");
  });
});

describe("StickyFormFooter", () => {
  it("disables both buttons until something changes", () => {
    render(<StickyFormFooter dirty={false} saving={false} onDiscard={() => {}} />);
    expect((screen.getByRole("button", { name: "Lưu thay đổi" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Huỷ thay đổi" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says there are unsaved changes, then errors, then saved", () => {
    const onDiscard = vi.fn();
    const { rerender } = render(
      <StickyFormFooter dirty saving={false} onDiscard={onDiscard} saveLabel="Lưu cấu hình" />,
    );
    expect(screen.getByText("Có thay đổi chưa lưu")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Huỷ thay đổi" }));
    expect(onDiscard).toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Lưu cấu hình" }) as HTMLButtonElement).type).toBe("submit");

    rerender(<StickyFormFooter dirty saving={false} onDiscard={onDiscard} error="Hub từ chối." />);
    expect(screen.getByRole("alert").textContent).toBe("Hub từ chối.");

    rerender(
      <StickyFormFooter dirty={false} saving={false} saved onDiscard={onDiscard} savedLabel="Đã lưu cấu hình." />,
    );
    expect(screen.getByRole("status").textContent).toBe("Đã lưu cấu hình.");

    rerender(<StickyFormFooter dirty saving onDiscard={onDiscard} />);
    expect((screen.getByRole("button", { name: "Đang lưu…" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("asks before closing the tab only while there are unsaved changes", () => {
    const unload = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const { rerender, unmount } = render(<StickyFormFooter dirty={false} saving={false} onDiscard={() => {}} />);
    expect(unload()).toBe(false);
    rerender(<StickyFormFooter dirty saving={false} onDiscard={() => {}} />);
    expect(unload()).toBe(true);
    unmount();
    expect(unload()).toBe(false);
  });
});

describe("DataTable layout options", () => {
  const rows = [
    { id: "1", name: "Lê Hà", cost: 12.4 },
    { id: "2", name: "Trần Duy", cost: 3 },
  ];

  it("right-aligns numeric columns and pins the name and action columns", () => {
    render(
      <DataTable
        rows={rows}
        minWidth={640}
        toolbar={<button type="button">Xuất CSV</button>}
        columns={[
          { key: "name", label: "Người", value: (r) => r.name, pin: "start" },
          { key: "cost", label: "Chi phí", value: (r) => r.cost, align: "end" },
          { key: "actions", label: "Thao tác", value: () => null, align: "end", pin: "end" },
        ]}
      />,
    );
    const table = screen.getByRole("table");
    expect(table.style.minWidth).toBe("640px");
    expect(screen.getByRole("button", { name: "Xuất CSV" })).toBeTruthy();
    const [select, name, cost, actions] = Array.from(table.querySelectorAll("thead th"));
    expect(select?.className).toContain("sticky");
    expect(name?.className).toContain("left-10");
    expect(cost?.className).toContain("text-right");
    expect(actions?.className).toContain("sm:sticky");
    const cell = screen.getByText("12.4");
    expect(cell.className).toContain("tabular-nums");
  });
});

describe("DataTable server paging", () => {
  it("shows every row of the hub page and only the hub's page buttons", () => {
    const onNext = vi.fn();
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: String(i), name: `Dòng ${i}` }));
    render(
      <DataTable
        rows={rows}
        columns={[{ key: "name", label: "Tên", value: (r) => r.name }]}
        serverPaging={{
          label: "Trang 2 của nhật ký",
          hasPrevious: true,
          hasNext: true,
          onPrevious: () => {},
          onNext,
          nextLabel: "Trang sau của nhật ký",
        }}
      />,
    );
    expect(screen.getByText("Dòng 29")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Số dòng" })).toBeNull();
    expect(screen.getByText("Trang 2 của nhật ký")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Trang sau của nhật ký" }));
    expect(onNext).toHaveBeenCalled();
  });
});

describe("SegmentedControl", () => {
  it("marks the chosen option with aria-pressed and reports a new choice", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="Khoảng thời gian"
        value="7d"
        onChange={onChange}
        options={[
          { value: "24h", label: "24 giờ" },
          { value: "7d", label: "7 ngày" },
        ]}
      />,
    );
    expect(screen.getByRole("group", { name: "Khoảng thời gian" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "7 ngày" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "24 giờ" }));
    expect(onChange).toHaveBeenCalledWith("24h");
  });
});

describe("Th", () => {
  it("keeps caps for the desktop app and sentence case for admin pages", () => {
    render(
      <table>
        <thead>
          <tr>
            <Th>Máy</Th>
            <Th variant="plain">Chi phí</Th>
          </tr>
        </thead>
      </table>,
    );
    expect(screen.getByText("Máy").className).toContain("uppercase");
    expect(screen.getByText("Chi phí").className).not.toContain("uppercase");
  });
});
