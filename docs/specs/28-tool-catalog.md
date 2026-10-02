# 28. Danh mục tool

Viết ngày 2/10. Người dùng nói hệ thống thiếu phần quản lý các tool như codegraph, và hỏi cần thêm tool gì để tiết kiệm token và bộ nhớ.

Trang này chi tiết **R-28a** (danh mục trên hub). Phần **R-28b** (máy dùng danh mục) chỉ ghi những gì 28a phải chừa sẵn. R-28c (đo token) do phiên khác làm. R-28d (RTK) và R-28e (leader đọc và đề xuất về tool) làm sau.

## Hiện trạng

Ba tool được viết cứng trong code:

| Tool | Ở đâu | Máy làm gì |
|---|---|---|
| codegraph | `CODEGRAPH_PACKAGE`, `CODEGRAPH_MCP`, `CODEGRAPH_RUN_MCP`, `installCodegraphMcp` (`apps/desktop/src/main/installer.ts`); mục `codegraph-mcp`, `codegraph-index` (`setup.ts`); `prepareCodegraph` (`runner/codegraph.ts`); `claudeRunArgs` (`runner/command.ts`) | Ghi `.mcp.json` của repo; dựng index; run Claude có server `codegraph` (`CODEGRAPH_NO_DAEMON=1`); index được dựng trong worktree trước mỗi run |
| superpowers | `SUPERPOWERS_PLUGIN`, `enableSuperpowers` (`installer.ts`); mục `superpowers` | Bật plugin trong `.claude/settings.json` của repo; run Claude có `enabledPlugins` |
| Spec Kit | `SPECKIT_SOURCE` (`setup.ts`, không ghim phiên bản), mục máy `cli:specify`, mục repo `<dự án>:speckit` | `uv tool install specify-cli`; `specify init` cho claude và codex |

Danh sách tên còn nằm ở `POLICY_REPO_PARTS` (`packages/core/src/types.ts`) và regex `setupItemId` (`packages/core/src/methods.ts`). Chính sách agent (27a) có `mcp: string[] | null`, là tên server tự do.

Thêm một tool là phải sửa code ở cả năm chỗ và phát hành bản mới. Run lại đặt `disableAllHooks: true`, nên tool chạy bằng hook không dùng được.

## R-28a. Danh mục trên hub

### Mô hình (`packages/core/src/types.ts`)

```ts
export const TOOL_KINDS = ["mcp", "plugin", "hook", "cli"] as const;
export const TOOL_AGENTS = ["claude", "codex", "gemini"] as const;
export const TOOL_REGISTRIES = ["npm", "pypi", "brew", "git", "claude-plugin"] as const;
/** Tool máy đã có code riêng: 28b gọi code đó cho phần cài, chuẩn bị và kiểm tra, danh mục quyết bật, phiên bản và chính sách. */
export const TOOL_HANDLERS = ["codegraph", "superpowers", "speckit"] as const;

export interface ToolEntry {
  /** Cũng là tên server MCP trong cấu hình run và trong chính sách agent: /^[a-z0-9][a-z0-9-]{0,39}$/. */
  id: string;
  name: string;                       // 1–80
  description: string;                // ≤ 500
  kind: (typeof TOOL_KINDS)[number];
  package: { registry: (typeof TOOL_REGISTRIES)[number]; name: string; version: string } | null;
  /** kind "mcp": lệnh chạy server. */
  mcp: { command: string; args: string[] } | null;
  /** kind "plugin": id plugin của Claude Code, ví dụ superpowers@claude-plugins-official. */
  plugin: string | null;
  /** kind "hook": hook của Claude Code mà run bật (28b/28d). */
  hooks: Array<{ event: "PreToolUse" | "PostToolUse" | "SessionStart" | "Stop"; matcher: string; command: string[] }>;
  agents: Array<(typeof TOOL_AGENTS)[number]>;
  /** Trên máy: lệnh kiểm đã cài (thoát 0 là có) và lệnh cài. null: không cần cài riêng (npx tự tải). */
  check: string[] | null;
  install: string[] | null;
  /** Trong worktree của run: init khi chưa có `marker`, sync khi đã có (như index codegraph). */
  prepare: { init: string[]; sync: string[]; marker: string } | null;
  /** Biến môi trường cố định, không phải secret. Tắt telemetry, kiểm tra cập nhật. */
  env: Record<string, string>;
  /** Tên biến máy tự cung cấp (khoá API…), hub không bao giờ giữ giá trị. */
  secretEnv: string[];
  license: string;                    // SPDX, ví dụ MIT
  homepage: string | null;            // https
  handler: (typeof TOOL_HANDLERS)[number] | null;
  /** Bật cho mọi dự án, trừ dự án tắt riêng. */
  enabledByDefault: boolean;
}

export interface ToolView extends ToolEntry {
  builtin: boolean;                   // seed: không xoá được, chỉ tắt
  version: number;                    // phiên bản của mục (khoá lạc quan), không phải phiên bản gói
  updatedAt: string;
  updatedBy: string;
  /** Các dự án người xem thấy được có cài đặt riêng (enabled null: theo mặc định). */
  projects: Array<{ project: string; enabled: boolean | null; required: boolean; effective: boolean }>;
}
```

