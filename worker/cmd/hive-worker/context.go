package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/tdduydev/xdev-hive/worker/internal/ctxsync"
	"github.com/tdduydev/xdev-hive/worker/internal/memstore"
	"github.com/tdduydev/xdev-hive/worker/internal/optimizeall"
	"github.com/tdduydev/xdev-hive/worker/internal/runner"
)

const contextUsage = "Cách dùng: hive-worker context <status [--project KHOÁ] | enable --folder THƯ_MỤC [--project-id ID] | disable --project KHOÁ | save-source --project KHOÁ --content-file FILE | sync --project KHOÁ [--hub-file FILE] [--policy-file FILE] | resolve --project KHOÁ --target ID --keep file|source | migrate --project KHOÁ [--apply]> [--json]"

// Mã lỗi trong {"error":{"code","message"}}; app desktop chỉ rẽ nhánh theo mã, còn chữ hiển thị lấy từ message.
const (
	contextInvalidInput = "invalid_input"
	contextNotFound     = "not_found"
	contextFailed       = "failed"
)

// Test thay thư mục nhà và việc dò CLI trên PATH.
var (
	contextHome   = os.UserHomeDir
	contextHasCLI = func(id ctxsync.TargetID) bool {
		_, err := exec.LookPath(runner.Binary(string(id)))
		return err == nil
	}
)

type contextFailure struct {
	exit    int
	code    string
	message string
}

func (f contextFailure) Error() string { return f.message }

func contextInvalid(format string, a ...any) error {
	return contextFailure{exit: 2, code: contextInvalidInput, message: fmt.Sprintf(format, a...)}
}

// contextFailureOf đổi lỗi của ctxsync sang mã lỗi cho app. Lỗi đầu vào mà gói không đánh dấu (thư mục không có, file
// nhập hỏng) đã được lệnh này chặn trước, nên phần còn lại là lỗi hệ thống.
func contextFailureOf(err error) contextFailure {
	var f contextFailure
	switch {
	case errors.As(err, &f):
		return f
	case errors.Is(err, ctxsync.ErrNotFound), ctxsync.IsNoShared(err):
		return contextFailure{exit: 1, code: contextNotFound, message: err.Error()}
	}
	return contextFailure{exit: 1, code: contextFailed, message: err.Error()}
}

// contextEnabled là kết quả của `context enable`: ContextProject, kèm bản nháp chuyển từ chia sẻ memory kiểu cũ khi có.
type contextEnabled struct {
	ctxsync.Project
	Migration *ctxsync.Migration `json:"migration,omitempty"`
}

