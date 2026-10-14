package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/tdduydev/xdev-hive/worker/internal/accounts"
	"github.com/tdduydev/xdev-hive/worker/internal/memstore"
	"github.com/tdduydev/xdev-hive/worker/internal/projects"
	"github.com/tdduydev/xdev-hive/worker/internal/runner"
)

const memoryUsage = "Cách dùng: hive-worker memory [scan | edit --path FILE (--stdin | --content-file FILE) | delete --path FILE | restore --id MÃ | merge --source FILE [--source FILE …] --target FILE (--stdin | --content-file FILE) | share --project KHOÁ [--pick TÊN=GÓI …] [--folder THƯ_MỤC] | unshare --project KHOÁ] [--json]"

// Test thay thư mục nhà, phiên bản Claude Code và nguồn nội dung.
var (
	memoryHome                    = os.UserHomeDir
	memoryClaudeVersion           = func(ctx context.Context) string { return runner.DetectClaudeVersion(ctx) }
	memoryStdin         io.Reader = os.Stdin
)

// memoryView là kết quả của `hive-worker memory scan --json` cho app desktop.
type memoryView struct {
	memstore.Inventory
	Shared  []memstore.SharedRecord `json:"shared"`
	Entries []memstore.EntrySummary `json:"entries"`
}

// memoryOutput là kết quả của lệnh ghi. Share thêm Applied và Conflicts: có xung đột thì chưa đổi gì và app hỏi người
// dùng chọn bản rồi chạy lại với --pick.
type memoryOutput struct {
	memstore.ShareResult
}

type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

