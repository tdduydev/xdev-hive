# 28b. Máy cài và chạy tool theo danh mục

Viết ngày 2/10, sau spec 28a ([28-tool-catalog.md](28-tool-catalog.md)). 28b chờ R-28a; lúc viết trang này 28a đang được làm. Tên method hay trường của 28a lúc merge khác ở đây thì theo bản đã merge, và ghi lại chỗ khác trong ghi chú bàn giao.

Mục tiêu: tool trong danh mục của hub tới được run trên máy mà không phải sửa code app. Ví dụ: nâng codegraph lên 1.6.1, hay thêm một server MCP mới, chỉ là một lần sửa trên trang *Tool*.

Phần này lớn, nên tách thành hai task:
- **R-28b-1. Runner**: nhận danh mục, quyết tool nào chạy trong run, sinh cấu hình cho Claude và Codex, chạy bước chuẩn bị, người dùng máy cho phép.
- **R-28b-2. Cài đặt máy**: mục `tool:<id>` trên trang *Cài đặt máy*, admin yêu cầu cài được, tool bắt buộc tính vào *máy thiếu mục bắt buộc*.

Ngoài phạm vi:
- **Hook** (`kind: "hook"`) để cho 28d. Lý do: run dùng `--setting-sources user`, nên bỏ `disableAllHooks` sẽ chạy cả hook trong `~/.claude/settings.json` của người dùng máy. Cách bật riêng hook của danh mục cần thử với Claude Code thật, mà 28d (RTK) phải chạy thử thật đằng nào cũng làm.
- **Gemini**: CLI không có cờ truyền MCP như `--mcp-config`. Bản container (11b) dùng `/etc/gemini-cli/settings.json`, file này phải thuộc root. Trên máy thật chưa có cách đã kiểm, nên run Gemini giữ như hôm nay.
- **Container**: run trong container vẫn không có tool của danh mục, như codegraph hôm nay (`runner.ts`: "A container has neither the hive-mcp shim nor this machine's codegraph").

## Cơ chế có sẵn

- **Heartbeat**: `machines.heartbeat` trả về `policy`, `agentPolicy`, `profileChanges`… (`MethodOutput` trong `packages/core/src/methods.ts`). Runner giữ `agentPolicy` trong `#agentPolicy` (`apps/desktop/src/main/runner/runner.ts`, hàm `heartbeat()`); `HubUpdate` đi tới `onHub` trong `apps/desktop/src/main/index.ts`. Hub cũ không gửi trường mới thì app bỏ qua.
- **Chạy agent**:
  - `buildCommand` / `claudeRunArgs` (`runner/command.ts`) sinh `--settings` (`permissions.allow`, `enabledPlugins`, `disableAllHooks`) và `--mcp-config` (`runMcpServers` trong `installer.ts`);
  - `codexArgs` thêm `-c mcp_servers.xdev-hive…`;
  - `applyPolicy` lọc MCP theo `pol.mcp`.
- **Bước chuẩn bị**: `prepareCodegraph` (`runner/codegraph.ts`), gọi trong `#execute` khi `features.codegraph` và chính sách cho phép.
- **Cài đặt máy**: `Setup` (`apps/desktop/src/main/setup.ts`): `status()`, `item(id)`, `install(id)`; mục máy `cli:*`, `shim`; mục repo `<dự án>:<phần>`. Hub kiểm id bằng `setupItemId` (`methods.ts`). Yêu cầu cài từ admin: `admin.commandCreate`, máy hiện ở *Cài đặt máy* để người dùng máy bấm.
- **Mục bắt buộc**: `requiredItemIds` / `missingRequired` (`packages/core/src/policy.ts`).

## R-28b-1. Runner

### Hub gửi danh mục

`machines.heartbeat` trả thêm:
```ts
tools?: {
  entries: ToolEntry[];
  /** Mỗi dự án của máy mà token thấy được: cài đặt từng tool (như ToolView.projects). */
  projects: Record<string, Array<{ id: string; enabled: boolean | null; effective: boolean; required: boolean }>>;
};
```
- Chỉ gửi mục bật cho ít nhất một dự án của máy, hoặc `enabledByDefault`, hoặc có dòng `tool_projects` cho dự án của máy.
- Chỗ giữ chỗ (`{package}`, `{worktree}`, `{repo}`) còn nguyên. Máy thay bằng một hàm thuần trong core (`toolArgv`, mục *Lệnh* dưới đây), để trang *Tool* xem trước được đúng lệnh.
- Runner giữ bản này như `#agentPolicy` (`#tools`); `HubUpdate.tools` đi tới `onHub`.
- Chế độ cục bộ, hay hub cũ không gửi: `null`, máy chạy như hôm nay.

### Lệnh (`packages/core/src/tools.ts`, browser-safe)

