package runner

import (
	"context"
	"encoding/json"
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

// codexLogin là thư mục cấu hình Codex đã đăng nhập: worker không giao run cho tài khoản chưa đăng nhập.
func codexLogin(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), []byte(`{"tokens":{"id_token":"h.e30.s"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
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
	dir := codexLogin(t)
	quoted, _ := json.Marshal(dir) // đường dẫn Windows có dấu \ phải được escape trong JSON
	pool := accounts.NewPool(writeAccounts(t, `{"accounts":[{"id":"codex-3","label":"duy@example.com","cli":"codex","configDir":`+string(quoted)+`,"enabled":true,"maxConcurrent":1}]}`))
	lease, err := pool.Acquire("codex", accounts.RoleImplement)
	if err != nil || lease == nil {
		t.Fatalf("acquire = %v, %v", lease, err)
	}
	defer lease.Release()
	var events []Event
	r := Runner{DataDir: t.TempDir(), CLICommands: fakeCommands("account"), Account: lease}
	err = r.Run(context.Background(), Job{RunID: "acc", Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/acc", CLI: "codex", Prompt: "p", Timeout: 30 * time.Second, Env: map[string]string{"HIVE_RUNNER_HELPER": "1", "HIVE_FAKE_MODE": "account", "CODEX_HOME": "/hub/khong/doi/duoc"}}, SinkFunc(func(e Event) error { events = append(events, e); return nil }))
	if err != nil {
		t.Fatal(err)
	}
	log := logText(events)
	if !strings.Contains(log, "CODEX_HOME="+dir) {
		t.Fatalf("CLI không nhận thư mục của tài khoản: %q", log)
	}
	if !strings.Contains(log, "chạy bằng tài khoản duy@example.com") {
		t.Fatalf("log thiếu tên tài khoản: %q", log)
	}
}

// Worker chạy từ shell của một gói khác (CODEX_HOME của gói đó): run trên gói đăng nhập mặc định không được dùng tài
// khoản của gói kia.
func TestRunnerDefaultAccountDropsInheritedLogin(t *testing.T) {
	remote, base := makeRemote(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	if err := os.MkdirAll(filepath.Join(home, ".codex"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".codex", "auth.json"), []byte(`{"tokens":{"id_token":"h.e30.s"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_HOME", codexLogin(t))
	pool := accounts.NewPool(writeAccounts(t, `{"accounts":[{"id":"codex-1","cli":"codex","enabled":true,"maxConcurrent":1}]}`))
	lease, err := pool.Acquire("codex", accounts.RoleImplement)
	if err != nil || lease == nil {
		t.Fatalf("acquire = %v, %v", lease, err)
	}
	defer lease.Release()
	var events []Event
	r := Runner{DataDir: t.TempDir(), CLICommands: fakeCommands("account"), Account: lease}
	err = r.Run(context.Background(), Job{RunID: "def", Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/def", CLI: "codex", Prompt: "p", Timeout: 30 * time.Second, Env: map[string]string{"HIVE_RUNNER_HELPER": "1", "HIVE_FAKE_MODE": "account"}}, SinkFunc(func(e Event) error { events = append(events, e); return nil }))
	if err != nil {
		t.Fatal(err)
	}
	if log := logText(events); !strings.Contains(log, "CODEX_HOME=\n") {
		t.Fatalf("CLI vẫn nhận CODEX_HOME kế thừa: %q", log)
	}
}

// CLI báo hết lượt dùng và run hỏng: tài khoản nghỉ, lần chọn sau không còn tài khoản rảnh.
func TestRunnerCoolsDownAccountOnUsageLimit(t *testing.T) {
	remote, base := makeRemote(t)
	quoted, _ := json.Marshal(codexLogin(t))
	pool := accounts.NewPool(writeAccounts(t, `{"accounts":[{"id":"codex-3","cli":"codex","configDir":`+string(quoted)+`,"enabled":true,"maxConcurrent":1,"cooldownMinutes":30}]}`))
	lease, err := pool.Acquire("codex", accounts.RoleImplement)
	if err != nil {
		t.Fatal(err)
	}
	r := Runner{DataDir: t.TempDir(), CLICommands: fakeCommands("limit"), Account: lease}
	_ = r.Run(context.Background(), Job{RunID: "lim", Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/lim", CLI: "codex", Prompt: "p", Timeout: 30 * time.Second, Env: map[string]string{"HIVE_RUNNER_HELPER": "1", "HIVE_FAKE_MODE": "limit"}}, SinkFunc(func(Event) error { return nil }))
	lease.Release()
	if _, err := pool.Acquire("codex", accounts.RoleImplement); !errors.Is(err, accounts.ErrBusy) {
		t.Fatalf("tài khoản hết lượt vẫn được chọn: %v", err)
	}
}
