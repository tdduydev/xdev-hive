import type { JenkinsParam } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { filterLog, isCiActive, safeHref } from "@/pages/projects/cicd-run-detail.tsx";
import { initialParamValues } from "@/pages/projects/jenkins-params-form.tsx";

describe("filterLog", () => {
  const log = "Started\nERROR: lint failed\nerror again\nDone";

  it("trả nguyên log khi ô tìm trống", () => {
    expect(filterLog(log, "  ")).toEqual({ text: log, matched: 4, total: 4 });
  });

  it("giữ các dòng khớp, không phân biệt hoa thường", () => {
    expect(filterLog(log, "ERROR")).toEqual({ text: "ERROR: lint failed\nerror again", matched: 2, total: 4 });
  });

  it("không khớp dòng nào thì trả chuỗi rỗng", () => {
    expect(filterLog(log, "zzz")).toEqual({ text: "", matched: 0, total: 4 });
  });
});

describe("safeHref", () => {
  it("chỉ nhận http và https", () => {
    expect(safeHref("https://ci.example.com/run/1")).toBe("https://ci.example.com/run/1");
    expect(safeHref("http://ci.example.com")).toBe("http://ci.example.com");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref(null)).toBeNull();
  });
});

describe("isCiActive", () => {
  it("coi hàng đợi, đang chạy và đang chờ là còn chạy", () => {
    expect(isCiActive("queued")).toBe(true);
    expect(isCiActive("running")).toBe(true);
    expect(isCiActive("waiting")).toBe(true);
    expect(isCiActive("success")).toBe(false);
    expect(isCiActive("failed")).toBe(false);
  });
});

describe("initialParamValues", () => {
  it("lấy mặc định khai báo, mật khẩu để trống, choice lấy lựa chọn đầu khi thiếu mặc định", () => {
    const params: JenkinsParam[] = [
      { type: "string", name: "A", description: null, default: "x" },
      { type: "boolean", name: "B", description: null, default: null },
      { type: "choice", name: "C", description: null, choices: ["p", "q"], default: null },
      { type: "password", name: "D", description: null },
      { type: "text", name: "E", description: null, default: null },
    ];
    expect(initialParamValues(params)).toEqual({ A: "x", B: false, C: "p", D: "", E: "" });
  });
});
