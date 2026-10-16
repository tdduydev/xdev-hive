package runner

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/procattr"
)

// Biến môi trường cấu hình công cụ tiết kiệm token của máy: trống là tự tìm trên PATH, "off" tắt, một đường dẫn tới
// file chạy, hoặc JSON {"path": "...", "sha256": "..."} để chỉ dùng đúng bản đã tin (như toolTrust của app v1).
const (
	RTKEnv       = "HIVE_WORKER_RTK"
	CodeGraphEnv = "HIVE_WORKER_CODEGRAPH"
)

// ToolConfig là cấu hình của máy cho một công cụ (RTK, CodeGraph). Off thắng cài đặt của dự án.
type ToolConfig struct {
	Off    bool   `json:"-"`
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

// ToolConfigFromEnv đọc một trong RTKEnv, CodeGraphEnv.
func ToolConfigFromEnv(name string) (ToolConfig, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	switch strings.ToLower(raw) {
	case "":
		return ToolConfig{}, nil
	case "off", "0", "false":
		return ToolConfig{Off: true}, nil
	}
	if !strings.HasPrefix(raw, "{") {
		return ToolConfig{Path: raw}, nil
	}
	var cfg ToolConfig
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		return ToolConfig{}, fmt.Errorf("%s phải là \"off\", một đường dẫn hoặc JSON {\"path\", \"sha256\"}: %w", name, err)
	}
	return cfg, nil
}

