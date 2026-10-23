package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/branches"
	"github.com/tdduydev/xdev-hive/worker/internal/gitexec"
	"github.com/tdduydev/xdev-hive/worker/internal/repolock"
)

const branchesUsage = `Cách dùng: hive-worker branches <lệnh> [--cờ=giá trị …] [--timeout=GIÂY]; dòng đầu stdin là JSON (ít nhất {})
  status        --folder (lặp)
  list          --folder; in RepoBranches rồi mỗi worktree một dòng, gõ "cancel" để huỷ
  fetch         --folder [--remote (lặp)]
  pull          --folder [--confirm-busy]
  switch        --folder --branch|--track [--carry] [--confirm-busy]
  create        --folder --name --base [--switch] [--fetch] [--carry] [--confirm-busy] [--dry-run]
  scan          --folder (lặp) [--no-fetch]
  clean         (stdin items, fetched)
  settings
  settings-set  (stdin settings)
  merge         --folder --onto [--onto-name] [--ff] [--confirm-busy]
  rebase        --folder --onto [--onto-name] [--confirm-rewrite] [--confirm-busy]
  continue      --folder
  abort         --folder
Hợp đồng: specs/026-desktop-git-branches/contracts/branches-cli.md.`

// branchesFlags là cờ hợp lệ của từng lệnh con (hợp đồng mục 3). Cờ không thuộc lệnh con là lỗi thoát 2, để Rust gửi
// nhầm cờ thì lộ ra ngay thay vì bị bỏ qua.
var branchesFlags = map[string][]string{
	"status":       {"folder"},
	"list":         {"folder"},
	"fetch":        {"folder", "remote"},
	"pull":         {"folder", "confirm-busy"},
	"switch":       {"folder", "branch", "track", "carry", "confirm-busy"},
	"create":       {"folder", "name", "base", "switch", "fetch", "carry", "confirm-busy", "dry-run"},
	"scan":         {"folder", "no-fetch"},
	"clean":        {},
	"settings":     {},
	"settings-set": {},
	"merge":        {"folder", "onto", "onto-name", "ff", "confirm-busy"},
	"rebase":       {"folder", "onto", "onto-name", "confirm-rewrite", "confirm-busy"},
	"continue":     {"folder"},
	"abort":        {"folder"},
}

// Lệnh con chạy kiểu job: --timeout là giới hạn một bước, stdin giữ mở cho cancel và busy.
var branchesJobs = map[string]bool{"fetch": true, "pull": true, "scan": true, "clean": true}

// Lệnh con nhận nhiều --folder; lệnh khác cần đúng một.
var branchesMultiFolder = map[string]bool{"status": true, "scan": true}

// branchesDataDir, branchesConfigDir cho test thay: test không được đụng thư mục thật của máy dev.
var (
	branchesDataDir   = repolock.DataDir
	branchesConfigDir = func() (string, error) {
		p, err := pathOr("")
		if err != nil {
			return "", err
		}
		return filepath.Dir(p), nil
	}
)

// stringList là cờ lặp được (--folder=a --folder=b).
type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }

func (s *stringList) Set(v string) error {
	*s = append(*s, v)
	return nil
}

type branchesArgs struct {
	folders, remotes                                     stringList
	branch, track, name, base, onto, ontoName            string
	carry, confirmBusy, switchTo, fetch, dryRun, noFetch bool
	ff, confirmRewrite                                   bool
	timeout                                              int
}

func branchesCommand(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		fmt.Fprintln(stderr, branchesUsage)
		return 2
	}
	sub := args[0]
	allowed, ok := branchesFlags[sub]
	if !ok {
		fmt.Fprintf(stderr, "hive-worker branches: không có lệnh con %q.\n", sub)
		return 2
	}
	a, msg := parseBranchesArgs(sub, allowed, args[1:], stderr)
	if msg != "" {
		if msg != "-" {
			fmt.Fprintln(stderr, "hive-worker branches "+sub+": "+msg)
		}
		return 2
	}

	dataDir, err := branchesDataDir()
	if err != nil {
		fmt.Fprintln(stderr, "hive-worker branches: không tìm được thư mục dữ liệu của worker: "+err.Error())
		return 1
	}
	configDir, err := branchesConfigDir()
	if err != nil {
		fmt.Fprintln(stderr, "hive-worker branches: "+err.Error())
		return 1
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	timeout := time.Duration(a.timeout) * time.Second
	if timeout > 0 && !branchesJobs[sub] {
		var done context.CancelFunc
		ctx, done = context.WithTimeout(ctx, timeout)
		defer done()
	}

	var mu sync.Mutex
	enc := json.NewEncoder(stdout)
	enc.SetEscapeHTML(false)
	write := func(v any) {
		mu.Lock()
		defer mu.Unlock()
		_ = enc.Encode(v)
	}
	emit := func(ev branches.Event) { write(ev) }

	in, input, inErr := branches.ReadInput(stdin)
	env := branches.Env{
		Git:       gitexec.Git{MachineCredentials: true},
		DataDir:   dataDir,
		ConfigDir: configDir,
		Timeout:   timeout,
		Busy:      in.Busy,
	}
	folder := ""
	if len(a.folders) > 0 {
		folder = a.folders[0]
	}
	if inErr != nil {
		switch {
		case sub == "list":
			l := branches.ListFailed(env, folder, inErr)
			write(l.Repo)
			l.Fill(ctx, emit)
		case branchesJobs[sub]:
			emit(branches.Event{Type: branches.EventDone, Folder: folder, Error: inErr})
		default:
			write(errorResult{inErr})
		}
		return 0
	}
	if sub == "list" || branchesJobs[sub] {
		// Không chờ goroutine này: nó chặn ở đọc stdin tới khi Rust đóng ống, mà lệnh xong là tiến trình thoát.
		go in.Follow(cancel, stderr)
	}

	switch sub {
	case "status":
		write(struct {
			Repos []branches.BranchStatus `json:"repos"`
		}{branches.Status(ctx, env, a.folders)})
	case "list":
		l := branches.List(ctx, env, folder)
		write(l.Repo)
		l.Fill(ctx, emit)
	case "fetch":
		branches.Fetch(ctx, env, folder, a.remotes, emit)
	case "pull":
		branches.Pull(ctx, env, branches.PullOptions{Folder: folder, ConfirmBusy: a.confirmBusy}, emit)
	case "scan":
		branches.Scan(ctx, env, branches.ScanOptions{Folders: a.folders, NoFetch: a.noFetch}, emit)
	case "clean":
		branches.Clean(ctx, env, input.Items, input.Fetched, emit)
	case "switch":
		write(oneShot(branches.Switch(ctx, env, branches.SwitchOptions{
			Folder: folder, Branch: a.branch, Track: a.track, Carry: a.carry, ConfirmBusy: a.confirmBusy,
		})))
	case "create":
		write(oneShot(branches.Create(ctx, env, branches.CreateOptions{
			Folder: folder, Name: a.name, Base: a.base, Switch: a.switchTo, Fetch: a.fetch, Carry: a.carry,
			ConfirmBusy: a.confirmBusy, DryRun: a.dryRun,
		})))
	case "settings":
		write(oneShot(branches.Settings(env)))
	case "settings-set":
		write(oneShot(branches.SetSettings(env, input.Settings)))
	case "merge":
		write(operationResult(branches.Merge(ctx, env, branches.MergeOptions{
			Folder: folder, Onto: a.onto, OntoName: a.ontoName, FF: a.ff, ConfirmBusy: a.confirmBusy,
		})))
	case "rebase":
		write(operationResult(branches.Rebase(ctx, env, branches.RebaseOptions{
			Folder: folder, Onto: a.onto, OntoName: a.ontoName, ConfirmRewrite: a.confirmRewrite, ConfirmBusy: a.confirmBusy,
		})))
	case "continue":
		write(operationResult(branches.Continue(ctx, env, folder)))
	case "abort":
		write(operationResult(branches.Abort(ctx, env, folder)))
	}
	return 0
}

