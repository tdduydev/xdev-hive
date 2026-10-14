//go:build !windows

package terminal

import (
	"context"
	"log/slog"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/accounts"
	"github.com/tdduydev/xdev-hive/worker/internal/runner"
)

const waitFor = 15 * time.Second

func makeRemote(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	remote := filepath.Join(root, "remote.git")
	work := filepath.Join(root, "source")
	run := func(args ...string) string {
		t.Helper()
		out, err := exec.Command(args[0], args[1:]...).CombinedOutput()
		if err != nil {
			t.Fatalf("%v: %s: %v", args, out, err)
		}
		return string(out)
	}
	run("git", "init", "--bare", remote)
	run("git", "init", work)
	if err := os.WriteFile(filepath.Join(work, "README"), []byte("init"), 0600); err != nil {
		t.Fatal(err)
	}
	run("git", "-C", work, "add", ".")
	run("git", "-C", work, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-m", "base")
	base := strings.TrimSpace(run("git", "-C", work, "branch", "--show-current"))
	run("git", "-C", work, "remote", "add", "origin", remote)
	run("git", "-C", work, "push", "-u", "origin", base)
	return remote, base
}

// harness là Host chạy "claude" bằng lệnh giả, gom Event để test chờ.
type harness struct {
	host   *Host
	data   string
	remote string
	base   string

	mu     sync.Mutex
	events []Event
	notify chan struct{}
}

func newHarness(t *testing.T, cmd runner.Command) *harness {
	t.Helper()
	remote, base := makeRemote(t)
	h := &harness{data: t.TempDir(), remote: remote, base: base, notify: make(chan struct{}, 1)}
	h.host = &Host{
		Runner: runner.Runner{DataDir: h.data, CLICommands: map[string]runner.Command{"claude": cmd}},
		Send: func(e Event) error {
			h.mu.Lock()
			h.events = append(h.events, e)
			h.mu.Unlock()
			select {
			case h.notify <- struct{}{}:
			default:
			}
			return nil
		},
		Logger:    slog.New(slog.DiscardHandler),
		KillGrace: time.Second,
	}
	t.Cleanup(func() {
		h.host.CloseAll("test xong")
		h.host.Wait(waitFor)
	})
	return h
}

func (h *harness) request(id string) OpenRequest {
	u := (&url.URL{Scheme: "file", Path: filepath.ToSlash(h.remote)}).String()
	return OpenRequest{SessionID: id, Cols: 80, Rows: 24, Spec: runner.InteractiveSpec{SessionID: id, ProjectID: "p", ProjectKey: "WEB", RepoURL: u, BaseBranch: h.base, HubURL: "http://hub.test", Model: "sonnet", RunPermissions: "workspace", MCPToken: "tok-SECRET-123456", SystemPrompt: "Leader"}}
}

// output là output đã gửi của phiên, theo seq.
func (h *harness) output(id string) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var b strings.Builder
	var next int64
	for _, e := range h.events {
		if e.SessionID == id && e.Kind == KindOutput {
			if e.Seq != next {
				return b.String() + "[seq lệch]"
			}
			next++
			b.Write(e.Data)
		}
	}
	return b.String()
}

func (h *harness) find(id, kind string) *Event {
	h.mu.Lock()
	defer h.mu.Unlock()
	for i := range h.events {
		if h.events[i].SessionID == id && h.events[i].Kind == kind {
			e := h.events[i]
			return &e
		}
	}
	return nil
}

func (h *harness) wait(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.After(waitFor)
	for !ok() {
		select {
		case <-h.notify:
		case <-time.After(20 * time.Millisecond):
		case <-deadline:
			h.mu.Lock()
			defer h.mu.Unlock()
			t.Fatalf("hết giờ chờ %s; events: %+v", what, h.events)
		}
	}
}