// memoryCommand: quét, sửa, xoá, khôi phục, gộp và dùng chung memory của các gói CLI trên máy (spec 015 US3, US4). Mọi
// thao tác ghi đều sao lưu trước (xoá vào ~/.xdev-hive/optimizer/trash) và chỉ chạy trên file mà lần quét thấy.
func memoryCommand(args []string, stdout, stderr io.Writer) int {
	action := "scan"
	if len(args) > 0 && args[0] != "" && args[0][0] != '-' {
		action, args = args[0], args[1:]
	}
	fs := flag.NewFlagSet("memory "+action, flag.ContinueOnError)
	fs.SetOutput(stderr)
	configPath := fs.String("config", "", "file cấu hình worker (accounts.json và projects.json nằm cạnh)")
	asJSON := fs.Bool("json", false, "in dạng JSON (cho app desktop)")
	path := fs.String("path", "", "file memory")
	target := fs.String("target", "", "merge: file đích")
	id := fs.String("id", "", "restore: mã bản lưu")
	project := fs.String("project", "", "khoá dự án của Claude (tên thư mục trong projects/)")
	folder := fs.String("folder", "", "share: thư mục dự án trên máy, khi app chưa gắn dự án này")
	fromStdin := fs.Bool("stdin", false, "đọc nội dung mới từ stdin")
	contentFile := fs.String("content-file", "", "đọc nội dung mới từ file")
	var sources, picks multiFlag
	fs.Var(&sources, "source", "merge: file nguồn (nhắc lại cho nhiều file)")
	fs.Var(&picks, "pick", "share: TÊN_FILE=GÓI, chọn bản giữ khi file trùng tên khác nội dung")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	fail := func(err error) int {
		fmt.Fprintln(stderr, err)
		return 1
	}
	usage := func() int {
		fmt.Fprintln(stderr, memoryUsage)
		return 2
	}
	cfg, err := pathOr(*configPath)
	if err != nil {
		return fail(err)
	}
	home, err := memoryHome()
	if err != nil {
		return fail(err)
	}
	store := memstore.Store{Dir: filepath.Join(home, ".xdev-hive", "optimizer")}
	sharedRoot := filepath.Join(home, ".xdev-hive", "memory", "claude")
	content := func() (string, error) {
		switch {
		case *fromStdin:
			raw, err := io.ReadAll(memoryStdin)
			return string(raw), err
		case *contentFile != "":
			raw, err := os.ReadFile(*contentFile)
			return string(raw), err
		}
		return "", errors.New("thiếu nội dung mới: dùng --stdin hoặc --content-file")
	}
	roots, localProjects, warnings := memoryRoots(cfg, home)
	records, err := store.Shared()
	if err != nil {
		return fail(err)
	}
	if len(records) > 0 {
		roots = append(roots, memstore.Root{CLI: "claude", Profile: "shared", Path: sharedRoot})
	}
	// Chỉ cho ghi vào file mà lần quét thấy, để app (hay ai đó gọi nhầm) không sửa được file tuỳ ý trên máy. Đích của merge
	// được phép là file chưa có, miễn nằm cùng thư mục với một file đã quét.
	allowed := func(existing []string, newOK string) error {
		inv := memstore.Scan(roots, localProjects)
		known := map[string]bool{}
		dirs := map[string]bool{}
		for _, f := range inv.Files {
			if f.Kind != "database" {
				known[f.Path] = true
				dirs[filepath.Dir(f.Path)] = true
			}
		}
		check := func(p string, mayBeNew bool) error {
			if !filepath.IsAbs(p) {
				return fmt.Errorf("đường dẫn phải là đường dẫn tuyệt đối: %s", p)
			}
			p = filepath.Clean(p)
			if known[p] || mayBeNew && !fileExists(p) && dirs[filepath.Dir(p)] {
				return nil
			}
			return fmt.Errorf("không phải file memory hay instruction mà app đã quét: %s", p)
		}
		for _, p := range existing {
			if err := check(p, false); err != nil {
				return err
			}
		}
		if newOK != "" {
			return check(newOK, true)
		}
		return nil
	}
	emit := func(v any, text string) int {
		if *asJSON {
			_ = json.NewEncoder(stdout).Encode(v)
		} else {
			fmt.Fprintln(stdout, text)
		}
		return 0
	}
	writeResult := func(res memstore.Result, err error, text string) int {
		if err != nil {
			return fail(err)
		}
		if res.Warnings == nil {
			res.Warnings = []string{}
		}
		return emit(memoryOutput{ShareResult: memstore.ShareResult{Applied: true, Result: res}}, fmt.Sprintf("%s Mã khôi phục: %s", text, res.Entry))
	}

	switch action {
	case "scan":
		inv := memstore.Scan(roots, localProjects)
		inv.Warnings = append(warnings, inv.Warnings...)
		entries, err := store.Entries()
		if err != nil {
			return fail(err)
		}
		view := memoryView{Inventory: inv, Shared: records, Entries: entries}
		return emit(view, fmt.Sprintf("Tìm thấy %d file memory và instruction ở %d dự án.", len(inv.Files), len(inv.Sessions)))
	case "edit":
		if *path == "" {
			return usage()
		}
		text, err := content()
		if err != nil {
			return fail(err)
		}
		if err := allowed([]string{*path}, ""); err != nil {
			return fail(err)
		}
		res, err := store.Edit(*path, text)
		return writeResult(res, err, "Đã lưu "+*path+".")
	case "delete":
		if *path == "" {
			return usage()
		}
		if err := allowed([]string{*path}, ""); err != nil {
			return fail(err)
		}
		res, err := store.Delete(*path)
		return writeResult(res, err, "Đã chuyển "+*path+" vào thùng rác (giữ 30 ngày).")
	case "restore":
		if *id == "" {
			return usage()
		}
		res, err := store.Restore(*id)
		return writeResult(res, err, "Đã khôi phục.")
	case "merge":
		if len(sources) == 0 || *target == "" {
			return usage()
		}
		text, err := content()
		if err != nil {
			return fail(err)
		}
		if err := allowed(sources, *target); err != nil {
			return fail(err)
		}
		res, err := store.Merge(sources, *target, text)
		return writeResult(res, err, "Đã gộp vào "+*target+".")
	case "share", "unshare":
		if *project == "" {
			return usage()
		}
		if action == "unshare" {
			res, err := store.Unshare(*project)
			if err != nil {
				return fail(err)
			}
			return emit(memoryOutput{ShareResult: res}, "Đã trả mỗi gói một bản sao memory. Mã khôi phục: "+res.Entry)
		}
		pick := map[string]string{}
		for _, p := range picks {
			name, profile, ok := strings.Cut(p, "=")
			if !ok || name == "" || profile == "" {
				return fail(fmt.Errorf("--pick phải có dạng TÊN_FILE=GÓI: %q", p))
			}
			pick[name] = profile
		}
		dir := *folder
		if dir == "" {
			dir = memoryProjectFolder(localProjects, *project)
		}
		res, err := store.Share(memstore.ShareOptions{Key: *project, ProjectPath: dir, Roots: claudeRoots(roots),
			SharedRoot: sharedRoot, ClaudeVersion: memoryClaudeVersion(context.Background()), Picks: pick})
		if err != nil {
			return fail(err)
		}
		if !res.Applied {
			return emit(memoryOutput{ShareResult: res}, fmt.Sprintf("Có %d file trùng tên khác nội dung: chọn bản giữ bằng --pick TÊN=GÓI.", len(res.Conflicts)))
		}
		return emit(memoryOutput{ShareResult: res}, "Các gói Claude giờ dùng chung memory ở "+res.Shared.SharedDir+". Mã khôi phục: "+res.Entry)
	}
	return usage()
}