// contextCommand: nguồn ngữ cảnh dùng chung của dự án và việc ghi nó vào file cục bộ của từng CLI (spec 029). Mọi lần
// ghi vào repo đều qua memstore nên khôi phục được.
func contextCommand(args []string, stdout, stderr io.Writer) int {
	action := ""
	if len(args) > 0 && args[0] != "" && args[0][0] != '-' {
		action, args = args[0], args[1:]
	}
	fs := flag.NewFlagSet("context "+action, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	asJSON := fs.Bool("json", false, "in dạng JSON (cho app desktop)")
	project := fs.String("project", "", "khoá dự án (p_<id> hoặc f_<khoá thư mục>)")
	folder := fs.String("folder", "", "enable: thư mục dự án trên máy")
	projectID := fs.String("project-id", "", "enable: id dự án trên hub")
	contentFile := fs.String("content-file", "", "save-source: file Markdown của nguồn")
	hubFile := fs.String("hub-file", "", "sync: HubSnapshot (memory đã duyệt lấy từ hub)")
	policyFile := fs.String("policy-file", "", "sync: chính sách dự án")
	target := fs.String("target", "", "resolve: file đích (claude, codex, gemini, antigravity)")
	keep := fs.String("keep", "", "resolve: giữ bản file hay bản nguồn")
	apply := fs.Bool("apply", false, "migrate: lưu bản nháp làm nguồn rồi tắt chia sẻ kiểu cũ")
	parseErr := fs.Parse(args)

	// Tham số hỏng vẫn phải báo bằng JSON khi app đã xin --json, nên dò cờ từ args thay vì từ kết quả parse.
	wantJSON := *asJSON
	for _, a := range args {
		if a == "--json" || a == "-json" {
			wantJSON = true
		}
	}
	fail := func(err error) int {
		f := contextFailureOf(err)
		if wantJSON {
			_ = json.NewEncoder(stdout).Encode(map[string]any{"error": map[string]string{"code": f.code, "message": f.message}})
		} else {
			fmt.Fprintln(stderr, f.message)
		}
		return f.exit
	}
	emit := func(v any, text string) int {
		if *asJSON {
			if err := json.NewEncoder(stdout).Encode(v); err != nil {
				return fail(err)
			}
		} else {
			fmt.Fprintln(stdout, text)
		}
		return 0
	}
	if parseErr != nil {
		return fail(contextInvalid("Tham số không hợp lệ: %v. %s", parseErr, contextUsage))
	}
	need := func(name, value string) error {
		if strings.TrimSpace(value) == "" {
			return contextInvalid("Thiếu %s. %s", name, contextUsage)
		}
		return nil
	}
	needKey := func() error {
		if err := need("--project", *project); err != nil {
			return err
		}
		if !ctxsync.ValidKey(*project) {
			return contextFailure{exit: 1, code: contextInvalidInput, message: fmt.Sprintf("Khoá dự án không hợp lệ: %q", *project)}
		}
		return nil
	}
	inputErr := func(format string, a ...any) error {
		return contextFailure{exit: 1, code: contextInvalidInput, message: fmt.Sprintf(format, a...)}
	}

	home, err := contextHome()
	if err != nil {
		return fail(err)
	}
	m := ctxsync.Manager{
		Root:      filepath.Join(home, ".xdev-hive", "context"),
		Store:     memstore.Store{Dir: filepath.Join(home, ".xdev-hive", "optimizer")},
		Installed: contextHasCLI,
	}

	switch action {
	case "status":
		key := *project
		if key != "" {
			if err := needKey(); err != nil {
				return fail(err)
			}
		}
		list, err := m.Status(key)
		if err != nil {
			return fail(err)
		}
		return emit(struct {
			Projects []ctxsync.Project `json:"projects"`
		}{list}, fmt.Sprintf("Có %d dự án dùng ngữ cảnh chung.", len(list)))
	case "enable":
		if err := need("--folder", *folder); err != nil {
			return fail(err)
		}
		abs, err := filepath.Abs(*folder)
		if err != nil {
			return fail(inputErr("Đường dẫn thư mục không hợp lệ: %v", err))
		}
		if st, err := os.Stat(abs); err != nil || !st.IsDir() {
			return fail(inputErr("Không thấy thư mục dự án %s.", abs))
		}
		if _, err := ctxsync.KeyFor(*projectID, abs); err != nil {
			return fail(inputErr("%v", err))
		}
		p, err := m.Enable(abs, *projectID)
		if err != nil {
			return fail(err)
		}
		out := contextEnabled{Project: p}
		// Bật đã xong; bản nháp chuyển chỉ là đề nghị thêm nên không đọc được thì bỏ qua thay vì làm hỏng kết quả bật.
		if mig, err := m.MigrationDraft(p.Key); err == nil {
			out.Migration = mig
		}
		return emit(out, "Đã bật ngữ cảnh dùng chung cho "+p.Folder+".")
	case "disable":
		if err := needKey(); err != nil {
			return fail(err)
		}
		res, err := m.Disable(*project)
		if err != nil {
			return fail(err)
		}
		if res.Removed == nil {
			res.Removed = []string{}
		}
		if res.Trashed == nil {
			res.Trashed = []string{}
		}
		return emit(res, fmt.Sprintf("Đã gỡ khối khỏi %d file, %d file vào thùng rác.", len(res.Removed), len(res.Trashed)))
	case "save-source":
		if err := needKey(); err != nil {
			return fail(err)
		}
		if err := need("--content-file", *contentFile); err != nil {
			return fail(err)
		}
		raw, err := os.ReadFile(*contentFile)
		if err != nil {
			return fail(inputErr("Không đọc được file nguồn: %v", err))
		}
		p, err := m.SaveSource(*project, string(raw))
		if err != nil {
			return fail(err)
		}
		return emit(p, "Đã lưu nguồn và đồng bộ file đích.")
	case "sync":
		if err := needKey(); err != nil {
			return fail(err)
		}
		var hub *ctxsync.HubSnapshot
		if *hubFile != "" {
			hub = &ctxsync.HubSnapshot{}
			if err := readJSONFile(*hubFile, hub); err != nil {
				return fail(inputErr("File memory hub không dùng được: %v", err))
			}
		}
		var policy *ctxsync.Policy
		if *policyFile != "" {
			policy = &ctxsync.Policy{}
			if err := readJSONFile(*policyFile, policy); err != nil {
				return fail(inputErr("File chính sách không dùng được: %v", err))
			}
		}
		// Chuỗi "Tối ưu" đang chạy sẽ tự đồng bộ ngữ cảnh và hoàn tác được bước đó; ghi xen vào giữa thì hoàn tác lấy sai
		// bản trước. Đồng bộ định kỳ chỉ bỏ lượt này, lượt sau chạy lại.
		unlock, err := optimizeall.Lock(m.Store.Dir)
		if errors.Is(err, optimizeall.ErrLocked) {
			list, err := m.Status(*project)
			if err != nil {
				return fail(err)
			}
			if len(list) == 0 {
				return fail(ctxsync.ErrNotFound)
			}
			list[0].Locked = true
			return emit(list[0], "Đang tối ưu ở cửa sổ khác; bỏ lượt đồng bộ này.")
		}
		if err != nil {
			return fail(err)
		}
		defer unlock()
		p, _, err := m.Sync(*project, hub, policy)
		if err != nil {
			return fail(err)
		}
		return emit(p, "Đã đồng bộ ngữ cảnh dùng chung.")
	case "resolve":
		if err := needKey(); err != nil {
			return fail(err)
		}
		if err := need("--target", *target); err != nil {
			return fail(err)
		}
		if !knownContextTarget(*target) {
			return fail(contextInvalid("File đích không hợp lệ: %q", *target))
		}
		if *keep != "file" && *keep != "source" {
			return fail(contextInvalid("--keep phải là file hoặc source: %q", *keep))
		}
		p, err := m.Resolve(*project, ctxsync.TargetID(*target), *keep)
		if err != nil {
			return fail(err)
		}
		return emit(p, "Đã giải quyết xung đột.")
	case "migrate":
		if err := needKey(); err != nil {
			return fail(err)
		}
		if *apply {
			mig, _, err := m.ApplyMigration(*project)
			if err != nil {
				return fail(err)
			}
			return emit(mig, fmt.Sprintf("Đã chuyển %d file memory dùng chung vào nguồn và tắt chia sẻ kiểu cũ.", len(mig.Files)))
		}
		mig, err := m.MigrationDraft(*project)
		if err != nil {
			return fail(err)
		}
		if mig == nil {
			return fail(contextFailureOf(ctxsync.ErrNoShared))
		}
		return emit(mig, fmt.Sprintf("Bản nháp ghép từ %d file memory dùng chung. Thêm --apply để lưu.", len(mig.Files)))
	}
	return fail(contextInvalid("Lệnh con không hợp lệ: %q. %s", action, contextUsage))
}

func knownContextTarget(id string) bool {
	for _, t := range ctxsync.Targets {
		if string(t) == id {
			return true
		}
	}
	return false
}

func readJSONFile(path string, v any) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, v)
}