- `toolArgv(argv, entry, ctx: { worktree?: string; repo?: string })` thay:
  - `{package}`: npm thành `name@version`, pypi thành `name==version`, git thành `git+<name>@<version>`;
  - `{worktree}`, `{repo}`.

  Còn chỗ giữ chỗ không thay được (ví dụ `{worktree}` khi cài) thì ném lỗi có key.
- `toolHash(entry)`: SHA-256 của các trường quyết định máy chạy gì: `package`, `mcp`, `plugin`, `check`, `install`, `prepare`, `env`, `secretEnv`. Dùng cho việc cho phép (dưới đây).

### Người dùng máy cho phép

Danh mục chạy lệnh trên máy của mọi người có dự án. Vì vậy một mục chỉ được chạy trên máy khi người dùng máy đã cho phép đúng phiên bản lệnh đó.
- Lưu trong `config.json` của app: `toolTrust: Record<id, hash>`.
- Mục có `handler` mà các trường lệnh trùng hằng của app (codegraph `1.6.0` như `CODEGRAPH_MCP`, superpowers, Spec Kit) được coi là đã cho phép, để bản này không đổi gì với máy đang chạy.
- Mục chưa cho phép, hay `toolHash` đổi (ví dụ nâng phiên bản):
  - run bỏ qua tool đó và ghi một dòng `# tool <id>: chờ người dùng máy cho phép (Cài đặt máy)`;
  - trang *Cài đặt máy* có thẻ *Tool từ hub* liệt kê lệnh sẽ chạy (đã thay chỗ giữ chỗ), `env`, giấy phép, kèm nút *Cho phép* / *Bỏ*.
- IPC mới trong `DesktopBridge` (`packages/core/src/bridge.ts`, cạnh `installSetup`): `toolTrust(id, hash | null)`.

### Tool nào chạy trong một run

Thêm hàm thuần `runTools(catalog, project, repo, kind, pol, trust)` → `ToolEntry[]`. Một mục chạy khi đủ cả:
1. Mục có trong `catalog.projects[project]` với `effective`, hoặc `enabled === null` mà repo đã bật theo cách cũ.
   - Cách cũ: `repoFeatures(repo)`, tức codegraph trong `.mcp.json` hay superpowers trong `.claude/settings.json` (quy tắc chuyển tiếp ghi ở spec 28a).
2. `entry.agents` có `kind` của profile.
3. `kind === "mcp"`: chính sách cho phép (`pol.mcp === null || pol.mcp.includes(id)`).
4. Đã được cho phép trên máy (mục trên).
5. Đủ `secretEnv`: mỗi tên có trong `profile.env` hay env của máy. Thiếu thì bỏ qua, ghi dòng `# tool <id>: thiếu <TÊN>`; không ghi giá trị.

`catalog === null` thì giữ đúng đường hiện nay: `repoFeatures`, `CODEGRAPH_RUN_MCP`, `SUPERPOWERS_PLUGIN`.

### Cấu hình cho từng CLI

- **Claude** (`claudeRunArgs` nhận danh sách tool thay cho `RepoFeatures`):
  - `--mcp-config`: `xdev-hive` như cũ, cộng với mỗi mục `mcp`: `{ type: "stdio", command, args: toolArgv(...), env: { ...entry.env, ...secret } }`.
    - Mục có `handler: "codegraph"` thêm `CODEGRAPH_NO_DAEMON: "1"`, như `CODEGRAPH_RUN_MCP` hôm nay: server tắt cùng agent.
  - `permissions.allow` thêm `mcp__<id>`.
  - `enabledPlugins[entry.plugin] = true` cho mục `plugin`.
  - `disableAllHooks` vẫn `true`.
- **Codex** (`codexArgs`), mỗi mục `mcp`:
  - `-c mcp_servers.<id>.command=…`, `args=[…]`, `env={…}` (TOML như `codexMcpArgs`);
  - `-c mcp_servers.<id>.default_tools_approval_mode="approve"`, vì headless thì tool cần hỏi bị từ chối. Mục này người dùng máy đã cho phép.
  - **[Chưa kiểm]**: tool chỉ đọc như `codegraph_explore` có cần dòng approve không. Thử thật khi merge.
  - Server cùng tên trong `~/.codex/config.toml` bị `-c` ghi đè; đó là ý muốn.
- **Gemini**: không đổi (xem phần ngoài phạm vi).

### Bước chuẩn bị

- `prepareCodegraph` thành `prepareTool(entry, worktree, …)`:
  - `marker` đã có trong worktree thì chạy `prepare.sync`, chưa có thì chạy `prepare.init`;
  - env là `entry.env`;
  - lỗi hay quá 5 phút thì run vẫn chạy;
  - mỗi mục một dòng log `# <id>: init|sync <giây> s`.