// memoryRoots là thư mục cấu hình của mọi gói trong accounts.json, cộng đăng nhập mặc định của CLI nếu thư mục có tồn tại
// (spec 015 US2: quét cả thư mục mặc định, không chỉ gói của Hive). Không đọc được danh sách thì vẫn quét phần còn lại.
func memoryRoots(cfg, home string) ([]memstore.Root, []projects.Project, []string) {
	var warnings []string
	list, err := accounts.Load(accounts.DefaultPath(cfg))
	if err != nil {
		warnings = append(warnings, "không đọc được danh sách tài khoản: "+err.Error())
	}
	var roots []memstore.Root
	seen := map[string]bool{}
	add := func(cli, profile, dir string) {
		if cli != "claude" && cli != "codex" && cli != "gemini" {
			return
		}
		key := cli + "\x00" + filepath.Clean(dir)
		if seen[key] {
			return
		}
		seen[key] = true
		roots = append(roots, memstore.Root{CLI: cli, Profile: profile, Path: dir})
	}
	defaults := map[string]string{"claude": ".claude", "codex": ".codex", "gemini": ".gemini"}
	for _, a := range list {
		if a.Pending {
			continue
		}
		dir := a.ConfigDir
		switch {
		case dir == "~":
			dir = home
		case strings.HasPrefix(dir, "~/"):
			dir = filepath.Join(home, dir[2:])
		case dir == "" && defaults[a.CLI] != "":
			dir = filepath.Join(home, defaults[a.CLI])
		}
		if dir != "" {
			add(a.CLI, a.ID, dir)
		}
	}
	for _, cli := range []string{"claude", "codex", "gemini"} {
		dir := filepath.Join(home, defaults[cli])
		if st, err := os.Stat(dir); err == nil && st.IsDir() {
			add(cli, "default-"+cli, dir)
		}
	}
	sort.SliceStable(roots, func(i, j int) bool { return roots[i].CLI+roots[i].Profile < roots[j].CLI+roots[j].Profile })
	local, err := projects.Load(projects.DefaultPath(cfg))
	if err != nil {
		warnings = append(warnings, "không đọc được danh sách dự án: "+err.Error())
	}
	return roots, local, warnings
}

func claudeRoots(roots []memstore.Root) []memstore.Root {
	var out []memstore.Root
	for _, r := range roots {
		if r.CLI == "claude" && r.Profile != "shared" {
			out = append(out, r)
		}
	}
	return out
}

// memoryProjectFolder là thư mục repo local có khoá Claude trùng key, kể cả khi đường dẫn đã giải liên kết.
func memoryProjectFolder(list []projects.Project, key string) string {
	for _, p := range list {
		if p.Folder == "" {
			continue
		}
		folder, err := filepath.Abs(p.Folder)
		if err != nil {
			continue
		}
		if memstore.ProjectKey(folder) == key {
			return folder
		}
		if real, err := filepath.EvalSymlinks(folder); err == nil && memstore.ProjectKey(real) == key {
			return folder
		}
	}
	return ""
}
