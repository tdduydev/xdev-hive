# 20. Spec Kit trong Hive

Spec Kit (github/spec-kit) cho agent viết `spec.md` → `plan.md` → `tasks.md` cho từng tính năng trong `specs/<NNN-tên>/`. Hive cài nó vào repo (20a), cho xem các tính năng (20b), nhập `tasks.md` thành task (20c) và xếp run cho agent làm từng bước (20d).

Phần này viết cho **R-20a** và **R-20b**. 20c–20d thêm vào đây khi tới lượt.

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

## R-20b. Trang *Spec*

Xem các tính năng Spec Kit của một dự án trên web và app: tính năng nào, đang ở bước nào, đọc `spec.md`, `plan.md`, `tasks.md`. Máy đọc repo và đẩy lên hub; hub chỉ giữ bản mới nhất.

### Spec Kit để file ở đâu (đã chạy thử)

- Mỗi tính năng là một thư mục `specs/<NNN-tên>/` (vd. `specs/001-dang-nhap-sso/`), trong đó có `spec.md` (sau /speckit-specify), `plan.md` (sau /speckit-plan, kèm `research.md`, `data-model.md`, `contracts/`, `quickstart.md`), `tasks.md` (sau /speckit-tasks).
- Spec Kit tạo branch git trùng tên thư mục (`001-dang-nhap-sso`) khi bắt đầu một tính năng. Run của Hive làm trên branch `ai/<task>`. Cho nên tính năng đang viết dở nằm trên branch, chưa có ở branch đích.
- `tasks.md`: các dòng việc dạng `- [ ] T001 [P] [US1] Mô tả, đường dẫn file` hoặc `- [x] T001 …`, chia theo `## Phase N: …`.
- Tiêu đề: dòng `# ` đầu tiên của `spec.md`, thường là `# Feature Specification: <tên>`.

### Core (packages/core/src/speckit.ts, chạy được trên trình duyệt)

```ts
export const SPEC_FILES = ["spec", "plan", "tasks"] as const;          // spec.md, plan.md, tasks.md
export const SPEC_STAGES = ["specify", "plan", "tasks", "implement", "done"] as const;
export interface SpecFiles { spec: string | null; plan: string | null; tasks: string | null }
export interface SpecFeature {
  project: string;
  dir: string;          // "001-dang-nhap-sso" (chỉ tên thư mục dưới specs/)
  branch: string;       // "" = branch đích của dự án; còn lại: tên branch (vd. "ai/SPEC-1", "002-xuat-bao-cao")
  title: string;        // từ spec.md, bỏ tiền tố "Feature Specification:"; không có thì dir
  stage: SpecStage;
  tasksDone: number;
  tasksTotal: number;
  commit: string;       // sha ngắn của ref đã đọc
  machine: string;      // máy đã đẩy
  pushedAt: string;
}
export interface SpecFeatureDetail extends SpecFeature { files: SpecFiles }
export function specTitle(spec: string | null, dir: string): string;
export function specTasks(tasks: string | null): { done: number; total: number };   // đếm dòng "- [ ]" / "- [x]" (cả "* [X]")
export function specStage(files: SpecFiles): SpecStage;
```

`specStage`: không có `plan` → `specify`; có `plan`, không có `tasks` → `plan`; có `tasks`, chưa việc nào xong → `tasks`; xong một phần → `implement`; tổng > 0 và xong hết → `done`.

### Hub (packages/core/src/sqlite.ts, migration mới)

Bảng `spec_features(project, dir, branch, title, files TEXT /* JSON SpecFiles */, commit, machine, pushed_at, PRIMARY KEY(project, dir, branch))`.

Method (methods.ts):
- `specs.push { project, features: Array<{ dir, branch, commit, files: SpecFiles }> (tối đa 100) }`, vai trò `agent`, actor phải thấy dự án (như `runs.push`). Mỗi file tối đa 200 000 ký tự. Hub làm sạch như `runs.push` làm với patch (`redactLines(stripHidden(...))`). Upsert từng tính năng (`machine` = `actor.name`), rồi xoá các dòng của dự án đó mà **chính máy này** đã đẩy trước đây và không còn trong lần đẩy này (tính năng bị xoá, branch đã merge). Dòng do máy khác đẩy giữ nguyên. Trả `{ stored: number; removed: number }`. Không ghi nhật ký admin.
- `specs.list { project?, projects? }` (viewer): `SpecFeature[]` của các dự án actor thấy (lọc như `runs.list`), không kèm nội dung file. Sắp: `branch` rỗng trước, rồi `dir`, rồi `branch`.
- `specs.get { project, dir, branch }` (viewer): `SpecFeatureDetail | null` (dự án không thấy thì null, như `runs.get`).

