package runner

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/accounts"
)

func writeAccounts(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "accounts.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func logText(events []Event) string {
	var b strings.Builder
	for _, e := range events {
		if e.Type == "log" {
			b.Write(e.Data)
		}
	}
	return b.String()
}

// CLI chạy bằng thư mục đăng nhập của tài khoản đã giữ, và log ghi tên tài khoản cho người xem run.
func TestRunnerUsesAccountConfigDir(t *testing.T) {
	remote, base := makeRemote(t)
	dir := t.TempDir()
	pool := accounts.NewPool(writeAccounts(t, `{"accounts":[{"id":"codex-3","label":"duy@xdev.asia","cli":"codex","configDir":"`+dir+`","enabled":true,"maxConcurrent":1}]}`))
	lease, err := pool.Acquire("codex")
	if err != nil || lease == nil {
		t.Fatalf("acquire = %v, %v", lease, err)
	}
	defer lease.Release()
	var events []Event
	r := Runner{DataDir: t.TempDir(), CLICommands: fakeCommands("account"), Account: lease}
	err = r.Run(context.Background(), Job{RunID: "acc", Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/acc", CLI: "codex", Prompt: "p", Timeout: 5 * time.Second, Env: map[string]string{"HIVE_RUNNER_HELPER": "1", "HIVE_FAKE_MODE": "account", "CODEX_HOME": "/hub/khong/doi/duoc"}}, SinkFunc(func(e Event) error { events = append(events, e); return nil }))
	if err != nil {
		t.Fatal(err)
	}
	log := logText(events)
	if !strings.Contains(log, "CODEX_HOME="+dir) {
		t.Fatalf("CLI không nhận thư mục của tài khoản: %q", log)
	}
	if !strings.Contains(log, "chạy bằng tài khoản duy@xdev.asia") {
		t.Fatalf("log thiếu tên tài khoản: %q", log)
	}
}

// CLI báo hết lượt dùng và run hỏng: tài khoản nghỉ, lần chọn sau không còn tài khoản rảnh.
func TestRunnerCoolsDownAccountOnUsageLimit(t *testing.T) {
	remote, base := makeRemote(t)
	pool := accounts.NewPool(writeAccounts(t, `{"accounts":[{"id":"codex-3","cli":"codex","enabled":true,"maxConcurrent":1,"cooldownMinutes":30}]}`))
	lease, err := pool.Acquire("codex")
	if err != nil {
		t.Fatal(err)
	}
	r := Runner{DataDir: t.TempDir(), CLICommands: fakeCommands("limit"), Account: lease}
	_ = r.Run(context.Background(), Job{RunID: "lim", Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/lim", CLI: "codex", Prompt: "p", Timeout: 5 * time.Second, Env: map[string]string{"HIVE_RUNNER_HELPER": "1", "HIVE_FAKE_MODE": "limit"}}, SinkFunc(func(Event) error { return nil }))
	lease.Release()
	if _, err := pool.Acquire("codex"); !errors.Is(err, accounts.ErrBusy) {
		t.Fatalf("tài khoản hết lượt vẫn được chọn: %v", err)
	}
}
