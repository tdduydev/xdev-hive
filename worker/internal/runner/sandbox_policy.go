package runner

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/tdduydev/xdev-hive/worker/internal/egress"
)

// SandboxJobConfig mirrors the shared zod schema in packages/contracts/src/sandbox.ts.
type SandboxJobConfig struct {
	Allowlist []string         `json:"allowlist"`
	Image     EnvironmentImage `json:"image"`
}

type EnvironmentImage struct {
	BaseImage       string `json:"baseImage"`
	SetupScriptHash string `json:"setupScriptHash"`
}

var imagePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,511}$`)
var setupHashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func (s SandboxJobConfig) Validate() error {
	if s.Allowlist == nil || !imagePattern.MatchString(s.Image.BaseImage) || !setupHashPattern.MatchString(s.Image.SetupScriptHash) {
		return fmt.Errorf("snapshot sandbox thiếu allowlist hoặc image/hash hợp lệ")
	}
	for _, rule := range s.Allowlist {
		if len(rule) > 1024 || strings.TrimSpace(rule) == "" || strings.ContainsAny(rule, "\r\n#") {
			return fmt.Errorf("mục allowlist không hợp lệ")
		}
	}
	_, err := egress.Parse(strings.NewReader(strings.Join(s.Allowlist, "\n")))
	return err
}

// Each run gets a private socket; a host-wide socket could apply another project's policy.
func (r Runner) prepareSandboxPolicy(ctx context.Context, policy *SandboxJobConfig) (SandboxConfig, func(), error) {
	if r.Sandbox == nil {
		return SandboxConfig{}, nil, fmt.Errorf("job sandbox không được chạy trên worker máy dev")
	}
	if err := policy.Validate(); err != nil {
		return SandboxConfig{}, nil, err
	}
	config := r.Sandbox.normalized()
	if config.WorkerBinary == "" {
		return SandboxConfig{}, nil, fmt.Errorf("runner host thiếu binary cho relay egress")
	}
	list, err := egress.Parse(strings.NewReader(strings.Join(policy.Allowlist, "\n")))
	if err != nil {
		return SandboxConfig{}, nil, err
	}
	proxy, err := egress.New(egress.Config{Allowlist: list})
	if err != nil {
		return SandboxConfig{}, nil, err
	}
	dir, err := os.MkdirTemp(r.DataDir, "eg-")
	if err != nil {
		return SandboxConfig{}, nil, err
	}
	config.EgressSocket = filepath.Join(dir, "p.sock")
	config.EgressSocket, err = filepath.Abs(config.EgressSocket)
	if err != nil {
		_ = os.RemoveAll(dir)
		return SandboxConfig{}, nil, err
	}
	// Relative paths avoid Unix's sun_path limit when the data directory lies under a long workspace path.
	listenPath := config.EgressSocket
	if cwd, err := os.Getwd(); err == nil {
		if relative, err := filepath.Rel(cwd, listenPath); err == nil && len(relative) < len(listenPath) {
			listenPath = relative
		}
	}
	listeners, err := egress.Listen("", listenPath)
	if err != nil {
		_ = os.RemoveAll(dir)
		return SandboxConfig{}, nil, err
	}
	proxyCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = proxy.Serve(proxyCtx, listeners...)
	}()
	var once sync.Once
	cleanup := func() {
		once.Do(func() { cancel(); <-done; _ = os.RemoveAll(dir) })
	}
	return config, cleanup, nil
}

// Verify the checkout rather than executing a setup script that changed since the hub recorded its hash.
func verifySandboxSetup(work, expectedHash string) (string, error) {
	setupDir := filepath.Join(work, ".hive")
	if info, err := os.Lstat(setupDir); err == nil && !info.IsDir() {
		return "", fmt.Errorf("thư mục setup phải nằm trong worktree")
	} else if err != nil && !os.IsNotExist(err) {
		return "", fmt.Errorf("không đọc được thư mục setup: %w", err)
	}
	path := filepath.Join(setupDir, "setup.sh")
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return "", fmt.Errorf("script setup phải là file thường trong worktree")
	} else if err != nil && !os.IsNotExist(err) {
		return "", fmt.Errorf("không đọc được script setup: %w", err)
	}
	content, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return "", fmt.Errorf("không đọc được script setup: %w", err)
	}
	digest := fmt.Sprintf("%x", sha256.Sum256(content))
	if digest != expectedHash {
		return "", fmt.Errorf("hash script setup không khớp image môi trường của dự án")
	}
	if len(content) == 0 {
		return "", nil
	}
	return "sh .hive/setup.sh", nil
}