// resolveTool trả đường dẫn tuyệt đối của công cụ; rỗng khi máy tắt hoặc không có. Lỗi là có công cụ nhưng không dùng
// được (sai sha256): người gọi báo vào log của run rồi chạy như không có.
func resolveTool(cfg ToolConfig, binary string) (string, error) {
	if cfg.Off {
		return "", nil
	}
	path := cfg.Path
	if path == "" {
		found, err := exec.LookPath(binary)
		if err != nil {
			return "", nil
		}
		path = found
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if info, err := os.Stat(abs); err != nil || info.IsDir() {
		return "", fmt.Errorf("không có file chạy %s", abs)
	}
	if want := strings.ToLower(strings.TrimSpace(cfg.SHA256)); want != "" {
		got, err := fileSHA256(abs)
		if err != nil {
			return "", err
		}
		if got != want {
			return "", fmt.Errorf("sha256 của %s là %s, khác bản máy đã tin %s", abs, got, want)
		}
	}
	return abs, nil
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func toolConfig(set *ToolConfig, env string) (ToolConfig, error) {
	if set != nil {
		return *set, nil
	}
	return ToolConfigFromEnv(env)
}

// tokenTool: công tắc rtk, codegraph của dự án chỉ có tác dụng khi cả mục "Tiết kiệm token" bật. Hub cũ (nil) hay
// spec thiếu trường là bật, như các mục khác của tokenSaving.
func tokenTool(ts *TokenSavingJob, pick func(TokenSavingJob) *bool) bool {
	if ts == nil {
		return true
	}
	if !ts.Enabled {
		return false
	}
	on := pick(*ts)
	return on == nil || *on
}

// MachineCapabilities là Capabilities cộng việc và công cụ máy có ("sdlc-multirepo", "codegraph", "rtk"), để hub chỉ nhắc agent dùng
// codegraph_explore khi máy gắn được nó. Runner host (sandbox) không khai: CLI chạy trong container không có chúng.
func MachineCapabilities(sandbox bool) []string {
	out := append([]string(nil), Capabilities...)
	if sandbox {
		return out
	}
	// Runner host không giữ thông tin đăng nhập Git của đội nên không hứa clone được repo tham gia.
	out = append(out, CapSdlcMultiRepo)
	if cfg, err := ToolConfigFromEnv(CodeGraphEnv); err == nil {
		if path, err := resolveTool(cfg, "codegraph"); err == nil && path != "" {
			out = append(out, "codegraph")
		}
	}
	if cfg, err := ToolConfigFromEnv(RTKEnv); err == nil && runtime.GOOS != "windows" {
		if path, err := resolveTool(cfg, "rtk"); err == nil && path != "" && probeRTKHook(context.Background(), path) == nil {
			out = append(out, "rtk")
		}
	}
	return out
}

// --- RTK -----------------------------------------------------------------------------------------------------------

// rtkTimeout chặn lệnh rtk của worker (thử hook, đọc số tiết kiệm): rtk treo không được làm treo run.
const rtkTimeout = 10 * time.Second

// rtkRun là RTK đã bật cho một run Claude Code.
type rtkRun struct {
	// path là file rtk đã kiểm; hook là lệnh PreToolUse ghi vào --settings của run.
	path string
	hook string
	// db là file thống kê riêng của run (RTK_DB_PATH): số tiết kiệm đọc ra chỉ của run này.
	db string
	// dir chứa db và bin/: bin/ chỉ có lối tắt `rtk` tới bản đã kiểm, đặt đầu PATH vì hook viết lại lệnh thành `rtk …`.
	dir string
	env map[string]string
}

// RTKUsage là số RTK đếm được trong một lần thử, đi kèm sự kiện cost.
type RTKUsage struct {
	Commands    int64 `json:"commands"`
	SavedTokens int64 `json:"savedTokens"`
}

// rtkProbeInput là lệnh PreToolUse mẫu mà hook RTK phải viết lại; hook hỏng (thoát lỗi, in rác) sẽ chặn hoặc làm
// sai mọi lệnh Bash của agent nên phải bỏ trước khi gắn.
const rtkProbeInput = `{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git status"}}`

func probeRTKHook(ctx context.Context, path string) error {
	ctx, cancel := context.WithTimeout(ctx, rtkTimeout)
	defer cancel()
	cmd := procattr.CommandContext(ctx, path, "hook", "claude")
	cmd.Stdin = strings.NewReader(rtkProbeInput)
	cmd.Env = mergeEnv(os.Environ(), rtkBaseEnv)
	out, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("hook RTK lỗi: %w", err)
	}
	var reply struct {
		HookSpecificOutput struct {
			UpdatedInput struct {
				Command string `json:"command"`
			} `json:"updatedInput"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(out), &reply); err != nil {
		return fmt.Errorf("hook RTK trả dữ liệu lạ: %w", err)
	}
	if got := reply.HookSpecificOutput.UpdatedInput.Command; !strings.HasPrefix(got, "rtk ") || !strings.Contains(got, "git status") {
		return fmt.Errorf("hook RTK viết lại `git status` thành %q", got)
	}
	return nil
}

// rtkBaseEnv: tắt telemetry dù bản build có endpoint hay không, và tắt câu nhắc "No hook installed" mà rtk in vào
// output của mọi lệnh khi không thấy hook trong ~/.claude (hook của run nằm ở --settings nên rtk không thấy).
var rtkBaseEnv = map[string]string{
	"RTK_TELEMETRY_DISABLED":    "1",
	"RTK_SUPPRESS_HOOK_WARNING": "1",
}

// prepareRTK bật RTK cho run Claude Code ghi được (run chỉ đọc chạy ở chế độ plan, không chạy lệnh) trên máy có rtk,
// khi máy và dự án không tắt. nil là chạy như cũ; lý do không bật được ghi vào log của run.
func (r Runner) prepareRTK(ctx context.Context, job Job, log io.Writer) *rtkRun {
	// Windows: chưa kiểm Claude Code chạy lệnh hook qua shell nào, nên chưa bọc được đường dẫn rtk cho đúng.
	if job.CLI != "claude" || r.Sandbox != nil || readOnlyKind(job.Kind) || r.overridden(job.CLI) || runtime.GOOS == "windows" {
		return nil
	}
	if !tokenTool(job.TokenSaving, func(t TokenSavingJob) *bool { return t.RTK }) {
		return nil
	}
	cfg, err := toolConfig(r.RTK, RTKEnv)
	if err == nil && cfg.Off {
		return nil
	}
	path := ""
	if err == nil {
		path, err = resolveTool(cfg, "rtk")
	}
	if err == nil && path != "" {
		err = probeRTKHook(ctx, path)
	}
	if err != nil {
		_, _ = fmt.Fprintf(log, "[xdev-hive] Không dùng RTK cho run này: %v\n", err)
		return nil
	}
	if path == "" {
		return nil
	}
	dir := filepath.Join(r.DataDir, "rtk", job.RunID+"-"+fmt.Sprint(job.Attempt))
	bin := filepath.Join(dir, "bin")
	if err := os.MkdirAll(bin, 0o700); err != nil {
		_, _ = fmt.Fprintf(log, "[xdev-hive] Không dùng RTK cho run này: %v\n", err)
		return nil
	}
	link := filepath.Join(bin, filepath.Base(path))
	_ = os.Remove(link)
	if err := os.Symlink(path, link); err != nil {
		_ = os.RemoveAll(dir)
		_, _ = fmt.Fprintf(log, "[xdev-hive] Không dùng RTK cho run này: %v\n", err)
		return nil
	}
	pathEnv := os.Getenv("PATH")
	if p, ok := job.Env["PATH"]; ok {
		pathEnv = p
	}
	run := &rtkRun{path: path, hook: shellQuote(path) + " hook claude", db: filepath.Join(dir, "history.db"), dir: dir}
	run.env = mergeMap(rtkBaseEnv, map[string]string{
		"RTK_DB_PATH": run.db,
		"PATH":        bin + string(os.PathListSeparator) + pathEnv,
	})
	_, _ = fmt.Fprintf(log, "[xdev-hive] RTK nén output lệnh Bash của run (%s).\n", path)
	return run
}

// usage đọc số RTK đã đếm trong file thống kê riêng của run. Lỗi thì không báo số nào: số sai còn tệ hơn không có.
func (rr *rtkRun) usage(ctx context.Context) (*RTKUsage, error) {
	if _, err := os.Stat(rr.db); err != nil {
		// Agent chưa chạy lệnh nào qua rtk nên rtk chưa tạo file.
		return &RTKUsage{}, nil
	}
	ctx, cancel := context.WithTimeout(ctx, rtkTimeout)
	defer cancel()
	cmd := procattr.CommandContext(ctx, rr.path, "gain", "--format", "json")
	cmd.Env = mergeEnv(os.Environ(), rr.env)
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	var gain struct {
		Summary *struct {
			TotalCommands int64 `json:"total_commands"`
			TotalSaved    int64 `json:"total_saved"`
		} `json:"summary"`
	}
	if err := json.Unmarshal(out, &gain); err != nil {
		return nil, err
	}
	if gain.Summary == nil || gain.Summary.TotalCommands < 0 || gain.Summary.TotalSaved < 0 {
		return nil, errors.New("rtk gain thiếu summary")
	}
	return &RTKUsage{Commands: gain.Summary.TotalCommands, SavedTokens: gain.Summary.TotalSaved}, nil
}

func (rr *rtkRun) cleanup() { _ = os.RemoveAll(rr.dir) }

// shellQuote: Claude Code chạy lệnh hook qua shell, đường dẫn có dấu cách hay ký tự lạ phải được bọc.
func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// --- CodeGraph -----------------------------------------------------------------------------------------------------

// codegraphDir là thư mục chỉ mục CodeGraph đặt trong gốc repo (CODEGRAPH_DIR chỉ đổi được tên, không trỏ ra ngoài).
const codegraphDir = ".codegraph"

// codegraphFiles là file của chỉ mục được chép giữa bản bền và worktree; pid, socket, shm do tiến trình tạo lại.
var codegraphFiles = []string{"codegraph.db", "codegraph.db-wal", ".gitignore"}

// codegraphTimeout chặn bước dựng hoặc cập nhật chỉ mục trước run. Dựng lần đầu repo xdev-hive (~750 file) mất ~11 giây,
// cập nhật sau khi chép chỉ mục ~0,5 giây trên Mac mini dev.
var codegraphTimeout = 3 * time.Minute

// codegraphEnv tắt telemetry ẩn danh (mặc định bật) và daemon nền của CodeGraph: worker không để tiến trình nào sống
// quá run.
var codegraphEnv = map[string]string{
	"CODEGRAPH_TELEMETRY": "0",
	"DO_NOT_TRACK":        "1",
	"CODEGRAPH_NO_DAEMON": "1",
}

// codegraphCLIs là CLI worker gắn được MCP server riêng của run.
var codegraphCLIs = map[string]bool{"claude": true, "codex": true, "gemini": true, "antigravity": true}

// prepareCodeGraph đưa chỉ mục CodeGraph của repo vào worktree của run rồi cập nhật phần đổi, để agent hỏi đồ thị code
// qua MCP thay vì grep và đọc cả file. Chỉ mục bền của mỗi repo nằm trong DataDir: mỗi run dùng một bản chép riêng
// (hai run song song ở hai commit khác nhau không được ghi chung một file SQLite), và bản sau khi cập nhật thay bản bền
// để run sau chỉ phải cập nhật ít. Lỗi không chặn run: trả "" và ghi lý do vào log.
func (r Runner) prepareCodeGraph(ctx context.Context, job Job, work string, log io.Writer) string {
	if !codegraphCLIs[job.CLI] || r.Sandbox != nil || r.overridden(job.CLI) {
		return ""
	}
	if !tokenTool(job.TokenSaving, func(t TokenSavingJob) *bool { return t.CodeGraph }) {
		return ""
	}
	cfg, err := toolConfig(r.CodeGraph, CodeGraphEnv)
	path := ""
	if err == nil {
		path, err = resolveTool(cfg, "codegraph")
	}
	if err == nil && path == "" {
		return ""
	}
	start := time.Now()
	op := ""
	if err == nil {
		op, err = r.syncCodeGraph(ctx, job, path, work)
	}
	if err != nil {
		_ = os.RemoveAll(filepath.Join(work, codegraphDir))
		_, _ = fmt.Fprintf(log, "[xdev-hive] Chạy run không có CodeGraph: %v\n", err)
		return ""
	}
	_, _ = fmt.Fprintf(log, "[xdev-hive] CodeGraph %s chỉ mục code trong %.1f giây; agent dùng qua MCP codegraph.\n", op, time.Since(start).Seconds())
	return path
}

// syncCodeGraph trả "dựng" hoặc "cập nhật" để báo vào log.
func (r Runner) syncCodeGraph(ctx context.Context, job Job, path, work string) (string, error) {
	// Loại khỏi git trước khi tạo: .codegraph/.gitignore của CodeGraph tự giữ lại chính nó nên `git add -A` sẽ commit.
	if err := appendExclude(work, codegraphDir+"/"); err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(job.RepoURL))
	root := filepath.Join(r.DataDir, "codegraph")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", err
	}
	stored := filepath.Join(root, hex.EncodeToString(sum[:8]))
	// Khoá theo repo: hai run cùng repo không cùng thay bản bền.
	unlock, err := lockRepo(ctx, stored)
	if err != nil {
		return "", err
	}
	defer unlock()
	local := filepath.Join(work, codegraphDir)
	op, args := "dựng", []string{"init", "--yes", work}
	if _, err := os.Stat(filepath.Join(stored, "codegraph.db")); err == nil {
		if err := copyFiles(stored, local, codegraphFiles); err != nil {
			return "", err
		}
		op, args = "cập nhật", []string{"sync", "--quiet", work}
	}
	cctx, cancel := context.WithTimeout(ctx, codegraphTimeout)
	defer cancel()
	cmd := procattr.CommandContext(cctx, path, args...)
	cmd.Dir = work
	cmd.Env = mergeEnv(os.Environ(), codegraphEnv)
	out, err := cmd.CombinedOutput()
	if cctx.Err() == context.DeadlineExceeded {
		return "", fmt.Errorf("codegraph %s chạy quá %s", args[0], codegraphTimeout)
	}
	if err != nil {
		return "", fmt.Errorf("codegraph %s lỗi: %w: %s", args[0], err, tail(out, 400))
	}
	if _, err := os.Stat(filepath.Join(local, "codegraph.db")); err != nil {
		return "", fmt.Errorf("codegraph %s không tạo chỉ mục", args[0])
	}
	// Không thay được bản bền thì run này vẫn dùng chỉ mục vừa cập nhật; run sau cập nhật từ bản cũ hơn.
	_ = replaceDir(local, stored, codegraphFiles)
	return op, nil
}

// copyFiles chép các file có mặt trong names từ src sang dst (tạo dst).
func copyFiles(src, dst string, names []string) error {
	if err := os.MkdirAll(dst, 0o700); err != nil {
		return err
	}
	for _, name := range names {
		if err := copyFile(filepath.Join(src, name), filepath.Join(dst, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

// replaceDir thay dst bằng bản chép của src: chép sang thư mục tạm cạnh dst rồi đổi tên, để worker chết giữa chừng
// không để lại chỉ mục chép dở mà run sau tưởng là đủ.
func replaceDir(src, dst string, names []string) error {
	tmp := dst + ".tmp"
	_ = os.RemoveAll(tmp)
	if err := copyFiles(src, tmp, names); err != nil {
		_ = os.RemoveAll(tmp)
		return err
	}
	old := dst + ".old"
	_ = os.RemoveAll(old)
	if err := os.Rename(dst, old); err != nil && !errors.Is(err, os.ErrNotExist) {
		_ = os.RemoveAll(tmp)
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		return err
	}
	return os.RemoveAll(old)
}

func tail(b []byte, n int) string {
	s := strings.TrimSpace(string(b))
	if len(s) > n {
		s = "…" + s[len(s)-n:]
	}
	return s
}

// codegraphServer là MCP server CodeGraph của run: đọc chỉ mục trong worktree, không telemetry, không daemon. Biến bí
// mật của hub và CLI bị đè rỗng như server ngoài (hubSecretEnv).
func codegraphServer(j Job) (command string, args []string, env map[string]string) {
	return j.codegraph, []string{"serve", "--mcp", "--path", j.workspace}, mergeMap(hubSecretEnv(j), codegraphEnv)
}