// parseBranchesArgs đọc cờ của lệnh con. Trả msg khác rỗng là lỗi thoát 2; "-" là flag đã tự in lỗi ra stderr.
func parseBranchesArgs(sub string, allowed, args []string, stderr io.Writer) (branchesArgs, string) {
	var a branchesArgs
	fs := flag.NewFlagSet("branches "+sub, flag.ContinueOnError)
	fs.SetOutput(stderr)
	has := func(name string) bool { return slices.Contains(allowed, name) }
	str := map[string]*string{
		"branch": &a.branch, "track": &a.track, "name": &a.name, "base": &a.base, "onto": &a.onto, "onto-name": &a.ontoName,
	}
	boolean := map[string]*bool{
		"carry": &a.carry, "confirm-busy": &a.confirmBusy, "switch": &a.switchTo, "fetch": &a.fetch, "dry-run": &a.dryRun,
		"no-fetch": &a.noFetch, "ff": &a.ff, "confirm-rewrite": &a.confirmRewrite,
	}
	for _, name := range allowed {
		switch {
		case name == "folder":
			fs.Var(&a.folders, name, "thư mục, đường dẫn tuyệt đối")
		case name == "remote":
			fs.Var(&a.remotes, name, "tên remote")
		case str[name] != nil:
			fs.StringVar(str[name], name, "", name)
		case boolean[name] != nil:
			fs.BoolVar(boolean[name], name, false, name)
		}
	}
	fs.IntVar(&a.timeout, "timeout", 0, "giây; 0 là không giới hạn")
	if err := fs.Parse(args); err != nil {
		return a, "-"
	}
	if fs.NArg() > 0 {
		return a, fmt.Sprintf("thừa đối số %q.", fs.Arg(0))
	}
	if a.timeout < 0 {
		return a, "--timeout không được âm."
	}
	if has("folder") {
		switch {
		case len(a.folders) == 0:
			return a, "thiếu --folder."
		case len(a.folders) > 1 && !branchesMultiFolder[sub]:
			return a, "--folder chỉ được truyền một lần."
		}
		for i, f := range a.folders {
			if !filepath.IsAbs(f) {
				return a, fmt.Sprintf("--folder phải là đường dẫn tuyệt đối: %q.", f)
			}
			a.folders[i] = filepath.Clean(f)
		}
	}
	for _, r := range a.remotes {
		if r == "" {
			return a, "--remote không được rỗng."
		}
	}
	switch sub {
	case "switch":
		if (a.branch == "") == (a.track == "") {
			return a, "cần đúng một trong --branch, --track."
		}
	case "create":
		if a.name == "" || a.base == "" {
			return a, "cần --name và --base."
		}
	case "merge", "rebase":
		if a.onto == "" {
			return a, "thiếu --onto."
		}
	}
	return a, ""
}

// errorResult là kết quả một lần chỉ có lỗi (hợp đồng mục 3: "Mọi kết quả một lần có thể chỉ là {error}").
type errorResult struct {
	Error *branches.Error `json:"error"`
}

func oneShot[T any](v *T, e *branches.Error) any {
	if e != nil {
		return errorResult{e}
	}
	return v
}

// operationResult là {operation: GitOperation} của merge, rebase, continue, abort.
func operationResult(op *branches.GitOperation, e *branches.Error) any {
	if e != nil {
		return errorResult{e}
	}
	return struct {
		Operation *branches.GitOperation `json:"operation"`
	}{op}
}
