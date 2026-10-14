//go:build !windows

package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/runner"
	"github.com/tdduydev/xdev-hive/worker/internal/terminal"
)

// fakeAgent đóng vai claude/codex: in đối số rồi trả lời từng dòng; "quit" thoát mã 0.
const fakeAgent = `#!/bin/sh
echo "READY $*"
while IFS= read -r line; do
  [ "$line" = "quit" ] && exit 0
  echo "got:$line"
done
`

func shortTemp(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "hv")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

// startWorker chạy socket nội bộ + phiên tại máy như hive-worker run, với CLI giả.
func startWorker(t *testing.T) string {
	t.Helper()
	dir := shortTemp(t)
	script := filepath.Join(dir, "agent.sh")
	if err := os.WriteFile(script, []byte(fakeAgent), 0o700); err != nil {
		t.Fatal(err)
	}
	local := &terminal.Local{
		Commands:  map[string]runner.Command{"claude": {Path: script}, "codex": {Path: script}},
		KillGrace: 500 * time.Millisecond,
	}
	path := filepath.Join(dir, "run", "hive.sock")
	ln, err := localipc.Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		_ = (&localipc.Server{Worker: "9.9.9-test", Handler: local.Handle}).Serve(ctx, ln)
		close(done)
	}()
	t.Cleanup(func() {
		local.CloseAll("test xong")
		local.Wait(10 * time.Second)
		cancel()
		<-done
	})
	return path
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("hết giờ chờ %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// running chạy một lệnh hive trong nền; stdin là pipe để test gõ.
type running struct {
	*testApp
	in   *io.PipeWriter
	code chan int
}

func start(t *testing.T, socket string, args ...string) *running {
	t.Helper()
	r, w := io.Pipe()
	a := newTestApp(socket, r)
	run := &running{testApp: a, in: w, code: make(chan int, 1)}
	go func() { run.code <- a.run(args) }()
	t.Cleanup(func() { _ = w.Close() })
	return run
}

func (r *running) waitOut(t *testing.T, s string) {
	t.Helper()
	waitFor(t, "output "+s, func() bool { return strings.Contains(r.out.String(), s) })
}

func (r *running) typeIn(t *testing.T, s string) {
	t.Helper()
	if _, err := r.in.Write([]byte(s)); err != nil {
		t.Fatal(err)
	}
}

func (r *running) exit(t *testing.T) int {
	t.Helper()
	select {
	case c := <-r.code:
		return c
	case <-time.After(10 * time.Second):
		t.Fatalf("lệnh chưa thoát; stderr %q", r.err.String())
		return -1
	}
}

func listIDs(t *testing.T, socket string) []string {
	t.Helper()
	a := newTestApp(socket, nil)
	if code := a.run([]string{"ls", "--json"}); code != exitOK {
		t.Fatalf("ls: %d %s", code, a.err.String())
	}
	var list []sessionInfo
	if err := json.Unmarshal([]byte(a.out.String()), &list); err != nil {
		t.Fatalf("ls --json: %v %q", err, a.out.String())
	}
	ids := make([]string, len(list))
	for i, s := range list {
		ids[i] = s.ID
	}
	return ids
}

func TestChatDetachAttachKill(t *testing.T) {
	socket := startWorker(t)

	v := newTestApp(socket, nil)
	if code := v.run([]string{"version"}); code != exitOK || !strings.Contains(v.out.String(), "hive-worker 9.9.9-test") {
		t.Fatalf("version: %d %q %q", code, v.out.String(), v.err.String())
	}

	chat := start(t, socket, "chat", "--model", "opus")
	chat.waitOut(t, "READY --model opus")
	chat.typeIn(t, "mot\n")
	chat.waitOut(t, "got:mot")
	chat.typeIn(t, "\x1dd")
	if code := chat.exit(t); code != exitOK || !strings.Contains(chat.err.String(), "Đã tách khỏi phiên") {
		t.Fatalf("tách: %d %q", code, chat.err.String())
	}

	ids := listIDs(t, socket)
	if len(ids) != 1 {
		t.Fatalf("ls = %v", ids)
	}
	id := ids[0]
	table := newTestApp(socket, nil)
	if table.run([]string{"ls"}) != exitOK || !strings.Contains(table.out.String(), id) || !strings.Contains(table.out.String(), "mặc định") {
		t.Fatalf("ls bảng: %q", table.out.String())
	}

	// Một gõ, một xem; cả hai nhận lại output cũ khi gắn.
	ctl := start(t, socket, "attach", id)
	ctl.waitOut(t, "got:mot")
	view := start(t, socket, "attach", "--view", id)
	view.waitOut(t, "got:mot")
	ctl.typeIn(t, "hai\n")
	view.waitOut(t, "got:hai")
	view.typeIn(t, "khong-vao\n")
	ctl.typeIn(t, "ba\n")
	ctl.waitOut(t, "got:ba")
	if strings.Contains(ctl.out.String(), "khong-vao") {
		t.Fatal("phím của người xem lọt vào phiên")
	}

	kill := newTestApp(socket, nil)
	if code := kill.run([]string{"kill", id[:4]}); code != exitOK || !strings.Contains(kill.out.String(), "Đã ngắt phiên "+id) {
		t.Fatalf("kill: %d %q %q", code, kill.out.String(), kill.err.String())
	}
	for _, r := range []*running{ctl, view} {
		if code := r.exit(t); code != exitFailed || !strings.Contains(r.err.String(), "Phiên đã bị ngắt") {
			t.Fatalf("sau kill: %d %q", code, r.err.String())
		}
	}
	waitFor(t, "phiên bị xoá", func() bool { return len(listIDs(t, socket)) == 0 })

	gone := newTestApp(socket, nil)
	if code := gone.run([]string{"attach", id}); code != exitFailed || !strings.Contains(gone.err.String(), "Không có phiên") {
		t.Fatalf("attach phiên đã ngắt: %d %q", code, gone.err.String())
	}
}

func TestRunPromptAndExit(t *testing.T) {
	socket := startWorker(t)
	run := start(t, socket, "run", "sửa lỗi đăng nhập", "--cli", "codex")
	run.waitOut(t, "READY sửa lỗi đăng nhập")
	run.typeIn(t, "quit\n")
	if code := run.exit(t); code != exitOK {
		t.Fatalf("agent thoát 0: %d %q", code, run.err.String())
	}
}

func TestStdinClosedDetaches(t *testing.T) {
	socket := startWorker(t)
	chat := start(t, socket, "chat")
	chat.waitOut(t, "READY")
	_ = chat.in.Close()
	if code := chat.exit(t); code != exitOK {
		t.Fatalf("hết stdin: %d", code)
	}
	if len(listIDs(t, socket)) != 1 {
		t.Fatal("phiên phải chạy tiếp sau khi tách")
	}
}

// Worker trả lời bắt tay với phiên bản giao thức khác: hive báo cập nhật, mã 2.
func TestVersionMismatchExit(t *testing.T) {
	dir := shortTemp(t)
	socket := filepath.Join(dir, "hive.sock")
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			nc, err := ln.Accept()
			if err != nil {
				return
			}
			c := localipc.NewConn(nc)
			var hello map[string]any
			_ = c.ReadJSON(&hello)
			_ = c.WriteJSON(map[string]any{"ok": false, "code": "version", "v": 2, "worker": "2.0.0", "error": "khác"})
			_ = c.Close()
		}
	}()
	for _, args := range [][]string{{"version"}, {"chat"}, {"ls"}} {
		a := newTestApp(socket, nil)
		if code := a.run(args); code != exitUsage || !strings.Contains(a.err.String(), "Chạy `hive-worker update`") {
			t.Fatalf("%v: %d %q", args, code, a.err.String())
		}
		if args[0] == "version" && !strings.Contains(a.out.String(), "hive-worker 2.0.0") {
			t.Fatalf("version phải in phiên bản worker: %q", a.out.String())
		}
	}
}

// Worker từ chối người gọi: mã 3.
func TestDeniedExit(t *testing.T) {
	dir := shortTemp(t)
	socket := filepath.Join(dir, "hive.sock")
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			nc, err := ln.Accept()
			if err != nil {
				return
			}
			c := localipc.NewConn(nc)
			_ = c.Fail(localipc.CodeDenied, "không")
			_ = c.Close()
		}
	}()
	a := newTestApp(socket, nil)
	if code := a.run([]string{"ls"}); code != exitDenied {
		t.Fatalf("bị từ chối: %d %q", code, a.err.String())
	}
}
