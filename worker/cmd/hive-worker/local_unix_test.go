//go:build !windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
)

func TestStartLocalIPC(t *testing.T) {
	dir, err := os.MkdirTemp("", "hw")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	path := filepath.Join(dir, "run", "hive.sock")
	t.Setenv(localipc.PathEnv, path)
	stop, _ := startLocalIPC(nil, filepath.Join(dir, "terminal"))
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
