package main

import (
	"net"
	"strings"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/runlogs"
)

func TestRunLogsIPC(t *testing.T) {
	s := runlogs.Store{Dir: t.TempDir()}
	f, err := s.Open(runlogs.Entry{RunID: "run-1", Attempt: 2, RetentionDays: 30})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.WriteString(strings.Repeat("a", 50000))
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	srv, cli := localipc.NewConn(a), localipc.NewConn(b)
	go func() {
		for {
			req, err := srv.ReadRequest()
			if err != nil {
				return
			}
			if handleRunLogs(s, srv, req) != nil {
				return
			}
		}
	}()
	var list runlogs.ListPage
	if err := cli.Call(map[string]any{"op": "runs.list"}, &list); err != nil || len(list.Runs) != 1 {
		t.Fatalf("list: %+v %v", list, err)
	}
	var page runlogs.Page
	if err := cli.Call(map[string]any{"op": "runs.log.read", "runId": "run-1", "limit": 999999}, &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Bytes) != runlogs.MaxRead || page.Attempt != 2 {
		t.Fatalf("page: %d, %d", len(page.Bytes), page.Attempt)
	}
	if err := cli.Call(map[string]any{"op": "runs.log.read", "runId": "../escape"}, &page); err == nil {
		t.Fatal("nhận mã vượt thư mục")
	}
	if err := cli.Call(map[string]any{"op": "runs.list", "offset": -1}, &list); err == nil {
		t.Fatal("nhận offset âm")
	}
}