func (h *harness) waitOutput(t *testing.T, id, want string) {
	t.Helper()
	h.wait(t, "output "+want, func() bool { return strings.Contains(h.output(id), want) })
}

func (h *harness) waitExit(t *testing.T, id string) Event {
	t.Helper()
	h.wait(t, "term_exit", func() bool { return h.find(id, KindExit) != nil })
	return *h.find(id, KindExit)
}

const s1 = "0a0a0a0a-0000-4000-8000-0000000000a1"
const s2 = "0a0a0a0a-0000-4000-8000-0000000000a2"

func TestOpenInputResizeClose(t *testing.T) {
	h := newHarness(t, runner.Command{Path: "/bin/sh"})
	h.host.Open(context.Background(), h.request(s1))
	h.wait(t, "term_opened", func() bool { return h.find(s1, KindOpened) != nil })
	if e := h.find(s1, KindOpened); e.Permissions != "workspace" || e.AccountLabel != "" {
		t.Fatalf("opened = %+v", e)
	}
	work := filepath.Join(h.data, "terminals", s1)
	if _, err := os.Stat(filepath.Join(work, "README")); err != nil {
		t.Fatalf("worktree chưa có: %v", err)
	}
	h.host.Input(s1, []byte("echo hi-$((40+2)) $TERM\r"))
	h.waitOutput(t, s1, "hi-42 xterm-256color")
	h.host.Input(s1, []byte("stty size\r"))
	h.waitOutput(t, s1, "24 80")
	h.host.Resize(s1, 100, 30)
	h.host.Input(s1, []byte("stty size\r"))
	h.waitOutput(t, s1, "30 100")
	// Bí mật in ra màn hình bị che.
	h.host.Input(s1, []byte("echo X$HIVE_PROJECT; printf 'tok-SEC'; printf 'RET-123456\\n'\r"))
	h.waitOutput(t, s1, "XWEB")
	h.waitOutput(t, s1, "***")
	h.host.Close(s1, "Người mở đã đóng phiên.")
	exit := h.waitExit(t, s1)
	if exit.Reason != ReasonClosed || exit.ExitCode != nil || exit.Message != "Người mở đã đóng phiên." {
		t.Fatalf("exit = %+v", exit)
	}
	if strings.Contains(h.output(s1), "tok-SECRET-123456") || strings.Contains(h.output(s1), "[seq lệch]") {
		t.Fatalf("output = %q", h.output(s1))
	}
	if _, err := os.Stat(work); !os.IsNotExist(err) {
		t.Fatal("worktree chưa bị xoá khi đóng")
	}
	if h.host.Count() != 0 {
		t.Fatalf("còn %d phiên", h.host.Count())
	}
}

func TestCLIExitReportsCode(t *testing.T) {
	h := newHarness(t, runner.Command{Path: "/bin/sh", Args: []string{"-c", "echo tạm-biệt; exit 3"}})
	h.host.Open(context.Background(), h.request(s1))
	exit := h.waitExit(t, s1)
	if exit.Reason != ReasonExit || exit.ExitCode == nil || *exit.ExitCode != 3 {
		t.Fatalf("exit = %+v", exit)
	}
	if h.find(s1, KindOpened) == nil || !strings.Contains(h.output(s1), "tạm-biệt") {
		t.Fatalf("output = %q", h.output(s1))
	}
	if _, err := os.Stat(filepath.Join(h.data, "terminals", s1)); !os.IsNotExist(err) {
		t.Fatal("worktree chưa bị xoá khi CLI thoát")
	}
}

func TestIdleTimeoutCloses(t *testing.T) {
	h := newHarness(t, runner.Command{Path: "/bin/sh", Args: []string{"-c", "sleep 30"}})
	h.host.IdleTimeout = 300 * time.Millisecond
	h.host.Open(context.Background(), h.request(s1))
	exit := h.waitExit(t, s1)
	if exit.Reason != ReasonIdle || !strings.Contains(exit.Message, "không hoạt động") {
		t.Fatalf("exit = %+v", exit)
	}
}

