package accounts

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestClaudePrintUsesProfileLogin(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "acc", "claude-2")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, tokenFile), []byte("sk-ant-oat-test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	savedLook, savedRun := lookPath, runCLI
	t.Cleanup(func() { lookPath, runCLI = savedLook, savedRun })
	lookPath = func(name string) (string, error) { return "/opt/bin/" + name, nil }
	var gotEnv map[string]string
	var gotArgs []string
	runCLI = func(_ context.Context, name string, args []string, env map[string]string) ([]byte, error) {
		gotArgs, gotEnv = args, env
		return []byte("ok"), nil
	}
	out, err := ClaudePrint(context.Background(), home, "~/acc/claude-2", []string{"-p", "/context"})
	if err != nil || string(out) != "ok" {
		t.Fatalf("%q, %v", out, err)
	}
	if !reflect.DeepEqual(gotArgs, []string{"-p", "/context"}) || gotEnv["CLAUDE_CONFIG_DIR"] != dir ||
		gotEnv[tokenEnv] != "sk-ant-oat-test" {
		t.Errorf("args %v, env %v", gotArgs, gotEnv)
	}
	if _, err := ClaudePrint(context.Background(), home, "", nil); err != nil || gotEnv != nil {
		t.Errorf("gói mặc định không đặt env: %v, %v", gotEnv, err)
	}
}