- Lệnh là mảng argv, không qua shell. Hub thay thế các chỗ giữ chỗ sau, máy thay tiếp ở 28b:
  - `{package}`: npm thành `name@version`, pypi thành `name==version`, git thành `git+<name>@<version>`;
  - `{worktree}`, `{repo}`: máy thay.
- **Kiểm khi lưu** (mỗi lỗi một key `errors.tool*`, thêm vào `vi.ts` / `en.ts`):
  - `id` đúng regex.
  - `kind` khớp với trường riêng của nó: `mcp` cần `mcp`; `plugin` cần `plugin`; `hook` cần ít nhất một hook; `cli` cần `check`.
  - **Phiên bản phải ghim**:
    - `package.version` khớp `/^v?\d+\.\d+\.\d+([-+.][0-9A-Za-z.-]+)?$/`;
    - không phần tử argv nào là `latest`, chứa `@latest`, hay bắt đầu bằng `^` hoặc `~`;
    - có `package` thì argv không được viết thẳng `package.name`, phải dùng `{package}`, để không lệch phiên bản.
  - Giá trị `env` không có ký tự ẩn và không giống secret (`assertNoHidden`, `assertNoSecret` như ở `chat.propose`). Tên trong `env` và `secretEnv` khớp `/^[A-Z][A-Z0-9_]{0,63}$/`.
  - `homepage` là https. `license` không rỗng.
  - `handler` chỉ dùng được với mục seed (`builtin`).

### Lưu trữ

Migration mới ở cuối `MIGRATIONS` (`packages/core/src/sqlite.ts`), lấy số kế tiếp trên main lúc merge:
- `tools(id TEXT PRIMARY KEY, entry TEXT NOT NULL, builtin INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL)`; `entry` là JSON của `ToolEntry` trừ `id`.
- `tool_projects(tool_id TEXT NOT NULL, project TEXT NOT NULL, enabled INTEGER, required INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(tool_id, project))`; `enabled` NULL nghĩa là theo `enabledByDefault`.
- Cùng migration chèn ba mục seed (`builtin = 1`, `version = 1`, `updated_by = 'hive'`). Ghi đúng những gì máy đang chạy hôm nay. Nâng phiên bản là việc sửa danh mục sau 28b.

| id | kind | package | mcp / plugin | env | handler | license |
|---|---|---|---|---|---|---|
| `codegraph` | mcp | npm `@colbymchenry/codegraph` `1.6.0` | `npx -y {package} serve --mcp`; prepare: init `npx -y {package} init {worktree}`, sync `npx -y {package} sync {worktree}`, marker `.codegraph/codegraph.db` | `CODEGRAPH_TELEMETRY=0`, `CODEGRAPH_NO_UPDATE_CHECK=1` | codegraph | MIT |
| `superpowers` | plugin | claude-plugin `superpowers@claude-plugins-official` `6.4.2` | plugin `superpowers@claude-plugins-official` | — | superpowers | MIT |
| `speckit` | cli | git `https://github.com/github/spec-kit.git` `v1.0.13` | — ; check `specify --version`; install `uv tool install specify-cli --from {package}` | — | speckit | MIT |

`agents`: codegraph và superpowers là `["claude"]` (máy hiện chỉ đưa vào run Claude); speckit là `["claude", "codex"]`. `enabledByDefault` đều `false`: máy chưa đọc danh mục cho tới 28b, nên bật theo dự án lúc này chỉ có tác dụng hiển thị.

- Giấy phép: codegraph, superpowers (obra/superpowers) và Spec Kit đều là MIT, theo GitHub ngày 2/10. Spec Kit v1.0.13 là release mới nhất ngày 29/9.
- Phiên bản superpowers: `6.4.2` là release mới nhất của obra/superpowers (25/9, khớp `version` trong `.claude-plugin/plugin.json`). Máy hiện bật plugin qua marketplace `claude-plugins-official` mà không ghim phiên bản; marketplace có phát đúng bản này không thì chưa kiểm. Danh mục chỉ ghi nhận phiên bản cho tới 28b.

### Method (`packages/core/src/methods.ts`: `schemas`, `MethodOutput`, `roles`; kiểm quyền trong `#check`)

| Method | Role | Quyền | Làm gì |
|---|---|---|---|
| `tools.list` `{ project? }` | viewer | — | Mọi mục, mỗi mục chỉ kèm cài đặt của các dự án người xem có `view`. Có `project` thì chỉ dự án đó (cần `view`). |
| `tools.save` `{ entry, baseVersion? }` | admin | admin hub (`actor.role === "admin" && !actor.access`) | Tạo (không có `baseVersion`, id chưa có) hoặc thay (có `baseVersion` bằng `version` hiện tại, không thì `conflict`, `errors.toolVersion`). Mục seed: được sửa mọi trường trừ `id`, `handler`, `kind`. |
| `tools.remove` `{ id }` | admin | admin hub | Xoá mục và `tool_projects` của nó. Mục seed thì từ chối (`errors.toolBuiltin`). |
| `tools.setProject` `{ id, project, enabled: boolean \| null, required }` | agent | `projectSettings` trên dự án | Cài đặt của một dự án. `enabled: null` và `required: false` thì xoá dòng. |

