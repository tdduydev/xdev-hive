// Ranh giới module (docs/architecture.md mục 2). Chạy bằng `pnpm deps`, CI chặn PR vi phạm.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "module-chi-qua-index",
      comment: "Module của hub chỉ được import module khác qua index.ts của nó.",
      severity: "error",
      from: { path: "^apps/hub/src/modules/([^/]+)/" },
      to: {
        path: "^apps/hub/src/modules/[^/]+/",
        pathNot: ["^apps/hub/src/modules/$1/", "^apps/hub/src/modules/[^/]+/index\\.ts$"],
      },
    },
    {
      name: "module-khong-goi-nguoc-app",
      comment: "Module không phụ thuộc vào lớp ghép (app.ts, main.ts) của hub.",
      severity: "error",
      from: { path: "^apps/hub/src/modules/" },
      to: { path: "^apps/hub/src/[^/]+\\.ts$" },
    },
    {
      name: "app-khong-goi-app-khac",
      comment: "hub, web, desktop chỉ dùng chung qua packages/.",
      severity: "error",
      from: { path: "^apps/([^/]+)/" },
      to: { path: "^apps/", pathNot: "^apps/$1/" },
    },
    {
      name: "package-khong-goi-app",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
    {
      name: "vscode-host-va-webview-khong-import-nhau",
      comment:
        "Extension host (apps/vscode/src) và webview (apps/vscode/webview) chỉ chung nhau qua apps/vscode/shared.",
      severity: "error",
      from: { path: "^apps/vscode/(src|webview)/" },
      to: { path: "^apps/vscode/(src|webview)/", pathNot: "^apps/vscode/$1/" },
    },
    { name: "khong-vong-tron", severity: "error", from: {}, to: { circular: true } },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // Bộ skill mặc định là dữ liệu (script mẫu của skill), không phải code của repo.
    exclude: { path: ["(^|/)dist/", "src-tauri/", "^packages/skill-pack/skills/"] },
    // TypeScript 7 chưa có API lập trình nên dùng swc để đọc file .ts.
    parser: "swc",
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    enhancedResolveOptions: { extensions: [".ts", ".tsx", ".js"], conditionNames: ["import", "default"] },
  },
};
