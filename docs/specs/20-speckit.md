# 20. Spec Kit trong Hive

Spec Kit (github/spec-kit) cho agent viết `spec.md` → `plan.md` → `tasks.md` cho từng tính năng trong `specs/<NNN-tên>/`. Hive cài nó vào repo (20a), cho xem các tính năng (20b), nhập `tasks.md` thành task (20c) và xếp run cho agent làm từng bước (20d).

Phần này viết cho **R-20a**. 20b–20d có spec riêng khi tới lượt.

## Sự thật về CLI (đã chạy thử 2/10, specify-cli 1.0.14.dev0, macOS)

- Cài CLI: `uv tool install specify-cli --from git+https://github.com/github/spec-kit.git`. Cần `uv`. CLI nằm ở thư mục mà `uv tool dir --bin` in ra (macOS: `~/.local/bin`), thư mục này **có thể không** có trong PATH của login shell.
- `specify --version` in `specify 1.0.14.dev0`.
- Khởi tạo trong một repo có sẵn, không hỏi gì:
  `specify init --here --force --non-interactive --integration claude --script sh --ignore-agent-tools`
  - Tạo `.specify/` (memory/constitution.md, scripts/bash, templates, workflows, `integration.json`, `init-options.json`, `.gitignore`) và `.claude/skills/speckit-*/SKILL.md` (speckit-constitution, -specify, -clarify, -plan, -tasks, -analyze, -checklist, -implement, -converge, -taskstoissues).
  - Windows: `--script ps` (scripts/powershell). 
  - Không có cờ `--non-interactive` thì CLI hỏi chọn agent và treo khi không có TTY.
- Thêm lệnh cho Codex vào repo đã khởi tạo: `specify integration install codex --script sh` → `.agents/skills/speckit-*/SKILL.md`. Không đụng `.claude/`.
- Trạng thái: `.specify/integration.json`:
  ```json
  { "version": "1.0.14.dev0", "installed_integrations": ["claude", "codex"], "integration_settings": { "claude": { "script": "sh" } }, "default_integration": "claude" }
  ```
  Đọc file này, không cần chạy CLI để kiểm.
- **Không** chạy lại `specify init` trên repo đã có `.specify/` (`--force` ghi đè, có thể mất constitution đã sửa). Repo đã có `.specify/` mà thiếu một integration thì chỉ `specify integration install <tên>`.

## R-20a. Cài Spec Kit (trang *Cài đặt máy*)

Theo đúng cách superpowers và codegraph đang làm trong `apps/desktop/src/main/setup.ts`. Không có import Electron trong file đó; test dùng CLI giả như `apps/desktop/test/setup.test.ts`.

### Mục của máy: `cli:specify`

- Tìm `specify`: `resolveBin("specify", pathEnv)`, không có thì thử `<uv tool dir --bin>/specify` (chạy `uv tool dir --bin` qua `this.#run`, chỉ khi có `uv`).
- **installed**: chi tiết `<dòng đầu của specify --version> · <đường dẫn>`. Nằm ngoài PATH thì vẫn *installed* (app gọi bằng đường dẫn đầy đủ), chi tiết thêm "ngoài PATH".
- **missing** khi có `uv`: action *Cài bằng uv*; `install("cli:specify")` chạy `uv tool install specify-cli --from git+https://github.com/github/spec-kit.git` (timeout 15 phút, lỗi thì `errors.commandFailed` như npm).
- **manual** khi không có `uv`: chi tiết "Cần uv: https://docs.astral.sh/uv/getting-started/installation/", action null.
- Đứng sau các CLI agent, trước `shim`, trong `status().machine`. Không đưa vào `AGENT_CLIS` (không phải loại agent, không cài bằng npm).

### Mục của repo: `<project>:speckit`

Đọc `.specify/integration.json` (lỗi đọc hay JSON hỏng: coi như chưa có integration nào). Integration cần có: `claude` và `codex`.

