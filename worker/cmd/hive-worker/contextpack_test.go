package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/runner"
)

func contextPackRepo(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", home)
	t.Setenv("XDG_CACHE_HOME", home)
	t.Setenv("LOCALAPPDATA", home)
	t.Setenv("HIVE_WORKER_CODEGRAPH", "off")
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(home, "no-gitconfig"))
	dir := filepath.Join(t.TempDir(), "repo có khoảng trắng")
	git := func(args ...string) {
		t.Helper()
		out, err := exec.Command("git", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	git("init", "-q", dir)
	files := map[string]string{
		"auth/login.go": "package auth\n\nfunc LoginHandler() error { return nil }\n",
		"misc/noise.go": "package misc\n\nfunc Noise() {}\n",
		"go.sum":        "LoginHandler\n",
		"go.mod":        "module example.invalid/offline\n",
	}
	for name, text := range files {
		file := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	git("-C", dir, "add", ".")
	// Không có commit, tài khoản hay remote truy cập được: pack vẫn phải dựng được hoàn toàn tại máy.
	git("-C", dir, "remote", "add", "origin", "https://offline.invalid/repo.git")
	return dir
}

func runContextPack(t *testing.T, dir, query string, extra ...string) runner.LocalContextPack {
	t.Helper()
	args := append([]string{"--json", "--cwd", dir, "--query", query}, extra...)
	var out, stderr bytes.Buffer
	if code := contextPackCommand(args, &out, &stderr); code != 0 || stderr.Len() != 0 {
		t.Fatalf("mã thoát %d, stderr: %s", code, stderr.String())
	}
	var pack runner.LocalContextPack
	if err := json.Unmarshal(out.Bytes(), &pack); err != nil {
		t.Fatalf("JSON không hợp lệ: %v: %s", err, out.String())
	}
	if pack.Files == nil {
		t.Fatal("files phải là mảng JSON, kể cả khi rỗng")
	}
	for _, file := range pack.Files {
		if !strings.Contains(pack.Markdown, "- `"+file+"`") {
			t.Fatalf("file %q không có trong Markdown: %s", file, pack.Markdown)
		}
	}
	return pack
}

type contextPackNoNetwork struct{ calls int }

func (n *contextPackNoNetwork) RoundTrip(*http.Request) (*http.Response, error) {
	n.calls++
	return nil, errors.New("test không cho phép gọi mạng")
}

func TestContextPackOfflineFromSubdirectory(t *testing.T) {
	dir := contextPackRepo(t)
	t.Setenv("HIVE_HUB_URL", "https://offline.invalid")
	network := &contextPackNoNetwork{}
	previous := http.DefaultTransport
	http.DefaultTransport = network
	t.Cleanup(func() { http.DefaultTransport = previous })
	pack := runContextPack(t, filepath.Join(dir, "auth"), "Sửa LoginHandler trong auth/login.go")
	if !reflect.DeepEqual(pack.Files, []string{"auth/login.go"}) {
		t.Fatalf("file liên quan = %v", pack.Files)
	}
	if !strings.Contains(pack.Markdown, "LoginHandler() error") || !strings.Contains(pack.Markdown, "go test ./...") || pack.Tokens <= 0 || pack.Tokens > 4000 {
		t.Fatalf("pack không đủ nội dung: %+v", pack)
	}
	if network.calls != 0 {
		t.Fatalf("đã gọi mạng %d lần", network.calls)
	}
	var out, stderr bytes.Buffer
	if code := contextPackCommand([]string{"--cwd", dir, "--query", "Sửa LoginHandler trong auth/login.go"}, &out, &stderr); code != 0 || out.String() != pack.Markdown {
		t.Fatalf("Markdown: mã %d, stderr %s, stdout %s", code, stderr.String(), out.String())
	}
}

func TestContextPackEmptyAndSmallBudget(t *testing.T) {
	dir := contextPackRepo(t)
	for _, tc := range []struct {
		name, query string
		extra       []string
	}{
		{name: "không có từ khoá", query: "sửa lỗi giúp"},
		{name: "không khớp", query: "UnknownHandler"},
		{name: "ngân sách nhỏ", query: "LoginHandler", extra: []string{"--budget", "1"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pack := runContextPack(t, dir, tc.query, tc.extra...)
			if pack.Markdown != "" || len(pack.Files) != 0 || pack.Tokens != 0 {
				t.Fatalf("cần pack rỗng: %+v", pack)
			}
		})
	}
}

func TestContextPackBudgetKeepsMarkdownAndFilesConsistent(t *testing.T) {
	dir := contextPackRepo(t)
	for i := range 10 {
		file := filepath.Join(dir, fmt.Sprintf("login_%02d.go", i))
		if err := os.WriteFile(file, []byte(fmt.Sprintf("package app\n// LoginHandler dùng hàm này.\nfunc Handle%02d() {}\n", i)), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if out, err := exec.Command("git", "-C", dir, "add", ".").CombinedOutput(); err != nil {
		t.Fatalf("git add: %v: %s", err, out)
	}
	full := runContextPack(t, dir, "LoginHandler")
	limited := runContextPack(t, dir, "LoginHandler", "--budget", "250")
	if len(limited.Files) == 0 || len(limited.Files) >= len(full.Files) || limited.Tokens <= 0 || limited.Tokens > 250 {
		t.Fatalf("không áp dụng ngân sách: đầy đủ %+v, giới hạn %+v", full, limited)
	}
	fileSection, _, _ := strings.Cut(limited.Markdown, "## Lệnh build/test")
	if lines := strings.Count(fileSection, "\n- `"); lines != len(limited.Files) {
		t.Fatalf("Markdown và files không khớp: %+v", limited)
	}
	large := runContextPack(t, dir, "LoginHandler", "--budget", fmt.Sprint(int(^uint(0)>>1)))
	if !reflect.DeepEqual(large, full) {
		t.Fatal("ngân sách lớn phải giữ giới hạn sẵn có của runner")
	}
}

func TestContextPackInvalidArguments(t *testing.T) {
	for _, args := range [][]string{
		{}, {"--json"}, {"--cwd", "."}, {"--query", "LoginHandler"},
		{"--cwd", ".", "--query", " "},
		{"--cwd", ".", "--query", "LoginHandler", "--budget", "0"},
		{"--cwd", ".", "--query", "LoginHandler", "--budget", "-1"},
		{"--budget", "abc"}, {"--budget"}, {"--unknown"},
		{"--cwd", ".", "--query", "LoginHandler", "thừa"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			var out, stderr bytes.Buffer
			if code := contextPackCommand(args, &out, &stderr); code != 2 || out.Len() != 0 || !strings.Contains(stderr.String(), contextPackUsage) {
				t.Fatalf("tham số %v: mã %d, stdout %s, stderr %s", args, code, out.String(), stderr.String())
			}
		})
	}
	var out, stderr bytes.Buffer
	if code := contextPackCommand([]string{"--help"}, &out, &stderr); code != 0 || !strings.Contains(stderr.String(), contextPackUsage) {
		t.Fatalf("trợ giúp: mã %d, stderr %s", code, stderr.String())
	}
}

func TestContextPackRejectsInvalidRepo(t *testing.T) {
	dir := contextPackRepo(t)
	for _, cwd := range []string{t.TempDir(), filepath.Join(dir, "missing"), filepath.Join(dir, "go.mod")} {
		var out, stderr bytes.Buffer
		if code := contextPackCommand([]string{"--json", "--cwd", cwd, "--query", "LoginHandler"}, &out, &stderr); code != 1 || out.Len() != 0 || !strings.Contains(stderr.String(), "kho Git") {
			t.Fatalf("cwd %s: mã %d, stdout %s, stderr %s", cwd, code, out.String(), stderr.String())
		}
	}
}

func TestContextPackCancelled(t *testing.T) {
	dir := contextPackRepo(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if pack, err := runner.BuildLocalContextPack(ctx, dir, "LoginHandler", 0); err == nil || pack.Markdown != "" || len(pack.Files) != 0 {
		t.Fatalf("huỷ dựng pack: %+v, %v", pack, err)
	}
}
