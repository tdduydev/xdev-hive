import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { register } from "tsx/esm/api";
import { capSummary, sortAttention } from "#ui/lib/summary.ts";

register({ tsconfig: new URL("../tsconfig.json", import.meta.url).pathname });
const { AttentionList } = await import("#ui/components/AttentionList.tsx");
const { SummaryStrip } = await import("#ui/components/SummaryStrip.tsx");

describe("dashboard shared rules", () => {
  it("caps the summary strip at 4 numbers", () => {
    assert.deepEqual(capSummary([1, 2, 3, 4, 5]), [1, 2, 3, 4]);
    assert.deepEqual(capSummary([1, 2]), [1, 2]);
  });
  it("lists the worst attention first and keeps the order within a level", () => {
    const out = sortAttention([
      { id: "a", level: "info" as const },
      { id: "b", level: "danger" as const },
      { id: "c", level: "warning" as const },
      { id: "d", level: "danger" as const },
    ]);
    assert.deepEqual(out.map((i) => i.id), ["b", "d", "c", "a"]);
  });

  it("renders each summary number as its filter link and keeps the four-item cap", () => {
    const html = renderToStaticMarkup(createElement(SummaryStrip, {
      label: "Tóm tắt",
      items: ["running", "queued", "review", "blocked", "done"].map((id, index) => ({
        id,
        label: id,
        value: index + 1,
        href: `#/tasks?status=${id}`,
      })),
    }));
    assert.match(html, /<nav aria-label="Tóm tắt"/);
    assert.match(html, /href="#\/tasks\?status=running" data-summary="running"/);
    assert.match(html, /href="#\/tasks\?status=blocked" data-summary="blocked"/);
    assert.doesNotMatch(html, /data-summary="done"/);
    assert.equal((html.match(/data-summary=/g) ?? []).length, 4);
  });

  it("renders row actions beside their attention text, including disabled actions", () => {
    const html = renderToStaticMarkup(createElement(AttentionList, {
      label: "Cần chú ý",
      items: [
        { id: "backup", level: "danger", levelLabel: "Lỗi", text: "Backup thất bại", action: createElement("button", { type: "button" }, "Thử lại") },
        { id: "offline", level: "warning", levelLabel: "Chú ý", text: "Máy đang offline", action: createElement("button", { type: "button", disabled: true }, "Đang kiểm tra") },
      ],
    }));
    assert.match(html, /<ul aria-label="Cần chú ý"/);
    assert.match(html, /data-attention="backup"[^>]*>[\s\S]*Backup thất bại[\s\S]*<button type="button">Thử lại<\/button>/);
    assert.match(html, /data-attention="offline"[^>]*>[\s\S]*Máy đang offline[\s\S]*<button type="button" disabled="">Đang kiểm tra<\/button>/);
  });
});

describe("cosmic primitives", () => {
  it("renders theme variants without project metrics and labels native controls", async () => {
    const { DashboardComponentsFixture } = await import("#ui/pages/DashboardComponentsFixture.tsx");
    const html = renderToStaticMarkup(createElement(DashboardComponentsFixture));
    assert.match(html, /data-cosmic-fixture="dark"/);
    assert.match(html, /data-cosmic-fixture="light"/);
    assert.equal((html.match(/data-variant="blue"/g) ?? []).length, 6);
    assert.equal((html.match(/role="switch"/g) ?? []).length, 2);
    assert.match(html, /aria-pressed="true"/);
    assert.match(html, /không phải số liệu dự án/);
  });
  it("preserves disabled selectors and selected filter semantics", async () => {
    const { SegmentedTabs, Switch } = await import("#ui/components/ui/primitives.tsx");
    const html = renderToStaticMarkup(createElement(SegmentedTabs, {
      label: "Status", items: [{ value: "all", label: "All" }, { value: "done", label: "Done", disabled: true }], value: "all", onChange: () => {},
    }));
    assert.match(html, /aria-label="Status"/);
    assert.match(html, /aria-pressed="true"/);
    assert.match(html, /disabled="" aria-pressed="false"/);
    assert.match(renderToStaticMarkup(createElement(Switch, { disabled: true, defaultChecked: true }, "Notify")), /role="switch" checked=""/);
  });
});