- Chạy cho mọi mục của `runTools` có `prepare`, lần lượt, trước khi agent bắt đầu. Đổi test hiện có (`apps/desktop/test/runner.test.ts`, các test "codegraph index") cho khớp, giữ nguyên hành vi.
- `AGENT_CLI_DIRS` (`worktree.ts`) đang có `.codegraph`. Mục mới có thư mục riêng thì thêm trường `workDir?: string` vào `prepare` (đường dẫn tương đối, để ngoài commit của agent). Nếu 28a chưa có trường này thì thêm cả ở hub (kiểm: tương đối, không `..`).

### Test (R-28b-1)

- `packages/core/test/tools.test.ts`:
  - `toolArgv` cho từng registry, cho chỗ giữ chỗ thiếu;
  - `toolHash` đổi khi lệnh đổi, không đổi khi `description` đổi.
- `apps/desktop/test/runner.test.ts` (dùng `fakeNpx` có sẵn):
  - danh mục bật codegraph cho dự án: run có server, `mcp__codegraph`, index dựng trong worktree;
  - danh mục tắt: không có, kể cả khi `.mcp.json` có codegraph;
  - `enabled: null` mà `.mcp.json` có codegraph: có (chuyển tiếp);
  - chưa cho phép / đổi phiên bản: bỏ qua, có dòng log;
  - chính sách không cho: không có;
  - thiếu `secretEnv`: bỏ qua, log không có giá trị;
  - Codex nhận đúng `-c`;
  - hub không gửi `tools`: như hôm nay (test cũ vẫn qua).
- Hub test: heartbeat chỉ gửi mục và dự án của máy.

## R-28b-2. Cài đặt máy

- **Mục máy `tool:<id>`** cho mỗi mục không có `handler`, có `check`, và bật cho ít nhất một dự án của máy:
  - `status()` chạy `check` (thoát 0 là đã cài; quá 15 giây là `manual`);
  - `install()` chạy `install` qua `toolArgv`;
  - mục chưa được cho phép thì `manual`, kèm câu nhắc cho phép trước.
  - Mục có `handler` giữ các mục cũ (`cli:specify`, `<dự án>:codegraph-mcp`, `codegraph-index`, `superpowers`, `speckit`). Riêng `install` của Spec Kit dùng `{package}` của danh mục, tức Spec Kit được ghim phiên bản, thay `SPECKIT_SOURCE` không ghim.
- **`setupItemId`** (`methods.ts`) nhận thêm `tool:[a-z0-9][a-z0-9-]{0,39}`, để `admin.commandCreate` và đề xuất `machine.install` của leader (29b) dùng được.
- **Bắt buộc**: `requiredItemIds(policy, projects, tools?)` thêm, cho mỗi dự án:
  - mục `required` không có handler: `tool:<id>`;
  - codegraph: `<dự án>:codegraph-mcp`;
  - superpowers: `<dự án>:superpowers`;
  - speckit: `cli:specify` và `<dự án>:speckit`.

  Nơi gọi `requiredItemIds` / `missingRequired` truyền danh mục vào: `packages/ui/src/App.tsx` (sức khoẻ Web Admin), `pages/Setup.tsx`, `pages/Admin.tsx`, `pages/admin/Ops.tsx`.
- **Trang *Cài đặt máy***: thẻ *Tool từ hub* (cho phép, ở R-28b-1) và các mục `tool:<id>` trong danh sách mục máy. Chuỗi trong `vi.ts` / `en.ts`.

### Test (R-28b-2)

- `apps/desktop/test/setup.test.ts` (fake bin như hiện có): mục `tool:<id>` có / thiếu / cài được / chưa cho phép; Spec Kit cài bằng phiên bản ghim.
- `packages/core/test/`: `requiredItemIds` với danh mục; `setupItemId` nhận `tool:<id>`.
- Smoke desktop chụp *Cài đặt máy* có thẻ *Tool từ hub*.

## Ràng buộc khi làm

- Máy chạy agent (claude-1) không chạy được `npm` hay `node`. Viết code và test cẩn thận; người merge chạy typecheck, test, e2e, build và smoke desktop.
- Không tăng `version`, không đánh dấu [x] trong `docs/roadmap.md`.
- Import khác thư mục dùng alias (`#core/`, `#desktop/`, `#ui/`, `@xdev-hive/core`). Chuỗi giao diện và key lỗi trong `vi.ts` (gốc) và `en.ts`.
- Không ghi giá trị của `secretEnv` vào log, run record hay hub.
- Comment giải thích vì sao.
- Kết thúc: `task_update` sang `review`, ghi chú đã làm / chưa làm / cách kiểm / rủi ro. Ghi riêng các chỗ đánh dấu **[Chưa kiểm]** cần thử với CLI thật.