- Ghi nhật ký: thêm `tools.save`, `tools.remove`, `tools.setProject` vào `AUDITED`, theo mẫu `agentPolicy.set`. Detail là id, `package.name@version`, bật/tắt và dự án.
- Phát sự kiện `tool.changed` (thêm vào union `HiveEvent`) để 28b đẩy xuống máy. Chưa cần webhook.

### Giao diện: trang *Tool*

- **App và web phía người dùng**: trang `tools` trong nhóm `nav.groupAgents` (cạnh `setup`, `projects`) trong `packages/ui/src/App.tsx`.
- **Web Admin**: mục `tools` trong nhóm `admin` của `ADMIN`.
- File `packages/ui/src/pages/Tools.tsx`.
- **Danh sách**: tên, `kind` (badge), gói@phiên bản, giấy phép, CLI dùng được, biến telemetry đã tắt (`env`), nhãn *Có sẵn* cho mục seed.
- **Theo dự án đang chọn** ở ô phạm vi:
  - công tắc *Bật cho dự án* (ba trạng thái: theo mặc định / bật / tắt);
  - ô *Bắt buộc*;
  - chỉ người có `projectSettings` sửa được.
- **Admin hub**:
  - *Thêm tool*, *Sửa*, *Xoá* (không có với mục seed);
  - form theo `kind`; argv nhập mỗi phần tử một dòng; `env` nhập `TÊN=giá trị` mỗi dòng;
  - lỗi kiểm hiện ngay dưới ô.
- Dòng chú thích trên trang: máy dùng danh mục từ bản có 28b; trước đó máy vẫn cài như *Cài đặt máy*.
- Trang *Chính sách agent* (`packages/ui/src/pages/admin/AgentPolicy.tsx`): ô MCP gợi ý các id `kind: "mcp"` của danh mục. Vẫn nhận tên khác, vì Codex có server riêng trong `~/.codex/config.toml`.
- Mọi chữ trong `vi.ts` (gốc) và `en.ts`, nhóm `tools.*`. Thêm `["tools", 1500]` vào danh sách trang chụp trong `apps/desktop/scripts/smoke.mjs`.

### Test

- `packages/core/test/tools.test.ts` (mới):
  - seed có ba mục đúng như bảng trên sau migration;
  - `tools.save` từ chối:
    - phiên bản không ghim (`latest`, `^1.2.0`, `@latest` trong args);
    - tên gói viết thẳng trong argv thay vì `{package}`;
    - secret hay ký tự ẩn trong `env`;
    - `kind` thiếu trường;
    - `handler` trên mục không phải seed;
  - khoá lạc quan: `baseVersion` cũ thì `conflict`;
  - quyền:
    - chỉ admin hub lưu và xoá;
    - người có `projectSettings` ở dự án A đặt được A, không đặt được B;
    - viewer thấy danh sách nhưng chỉ phần dự án mình xem được;
  - mục seed không xoá được; `effective` đúng với cả ba trạng thái;
  - nhật ký có dòng cho mỗi method ghi.
- `apps/web/e2e/browser.mjs`: mở *Tool*, bật codegraph cho một dự án, thấy trạng thái đổi; admin thêm một mục mcp hợp lệ rồi xoá.

## R-28b (sau): 28a phải chừa sẵn

- Heartbeat sẽ mang danh mục và cài đặt dự án xuống máy. Vì vậy `tools.list` không đọc gì của máy và không nặng.
- Máy:
  - mục có `handler` gọi code hiện có;
  - mục không có handler dùng `check` / `install` / `prepare` / `mcp`;
  - hook chỉ bật những gì danh mục khai báo.
- Lúc chuyển: dự án chưa có dòng trong `tool_projects` mà repo vẫn có codegraph trong `.mcp.json` (hay superpowers trong `.claude/settings.json`) thì máy coi là bật, như hôm nay.
- `POLICY_REPO_PARTS` và `setupItemId` sẽ nhận id của danh mục.

## Ràng buộc khi làm

- Máy chạy agent (claude-1) không chạy được `npm` hay `node`. Viết code và test cẩn thận; người merge chạy `npm run typecheck`, `npm test`, e2e và smoke.
- Không tăng `version`, không đánh dấu [x] trong `docs/roadmap.md`: người merge làm.
- Import khác thư mục dùng alias (`#core/`, `#ui/`, `#web/`, `@xdev-hive/core`), không dùng `../`. Màu và khoảng cách theo token của design system (`packages/ui/src/tokens/`), component có sẵn (`Button`, `Badge`, `Switch`…).
- Comment giải thích vì sao, không phải cái gì.
- Không đụng phần máy (`apps/desktop/src`): đó là 28b. Ngoại lệ duy nhất là danh sách trang của smoke.
- Kết thúc: `task_update` sang `review`, ghi chú đã làm / chưa làm / cách kiểm / rủi ro, kể cả chỗ nào chưa chắc vì không chạy được test.