### Máy (apps/desktop/src/main/specs.ts, không import Electron)

- `readSpecs(repo, ref)`: chỉ đọc git, không đọc checkout (giống `mirror.ts`). Liệt kê `git ls-tree --name-only <ref> specs/` lấy thư mục, đọc `specs/<dir>/{spec,plan,tasks}.md` bằng `git show`. Trả `{ dir, branch, commit, files }[]`.
- `collectSpecs(repo, targetBranch)`:
  1. Ref đích: `remoteStart(repo, targetBranch)` như `mirrorDocs` (fetch branch đích của remote); không có remote thì `HEAD`. Các tính năng ở đây có `branch: ""`.
  2. Branch làm dở: `git for-each-ref --format=%(refname:short) refs/heads` lọc tên khớp `^ai/` hoặc `^\d{3}-`. Với mỗi branch, đọc như trên, chỉ giữ tính năng **khác** bản ở ref đích (thư mục chưa có ở đích, hoặc một trong ba file khác). Bỏ branch có commit cũ hơn 30 ngày (`git log -1 --format=%ct`).
  3. Tối đa 100 tính năng (đích trước), file dài quá 200 000 ký tự thì cắt và thêm dòng `…(cắt bớt)`.
- `pushSpecs(backend, actor, project, last?)`: gọi `collectSpecs`, tính hash JSON của kết quả; trùng `last` thì không gửi. Trả hash mới. Repo không phải git thì không làm gì.
- index.ts: trong `mirrorAll()` (10 phút một lần, lần đầu 90 giây sau khi mở) gọi `pushSpecs` cho **mọi** dự án (không chỉ dự án có mirror), giữ hash trong một `Map` như `mirrored`. Lỗi của một dự án chỉ ghi console, không chặn dự án khác. Không chạy khi `smokeShot`.

### Giao diện (packages/ui)

- Trang mới `specs` (nhãn *Spec*, nhóm *Kiến thức* ngay sau *Tài liệu*, icon `ListChecks`), có ở web và app. Theo phạm vi dự án/hệ thống của thanh bên như trang *Tài liệu*; phạm vi *Tất cả* thì gộp mọi dự án, có cột dự án.
- Danh sách: mỗi tính năng một dòng: `dir`, tiêu đề, chip bước (*Viết spec* / *Lập kế hoạch* / *Chia việc* / *Đang làm* / *Xong*), tiến độ `tasksDone/tasksTotal` (thanh nhỏ) khi có tasks, branch (rỗng thì *branch đích*), máy · thời gian đẩy · commit. Rỗng: hướng dẫn ngắn (cài Spec Kit ở *Công cụ và dự án*, máy đẩy 10 phút một lần).
- Bấm một dòng: khung đọc với tab *Spec* / *Plan* / *Tasks* (tab thiếu file thì mờ), nội dung render bằng component Markdown sẵn có của trang tài liệu (`packages/ui/src/components/DocMarkdown.tsx`). Liên kết trực tiếp `#/specs?project=<p>&dir=<d>&branch=<b>`.
- i18n vi (gốc) và en: tên trang, phụ đề, các bước, trạng thái rỗng.

### Test

- `packages/core/test/speckit.test.ts`: `specTitle`, `specTasks` (`[x]`, `[X]`, `*`), `specStage` cả năm bước; `specs.push` thay thế đúng (dòng của máy khác giữ, dòng cũ của chính máy bị xoá), làm sạch ký tự ẩn, quá 100 tính năng bị từ chối; `specs.list` / `specs.get` lọc dự án actor không thấy.
- `apps/desktop/test/specs.test.ts`: repo git tạm (như `mirror.test.ts`): `main` có `specs/001-a/spec.md`; branch `002-b` thêm `specs/002-b/spec.md`, `plan.md`; branch `ai/T-1` sửa `specs/001-a/spec.md`; branch `feature-x` có `specs/003-c/` (không khớp tên, bỏ qua). `collectSpecs` trả đúng 3 tính năng với `branch` đúng; chạy lại không đổi thì `pushSpecs` không gửi.
- e2e web (`apps/web/e2e/browser.mjs`): một bước `spec-page`: seed bằng `specs.push` (token của một người thấy `payment`), mở `#/specs`, thấy tính năng, bấm vào, tab *Tasks* hiện việc.

### README

Một đoạn trong mục Spec Kit: trang *Spec*, máy đẩy gì, khi nào, branch nào được xem là làm dở.

## R-20c. Nhập `tasks.md` thành task

Từ trang *Spec*, một tính năng có `tasks.md` nhập được thành task của bảng, giữ thứ tự Spec Kit đặt ra, để xếp run cho agent.

### Đọc `tasks.md` (core `parseSpecTasks`)