- **installed**: có `.specify/` và đủ hai integration. Chi tiết: `Spec Kit <version> · claude, codex`.
- **missing**, chưa có `.specify/`: action *Cài Spec Kit*. Cài: `specify init --here --force --non-interactive --integration claude --script <sh|ps> --ignore-agent-tools` rồi `specify integration install codex --script <sh|ps>`, cả hai với `cwd` là repo. `ps` khi `process.platform === "win32"`.
- **missing**, có `.specify/` nhưng thiếu integration: action *Thêm lệnh cho <tên>*; cài chỉ chạy `specify integration install <tên> --script <s>` cho từng cái thiếu.
- Chưa tìm được `specify` thì action null, chi tiết nói cài `cli:specify` trước.
- Output trả về khi cài xong nhắc commit `.specify/`, `.claude/skills/speckit-*`, `.agents/skills/speckit-*`: worktree của run lấy từ branch, file chưa commit thì agent không thấy.
- Lỗi lệnh: `errors.commandFailed` kèm tail output, như codegraph.

`#projectItems` đang đồng bộ: tìm `specify` một lần trong `status()` / `item()` / `install()` (async) rồi truyền vào.

### Core và hub

- `POLICY_REPO_PARTS` (packages/core/src/types.ts) thêm `"speckit"`: chính sách nhóm bắt buộc được Spec Kit theo dự án (trang *Chính sách* tự có cột mới, `requiredItemIds` tự ra `<project>:speckit`).
- `setupItemId` (packages/core/src/methods.ts) thêm `speckit` vào nhóm part, để admin *Yêu cầu cài* từ xa được (hub chỉ nhận mục máy báo có `action`).
- `cli:specify` đã khớp `cli:[a-z]+`. `POLICY_CLIS` không đổi.

### Giao diện và chữ

- `packages/ui/src/pages/Setup.tsx` `iconOf`: `:speckit` → icon `ListChecks` (lucide-react).
- vi.ts (gốc) và en.ts: `setupPart.speckit` ("Spec Kit"), các khoá `setupItem.speckit*` / `setupItem.specify*` cho chi tiết và action ở trên. Không viết chữ tiếng Việt cứng trong setup.ts ngoài message của HiveError (theo cách file đang làm).

### Test (`apps/desktop/test/setup.test.ts`)

CLI giả (`fakeBin`) cho `uv` và `specify`, ghi tham số vào `calls.log`:
1. Không có `uv`, không có `specify`: `cli:specify` *manual*, action null.
2. Có `uv`: *missing*, `install("cli:specify")` gọi đúng `uv tool install specify-cli --from git+https://github.com/github/spec-kit.git`; `uv` giả tạo `specify` giả trong thư mục mà `uv tool dir --bin` in ra (thư mục ngoài PATH) → sau cài là *installed*.
3. Repo chưa có `.specify/`: *missing*; cài chạy `specify init --here --force --non-interactive --integration claude --script sh --ignore-agent-tools` rồi `specify integration install codex --script sh`, đúng thứ tự, `cwd` là repo; `specify` giả ghi `.specify/integration.json` → *installed*.
4. Repo có `integration.json` chỉ `["claude"]`: cài chỉ chạy `integration install codex`, không chạy `init`.
5. `integration.json` hỏng: *missing*, không ném lỗi.
6. `requiredItemIds` có `<project>:speckit` khi chính sách bắt buộc (packages/core/test hoặc test hiện có của policy).

### README

Mục *Nối một repo với Hive* (hoặc chỗ đang nói về superpowers / codegraph): một đoạn ngắn: Spec Kit là gì, app cài CLI bằng uv, cài vào repo cho Claude và Codex, nhớ commit các file nó tạo, chính sách nhóm có thể bắt buộc.

### Không làm trong 20a

Trang *Spec* (20b), nhập task (20c), run cho specify/plan/tasks (20d). Không tăng version, không đánh dấu roadmap (người merge làm).
