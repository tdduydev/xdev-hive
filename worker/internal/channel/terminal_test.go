//go:build !windows

package channel

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/runner"
)

const termID = "0a0a0a0a-0000-4000-8000-0000000000a1"

func termConfig(t *testing.T, url string) Config {
	cfg := testConfig(t, url)
	cfg.CLIs = []string{"claude"}
	cfg.CLICommands = map[string]runner.Command{"claude": {Path: "/bin/sh"}}
	return cfg
}

func termOpenMsg(remote, base string) map[string]any {
	return map[string]any{"type": "term_open", "sessionId": termID, "projectId": "0a0a0a0a-0000-4000-8000-000000000003", "mode": "propose", "cols": 80, "rows": 24, "cli": "claude", "repoUrl": fileURL(remote), "baseBranch": base, "projectKey": "WEB", "model": "sonnet", "runPermissions": "workspace", "fullAllowed": false, "mcpToken": "tok-SECRET-123456", "systemPrompt": "Leader", "tokenSaving": map[string]any{"enabled": true}}
}

// Đầu-cuối với hub giả: máy dùng chung khai capability terminal, term_open → term_opened → gõ phím → term_output →
// term_close → term_exit closed, worktree tạm đã xoá.
func TestTerminalSessionOverChannel(t *testing.T) {
	remote, base := makeRemote(t)
	srv, hellos, conns, msgs := fakeAccountsHub(t, []string{"shared"})
	defer srv.Close()
	cfg := termConfig(t, srv.URL)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = cfg.Run(ctx) }()
	if hello := <-hellos; !slices.Contains(hello.Capabilities, "terminal") {
		t.Fatalf("capabilities = %v", hello.Capabilities)
	}
	conn := <-conns
	send(t, conn, termOpenMsg(remote, base))
	opened := expect(t, msgs, "term_opened", "")
	if opened["sessionId"] != termID || opened["permissions"] != "workspace" || opened["accountLabel"] != nil {
		t.Fatalf("term_opened = %v", opened)
	}
	if _, ok := opened["accountLabel"]; !ok {
		t.Fatal("term_opened thiếu accountLabel (phải là null)")
	}
	send(t, conn, map[string]any{"type": "term_resize", "sessionId": termID, "cols": 100, "rows": 30})
	send(t, conn, map[string]any{"type": "term_input", "sessionId": termID, "data": base64.StdEncoding.EncodeToString([]byte("echo hi-$((40+2)); stty size\r"))})
	var out strings.Builder
	var next float64
	deadline := time.After(waitFor)
	for !strings.Contains(out.String(), "hi-42") || !strings.Contains(out.String(), "30 100") {
		select {
		case m := <-msgs:
			if m["type"] != "term_output" {
				continue
			}
			if m["seq"] != next {
				t.Fatalf("seq = %v, muốn %v", m["seq"], next)
			}
			next++
			b, err := base64.StdEncoding.DecodeString(m["data"].(string))
			if err != nil {
				t.Fatal(err)
			}
			out.Write(b)
		case <-deadline:
			t.Fatalf("không nhận output; có %q", out.String())
		}
	}
	work := filepath.Join(cfg.DataDir, "terminals", termID)
	if _, err := os.Stat(work); err != nil {
		t.Fatalf("worktree tạm: %v", err)
	}
	send(t, conn, map[string]any{"type": "term_close", "sessionId": termID, "reason": "Người mở đã đóng phiên."})
	exit := expect(t, msgs, "term_exit", "")
	if exit["reason"] != "closed" || exit["exitCode"] != nil {
		t.Fatalf("term_exit = %v", exit)
	}
	if _, err := os.Stat(work); !os.IsNotExist(err) {
		t.Fatal("worktree chưa xoá sau term_close")
	}
}

// Hub chưa báo máy dùng chung: từ chối, không clone hay chạy gì.
func TestTerminalDeniedOnPersonalMachine(t *testing.T) {
	remote, base := makeRemote(t)
	srv, hellos, conns, msgs := fakeAccountsHub(t, nil)
	defer srv.Close()
	cfg := termConfig(t, srv.URL)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = cfg.Run(ctx) }()
	<-hellos
	conn := <-conns
	send(t, conn, termOpenMsg(remote, base))
	exit := expect(t, msgs, "term_exit", "")
	if exit["reason"] != "denied" || exit["message"] != msgTerminalNotShared {
		t.Fatalf("term_exit = %v", exit)
	}
	if _, err := os.Stat(filepath.Join(cfg.DataDir, "terminals")); !os.IsNotExist(err) {
		t.Fatal("máy cá nhân vẫn tạo worktree terminal")
	}
}

// Mất kết nối hub thì đóng mọi phiên; khởi động lại thì dọn worktree còn sót.
func TestTerminalClosedOnDisconnectAndReapedOnStart(t *testing.T) {
	remote, base := makeRemote(t)
	srv, hellos, conns, msgs := fakeAccountsHub(t, []string{"shared"})
	defer srv.Close()
	cfg := termConfig(t, srv.URL)
	cfg.MaxBackoff = time.Hour
	cfg.MinBackoff = time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = cfg.Run(ctx) }()
	<-hellos
	conn := <-conns
	send(t, conn, termOpenMsg(remote, base))
	expect(t, msgs, "term_opened", "")
	work := filepath.Join(cfg.DataDir, "terminals", termID)
	_ = conn.CloseNow()
	eventually(t, "phiên đóng và worktree xoá khi mất kết nối", func() bool {
		_, err := os.Stat(work)
		return os.IsNotExist(err)
	})

	stale := filepath.Join(t.TempDir(), "data")
	if err := os.MkdirAll(filepath.Join(stale, "terminals", "cu"), 0o700); err != nil {
		t.Fatal(err)
	}
	cfg2 := termConfig(t, srv.URL)
	cfg2.DataDir = stale
	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	go func() { _ = cfg2.Run(ctx2) }()
	<-hellos
	<-conns
	eventually(t, "dọn terminals/ lúc khởi động", func() bool {
		entries, _ := os.ReadDir(filepath.Join(stale, "terminals"))
		return len(entries) == 0
	})
}