- Pha: dòng `## Phase N: <tên>`. Loại pha theo tên: *Setup*, *Foundational*, *User Story* (có `User Story`), *Polish* (có `Polish`), còn lại là *khác*.
- Việc: dòng `- [ ] T001 [P] [US1] Mô tả` (hoặc `* `, `[x]`, `[X]`). `[P]`: chạy song song được. `[USn]`: thuộc user story nào. Câu `depends on T012, T013` trong mô tả là phụ thuộc nêu rõ.
- Bỏ phần trong khối code và chú thích HTML (template có ví dụ trong đó).

### Phụ thuộc (theo phần *Dependencies & Execution Order* của template)

- Trong một pha, chia thành *bước*: mỗi việc không `[P]` là một bước; một dãy việc `[P]` liền nhau là một bước. Mỗi bước chờ mọi việc của bước trước nó trong pha.
- Bước đầu của pha chờ *cổng* của pha: *Setup* không chờ gì; *Foundational* chờ bước cuối của *Setup*; mỗi *User Story* chờ bước cuối của *Foundational* (không có thì của *Setup*), các story không chờ nhau; *Polish* chờ bước cuối của mọi story (không có story thì của pha trước); pha *khác* chờ bước cuối của pha trước.
- Cộng thêm `depends on …` nêu rõ. Tối đa 20 phụ thuộc mỗi task (giới hạn của hub): quá thì giữ 20 đầu và báo trong bản xem trước.
- Việc đã `[x]` không nhập; phụ thuộc vào chúng được bỏ (đã xong).

### Hub

`specs.importTasks { project, dir, branch, prefix, dryRun }` (quyền *Tạo/sửa task* của dự án) đọc `tasks.md` hub đang giữ (từ `specs.push`):
- Mã task: `<prefix>-<T001>`; `prefix` mặc định `S` + số của thư mục (`001-dang-nhap` → `S001`).
- Tiêu đề: `T001 [US1] Mô tả` (bỏ `[P]`), tối đa 300 ký tự. Ghi chú task: `Spec Kit · specs/<dir>/tasks.md · <tên pha>`.
- Task đã có (cùng mã) thì bỏ qua, phụ thuộc vào nó vẫn giữ.
- `dryRun`: trả kế hoạch, không ghi. Trả `{ tasks: [{ id, code, title, phase, dependsOn, exists }], warnings: string[] }`; ghi thật thì thêm `created`.
- Một giao dịch: lỗi ở task nào thì không task nào được tạo.

### Giao diện

Tab *Tasks* của một tính năng có nút *Nhập thành task* (người có quyền *Tạo/sửa task*): ô tiền tố, bảng xem trước (mã, tiêu đề, pha, chờ gì, *đã có*), cảnh báo, rồi *Nhập N task*.

## R-20d. Run cho specify / plan / tasks

Agent làm từng bước Spec Kit như một run thường của Hive, trên branch `ai/<task>`; người quản trị duyệt kết quả như mọi run (review, MR, *Merge* ở 18c).

- Mỗi tính năng làm bằng **một task** xuyên suốt: run *specify*, rồi *plan*, rồi *tasks* là các run của cùng task, nên cùng branch `ai/<task>` (branch đã có thì giữ nguyên lịch sử) và thấy file của bước trước.
- *Tính năng mới* (nút trên trang *Spec*): nhập mô tả → hub tạo task `SPEC-<n>` (n kế tiếp trong dự án) tiêu đề `Spec: <mô tả ngắn>` và xếp run *specify* trên máy chọn.
- Tính năng ở branch `ai/<task>` mà task đó có: nút bước kế tiếp (*Lập kế hoạch* khi ở bước specify, *Chia việc* khi ở plan) xếp run của chính task đó. Tính năng ở branch đích: tạo task `<prefix>-PLAN` / `<prefix>-TASKS` rồi xếp run (branch mới từ branch đích, thấy file). Branch khác (`NNN-*` người tạo tay): không có nút, nhắc merge vào branch đích trước.
- Chỉ dẫn cho agent (core `specStepInstructions(step, { dir, input })`): đọc `.claude/skills/speckit-<step>/SKILL.md` (Codex: `.agents/skills/speckit-<step>/SKILL.md`) và làm theo với đầu vào; đặt `SPECIFY_FEATURE_DIRECTORY=specs/<dir>` cho script của Spec Kit (bước plan, tasks); chỉ sửa file spec, không viết code; commit trên branch của task; không chạy bước khác.
- Máy: chọn như *Xếp run* của trang *Task* (máy online, nhận run từ hub, có repo). Leader chat đề xuất được các run này bằng `propose_run` với chỉ dẫn trên (skill `hive-leader` có ghi).