func TestMaxSessionsDenied(t *testing.T) {
	h := newHarness(t, runner.Command{Path: "/bin/sh"})
	h.host.MaxSessions = 1
	h.host.Open(context.Background(), h.request(s1))
	h.host.Open(context.Background(), h.request(s2))
	exit := h.waitExit(t, s2)
	if exit.Reason != ReasonDenied || !strings.Contains(exit.Message, "đủ 1 phiên") {
		t.Fatalf("exit = %+v", exit)
	}
	h.wait(t, "term_opened s1", func() bool { return h.find(s1, KindOpened) != nil })
	h.host.CloseAll("worker tắt")
	if exit := h.waitExit(t, s1); exit.Reason != ReasonClosed {
		t.Fatalf("exit s1 = %+v", exit)
	}
}

func TestPrepareErrorAndAccountDenied(t *testing.T) {
	h := newHarness(t, runner.Command{Path: "/bin/sh"})
	req := h.request(s1)
	req.Spec.RepoURL = "file:///khong/co/repo.git"
	h.host.Open(context.Background(), req)
	if exit := h.waitExit(t, s1); exit.Reason != ReasonError || !strings.Contains(exit.Message, "Không chuẩn bị được") {
		t.Fatalf("exit = %+v", exit)
	}
	path := filepath.Join(t.TempDir(), "accounts.json")
	if err := accounts.Save(path, 0, []accounts.Account{{ID: "claude-1", Label: "Gói A", CLI: "claude", Enabled: false}}); err != nil {
		t.Fatal(err)
	}
	h.host.Accounts = accounts.NewPool(path)
	req = h.request(s2)
	req.AccountID = "claude-1"
	h.host.Open(context.Background(), req)
	if exit := h.waitExit(t, s2); exit.Reason != ReasonDenied || !strings.Contains(exit.Message, "đang tắt") {
		t.Fatalf("exit = %+v", exit)
	}
}

// Giới hạn băng thông: output lớn đi chậm theo RateBytes nhưng đủ từng byte.
func TestOutputRateLimitKeepsBytes(t *testing.T) {
	const total = 128 * 1024
	h := newHarness(t, runner.Command{Path: "/bin/sh", Args: []string{"-c", "stty raw -echo; head -c 131072 /dev/zero | tr '\\0' a; sleep 0.2"}})
	h.host.RateBytes = 64 * 1024
	start := time.Now()
	h.host.Open(context.Background(), h.request(s1))
	h.waitExit(t, s1)
	elapsed := time.Since(start)
	if got := strings.Count(h.output(s1), "a"); got != total {
		t.Fatalf("nhận %d byte, muốn %d", got, total)
	}
	// 64 KiB đầu đi ngay (dồn một giây), 64 KiB sau phải chờ khoảng một giây.
	if elapsed < 800*time.Millisecond {
		t.Fatalf("output đi quá nhanh (%v) so với giới hạn", elapsed)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, e := range h.events {
		if len(e.Data) > DefaultChunkBytes {
			t.Fatalf("gói output %d byte, vượt %d", len(e.Data), DefaultChunkBytes)
		}
	}
}

// Bí mật bị cắt giữa hai lần đọc PTY vẫn bị che.
func TestSecretSplitAcrossReadsIsMasked(t *testing.T) {
	h := newHarness(t, runner.Command{Path: "/bin/sh", Args: []string{"-c", "printf 'a tok-SEC'; sleep 0.1; printf 'RET-123456 b'; sleep 0.2"}})
	h.host.Flush = 300 * time.Millisecond
	h.host.Open(context.Background(), h.request(s1))
	h.waitExit(t, s1)
	out := h.output(s1)
	if !strings.Contains(out, "a *** b") || strings.Contains(out, "123456") {
		t.Fatalf("output = %q", out)
	}
}
