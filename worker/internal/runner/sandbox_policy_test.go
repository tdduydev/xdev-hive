package runner

import (
	"bufio"
	"context"
	"crypto/sha256"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSandboxProxyUsesPerRunSnapshotAndCleansUp(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("quyền socket Unix")
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "allowed") }))
	defer upstream.Close()
	destination := strings.TrimPrefix(upstream.URL, "http://")
	dataDir := t.TempDir()
	r := Runner{DataDir: dataDir, Sandbox: &SandboxConfig{WorkerBinary: "/bin/worker", EgressSocket: "/shared.sock"}}
	policy := &SandboxJobConfig{Allowlist: []string{destination}, Image: EnvironmentImage{BaseImage: "node:24", SetupScriptHash: strings.Repeat("a", 64)}}
	allowed, closeAllowed, err := r.prepareSandboxPolicy(context.Background(), policy)
	if err != nil {
		t.Fatal(err)
	}
	defer closeAllowed()
	denied, closeDenied, err := r.prepareSandboxPolicy(context.Background(), &SandboxJobConfig{Allowlist: []string{}, Image: policy.Image})
	if err != nil {
		t.Fatal(err)
	}
	defer closeDenied()
	if allowed.EgressSocket == denied.EgressSocket || r.Sandbox.EgressSocket != "/shared.sock" {
		t.Fatal("không được dùng socket chung hoặc đổi config host")
	}
	if info, err := os.Stat(allowed.EgressSocket); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("quyền socket: %v %v", info, err)
	}
	request := func(socket string) int {
		t.Helper()
		cwd, _ := os.Getwd()
		path, _ := filepath.Rel(cwd, socket)
		conn, err := net.Dial("unix", path)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		fmt.Fprintf(conn, "GET %s/ HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", upstream.URL, destination)
		response, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		return response.StatusCode
	}
	if request(allowed.EgressSocket) != 200 || request(denied.EgressSocket) != 403 {
		t.Fatal("mỗi proxy phải dùng snapshot riêng")
	}
	closeAllowed()
	closeAllowed()
	if _, err := os.Stat(allowed.EgressSocket); !os.IsNotExist(err) {
		t.Fatalf("socket chưa dọn: %v", err)
	}
	if request(denied.EgressSocket) != 403 {
		t.Fatal("dọn một run không được đóng proxy của run khác")
	}
}

func TestSandboxProxyCancellationClosesSocket(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("quyền socket Unix")
	}
	ctx, cancel := context.WithCancel(context.Background())
	r := Runner{DataDir: t.TempDir(), Sandbox: &SandboxConfig{WorkerBinary: "/bin/worker"}}
	config, cleanup, err := r.prepareSandboxPolicy(ctx, &SandboxJobConfig{Allowlist: []string{}, Image: EnvironmentImage{BaseImage: "node:24", SetupScriptHash: strings.Repeat("a", 64)}})
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	cleanup()
	if _, err := os.Stat(config.EgressSocket); !os.IsNotExist(err) {
		t.Fatalf("socket chưa dọn khi huỷ: %v", err)
	}
}

func TestSandboxPolicyFailsClosed(t *testing.T) {
	policy := &SandboxJobConfig{Allowlist: []string{}, Image: EnvironmentImage{BaseImage: "node:24", SetupScriptHash: strings.Repeat("a", 64)}}
	if _, _, err := (Runner{}).prepareSandboxPolicy(context.Background(), policy); err == nil {
		t.Fatal("worker không được nhận policy sandbox")
	}
	if _, _, err := (Runner{Sandbox: &SandboxConfig{}}).prepareSandboxPolicy(context.Background(), policy); err == nil {
		t.Fatal("không chạy khi thiếu binary relay")
	}
	for _, allowlist := range [][]string{nil, {""}, {"a.com#comment"}, {"a.com\n127.0.0.1"}, {"a.com:0"}} {
		invalid := *policy
		invalid.Allowlist = allowlist
		if err := invalid.Validate(); err == nil {
			t.Fatalf("policy không hợp lệ: %q", allowlist)
		}
	}
}

func TestSandboxSetupVerifiesSnapshotHash(t *testing.T) {
	work := t.TempDir()
	emptyHash := fmt.Sprintf("%x", sha256.Sum256(nil))
	if command, err := verifySandboxSetup(work, emptyHash); err != nil || command != "" {
		t.Fatalf("không setup: %q %v", command, err)
	}
	if err := os.MkdirAll(filepath.Join(work, ".hive"), 0o700); err != nil {
		t.Fatal(err)
	}
	content := []byte("echo prepare\n")
	if err := os.WriteFile(filepath.Join(work, ".hive", "setup.sh"), content, 0o600); err != nil {
		t.Fatal(err)
	}
	hash := fmt.Sprintf("%x", sha256.Sum256(content))
	if command, err := verifySandboxSetup(work, hash); err != nil || command != "sh .hive/setup.sh" {
		t.Fatalf("setup: %q %v", command, err)
	}
	if _, err := verifySandboxSetup(work, emptyHash); err == nil {
		t.Fatal("script đổi phải bị từ chối")
	}
}

func TestSandboxJobCannotRunOnDevelopmentRunner(t *testing.T) {
	job := Job{Execution: "sandbox", SandboxPolicy: &SandboxJobConfig{}}
	err := (Runner{}).Run(context.Background(), job, SinkFunc(func(Event) error { return nil }))
	if err == nil || !strings.Contains(err.Error(), "runner host") {
		t.Fatalf("phải từ chối trước khi chuẩn bị worktree: %v", err)
	}
}

func TestSandboxSetupRejectsSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink cần quyền đặc biệt trên Windows")
	}
	work := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(work, ".hive")); err != nil {
		t.Fatal(err)
	}
	if _, err := verifySandboxSetup(work, fmt.Sprintf("%x", sha256.Sum256(nil))); err == nil {
		t.Fatal("không theo symlink setup ra khỏi worktree")
	}
}
