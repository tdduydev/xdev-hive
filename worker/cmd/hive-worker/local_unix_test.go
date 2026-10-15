//go:build !windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/channel"
	"github.com/tdduydev/xdev-hive/worker/internal/config"
	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/version"
)

func TestStartLocalIPC(t *testing.T) {
	dir, err := os.MkdirTemp("", "hw")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	path := filepath.Join(dir, "run", "hive.sock")
	t.Setenv(localipc.PathEnv, path)
	stop, _ := startLocalIPC(nil, filepath.Join(dir, "terminal"), nil, nil)
	c, h, err := localipc.Dial(path, "hive/test")
	if err != nil {
		t.Fatal(err)
	}
	if h.V != localipc.Version || h.Worker == "" {
		t.Fatalf("hello = %+v", h)
	}
	var list struct {
		Sessions []any `json:"sessions"`
	}
	if err := c.Call(map[string]string{"op": "session.list"}, &list); err != nil || len(list.Sessions) != 0 {
		t.Fatalf("list: %+v %v", list, err)
	}
	_ = c.Close()
	stop()
	if _, _, err := localipc.Dial(path, "hive/test"); !errors.Is(err, localipc.ErrNotRunning) {
		t.Fatalf("sau khi dừng: %v", err)
	}
}

type statusReply struct {
	State        string `json:"state"`
	HubConnected bool   `json:"hubConnected"`
	Registered   bool   `json:"registered"`
	MachineID    string `json:"machineId"`
	Version      string `json:"version"`
	Runs         int    `json:"runs"`
	Owner        string `json:"owner"`
}

func TestWorkerStatusOp(t *testing.T) {
	dir, err := os.MkdirTemp("", "hw")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	path := filepath.Join(dir, "run", "hive.sock")
	t.Setenv(localipc.PathEnv, path)
	status := newWorkerStatus(config.Config{MachineID: "may-1", MachineToken: "hwm_x"}, ownerVSCode, dir)
	stop, _ := startLocalIPC(nil, filepath.Join(dir, "terminal"), nil, status)
	t.Cleanup(stop)
	c, _, err := localipc.Dial(path, "vscode/test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	ask := func() statusReply {
		t.Helper()
		var got statusReply
		if err := c.Call(map[string]string{"op": "worker.status"}, &got); err != nil {
			t.Fatal(err)
		}
		return got
	}

	got := ask()
	want := statusReply{State: "starting", Registered: true, MachineID: "may-1", Version: version.Version, Owner: "vscode"}
	if got != want {
		t.Fatalf("trước khi nối hub: %+v, muốn %+v", got, want)
	}

	var seen []string
	observe := status.observe(func(s channel.Status) { seen = append(seen, s.State) })
	observe(channel.Status{State: "online"})
	// Hai marker là hai run đang chạy; file không phải .json (marker đang ghi dở) không tính.
	active := filepath.Join(dir, "xdev-hive", "worker", "active")
	if err := os.MkdirAll(active, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"a.json", "b.json", "c.tmp"} {
		if err := os.WriteFile(filepath.Join(active, name), []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	got = ask()
	if got.State != "online" || !got.HubConnected || got.Runs != 2 {
		t.Fatalf("khi đang online: %+v", got)
	}
	observe(channel.Status{State: "disconnected", Error: "mất mạng"})
	if got = ask(); got.State != "disconnected" || got.HubConnected {
		t.Fatalf("khi mất kết nối: %+v", got)
	}
	if len(seen) != 2 {
		t.Fatalf("callback phía sau không được gọi: %v", seen)
	}
	// Op khác vẫn đi tới terminal.Local trên cùng kết nối.
	var list struct {
		Sessions []any `json:"sessions"`
	}
	if err := c.Call(map[string]string{"op": "session.list"}, &list); err != nil {
		t.Fatalf("session.list sau worker.status: %v", err)
	}
}

func TestWorkerStatusUnregistered(t *testing.T) {
	status := newWorkerStatus(config.Config{MachineID: "may-1"}, ownerCLI, t.TempDir())
	if status.registered {
		t.Fatal("máy chưa có token mà vẫn báo đã đăng ký")
	}
}

func TestRunRejectsUnknownOwner(t *testing.T) {
	if code := run([]string{"--owner", "ai-do"}); code != 2 {
		t.Fatalf("mã thoát = %d, muốn 2", code)
	}
	for _, o := range []string{"desktop", "vscode", "cli"} {
		if !validOwner(o) {
			t.Errorf("%s bị từ chối", o)
		}
	}
}
