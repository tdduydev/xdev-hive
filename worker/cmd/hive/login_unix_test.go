//go:build !windows

package main

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
)

// chat --task tra task trên hub rồi gửi id (không phải key) cho worker; worker ghi phiên kèm liên kết đó.
func TestChatTaskSendsIDsToWorker(t *testing.T) {
	hub := newFakeHub(t)
	dir := shortTemp(t)
	path := filepath.Join(dir, "run", "hive.sock")
	ln, err := localipc.Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	got := make(chan map[string]any, 1)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() {
		_ = (&localipc.Server{Worker: "test", Handler: func(_ context.Context, c *localipc.Conn, req localipc.Request) error {
			var m map[string]any
			_ = req.Decode(&m)
			got <- m
			return c.Fail(localipc.CodeBadRequest, "dừng ở đây")
		}}).Serve(ctx, ln)
	}()

	a := newTestApp(path, strings.NewReader(testToken))
	if code := a.run([]string{"login", "--with-token", "--hub", hub.URL}); code != exitOK {
		t.Fatalf("login: %d %s", code, a.err.String())
	}
	if code := a.run([]string{"chat", "--task", "PAY-12"}); code != exitUsage {
		t.Fatalf("chat: %d %s", code, a.err.String())
	}
	m := <-got
	if m["op"] != "session.create" || m["projectId"] != "p-pay" || m["taskId"] != "t-12" || m["noRecord"] != false {
		t.Fatalf("session.create = %v", m)
	}
	if !strings.Contains(a.err.String(), "gắn phiên với task PAY-12: Sửa lỗi đăng nhập") {
		t.Fatalf("stderr = %q", a.err.String())
	}
}
