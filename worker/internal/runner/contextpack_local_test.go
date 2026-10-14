package runner

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

// localPackEnv giả thư mục nhà và thư mục cache (DataDir của worker) cho hook prompt; CodeGraph tắt trừ khi test bật.
func localPackEnv(t *testing.T) string {
	t.Helper()
	home := localHome(t)
	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
	t.Setenv("LOCALAPPDATA", filepath.Join(home, "AppData", "Local"))
	t.Setenv(CodeGraphEnv, "off")
	return home
}

// writeIn ghi file, tạo thư mục cha.
func writeIn(t *testing.T, dir, name, value string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	mustDir(t, dir, name, value)
}

func promptInput(cwd, prompt string) map[string]any {
	return map[string]any{"hook_event_name": "UserPromptSubmit", "cwd": cwd, "prompt": prompt, "transcript_path": "/tmp/x.jsonl"}
}

func packContext(t *testing.T, reply map[string]any) string {
	t.Helper()
	if reply == nil {
		return ""
	}
	h, _ := reply["hookSpecificOutput"].(map[string]any)
	if h == nil || h["hookEventName"] != "UserPromptSubmit" {
		t.Fatalf("reply = %v", reply)
	}
	s, _ := h["additionalContext"].(string)
	return s
}

func TestLocalPromptPacksFirstPromptOnly(t *testing.T) {
	home := localPackEnv(t)
	repo := packRepo(t)
	mustDir(t, repo, "go.mod", "module x\n")
	// Phiên mở ở thư mục con: pack vẫn tính từ gốc repo.
	sub := filepath.Join(repo, "auth")

	if got := packContext(t, callLocalJSON(t, "prompt", "s1", promptInput(sub, "/model"))); got != "" {
		t.Fatalf("lệnh gạch chéo không được dựng pack: %q", got)
	}
	root, err := filepath.EvalSymlinks(repo)
	if err != nil {
		t.Fatal(err)
	}
	got := packContext(t, callLocalJSON(t, "prompt", "s1", promptInput(sub, "Sửa LoginHandler trong auth/login.go trả 500 khi phiên hết hạn")))
	for _, want := range []string{"`auth/login.go`", "`session/store.go`", "gốc repo `" + root + "`", "## Lệnh build/test"} {
		if !strings.Contains(got, want) {
			t.Fatalf("pack thiếu %q:\n%s", want, got)
		}
	}
	if len(got) > localPackMaxChars {
		t.Fatalf("pack dài %d ký tự", len(got))
	}
	if _, err := os.Stat(filepath.Join(localSession(home, "s1"), localPackMarker)); err != nil {
		t.Fatal(err)
	}

	// Prompt thứ hai của phiên không dựng lại, kể cả khi nhắc file khác.
	if got := callLocalJSON(t, "prompt", "s1", promptInput(sub, "Giờ sửa session/store.go")); got != nil {
		t.Fatalf("prompt thứ hai = %v", got)
	}
	// Phiên mới (hay sau /clear) dựng lại.
	if got := packContext(t, callLocalJSON(t, "prompt", "s2", promptInput(repo, "Sửa LoginHandler"))); !strings.Contains(got, "`auth/login.go`") {
		t.Fatalf("phiên mới:\n%s", got)
	}
}

func TestLocalPromptSkipsCommandsWhenRepoHasClaudeMD(t *testing.T) {
	localPackEnv(t)
	repo := packRepo(t)
	mustDir(t, repo, "go.mod", "module x\n")
	mustDir(t, repo, "CLAUDE.md", "# Lệnh\n")
	got := packContext(t, callLocalJSON(t, "prompt", "s1", promptInput(repo, "Sửa LoginHandler")))
	if !strings.Contains(got, "`auth/login.go`") || strings.Contains(got, "## Lệnh build/test") {
		t.Fatalf("pack:\n%s", got)
	}
}

func TestLocalPromptOutsideGitOrNoTerms(t *testing.T) {
	localPackEnv(t)
	if got := callLocalJSON(t, "prompt", "s1", promptInput(t.TempDir(), "Sửa LoginHandler")); got != nil {
		t.Fatalf("ngoài repo git = %v", got)
	}
	if got := callLocalJSON(t, "prompt", "s2", promptInput(packRepo(t), "sửa lỗi giúp")); got != nil {
		t.Fatalf("không có từ khoá = %v", got)
	}
	if got := callLocalJSON(t, "prompt", "s3", promptInput("relative/dir", "Sửa LoginHandler")); got != nil {
		t.Fatalf("cwd tương đối = %v", got)
	}
}

func TestLocalPromptTimeoutGivesNoContext(t *testing.T) {
	localPackEnv(t)
	repo := packRepo(t)
	old := localPackTimeout
	t.Cleanup(func() { localPackTimeout = old })
	localPackTimeout = time.Nanosecond
	if got := callLocalJSON(t, "prompt", "s1", promptInput(repo, "Sửa LoginHandler")); got != nil {
		t.Fatalf("quá giờ vẫn có pack: %v", got)
	}
}

// fakeCodeGraphSh là codegraph giả: `query` ghi lại thư mục chạy, ngủ HIVE_FAKE_CG_SLEEP giây rồi in JSON trỏ tới
// misc/noise.go, file không nhắc trong prompt.
func fakeCodeGraphSh(t *testing.T) (bin, log string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("codegraph giả là script sh")
	}
	dir := t.TempDir()
	log = filepath.Join(dir, "calls.log")
	bin = filepath.Join(dir, "codegraph")
	script := "#!/bin/sh\n" +
		"echo \"$1 $2 $(pwd)\" >> '" + log + "'\n" +
		"[ \"$1\" = query ] || exit 3\n" +
		"sleep \"${HIVE_FAKE_CG_SLEEP:-0}\"\n" +
		"echo '{\"results\":[{\"name\":\"LoginHandler\",\"file\":\"misc/noise.go\"}]}'\n"
	if err := os.WriteFile(bin, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv(CodeGraphEnv, bin)
	return bin, log
}

func TestLocalPromptSeedsCodeGraphFromWorkerIndex(t *testing.T) {
	localPackEnv(t)
	_, log := fakeCodeGraphSh(t)
	repo := packRepo(t)
	must(t, "git", "-C", repo, "remote", "add", "origin", "git@github.com:acme/app.git")
	cache, err := os.UserCacheDir()
	if err != nil {
		t.Fatal(err)
	}
	// Hub gửi repo URL dạng https; worker đặt tên chỉ mục theo đúng chuỗi đó.
	sum := sha256.Sum256([]byte("https://github.com/acme/app.git"))
	stored := filepath.Join(cache, "xdev-hive", "worker", "codegraph", hex.EncodeToString(sum[:8]))
	writeIn(t, stored, "codegraph.db", "db")
	writeIn(t, stored, ".gitignore", "*\n!.gitignore\n")

	got := packContext(t, callLocalJSON(t, "prompt", "s1", promptInput(repo, "Sửa LoginHandler trả 500")))
	if !strings.Contains(got, "`misc/noise.go` — codegraph: `LoginHandler`") {
		t.Fatalf("pack thiếu kết quả codegraph:\n%s", got)
	}
	if b, err := os.ReadFile(filepath.Join(repo, codegraphDir, "codegraph.db")); err != nil || string(b) != "db" {
		t.Fatalf("chỉ mục chép vào repo = %q, %v", b, err)
	}
	if _, err := os.Stat(filepath.Join(repo, codegraphDir, "codegraph.db.hive-tmp")); !os.IsNotExist(err) {
		t.Fatalf("còn file tạm: %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(repo, ".git", "info", "exclude")); !strings.Contains(string(b), "/"+codegraphDir+"/") {
		t.Fatalf("info/exclude = %q", b)
	}
	if st, _ := gitOutput(t.Context(), repo, "status", "--porcelain"); st != "" {
		t.Fatalf("git status bẩn: %q", st)
	}
	calls, _ := os.ReadFile(log)
	if !strings.Contains(string(calls), "query LoginHandler") {
		t.Fatalf("codegraph không được hỏi: %q", calls)
	}
}

func TestLocalPromptNoCodeGraphWithoutIndex(t *testing.T) {
	localPackEnv(t)
	_, log := fakeCodeGraphSh(t)
	repo := packRepo(t)
	got := packContext(t, callLocalJSON(t, "prompt", "s1", promptInput(repo, "Sửa LoginHandler")))
	if !strings.Contains(got, "`auth/login.go`") || strings.Contains(got, "codegraph") {
		t.Fatalf("pack:\n%s", got)
	}
	if _, err := os.Stat(log); !os.IsNotExist(err) {
		t.Fatal("không có chỉ mục mà vẫn gọi codegraph")
	}
	if _, err := os.Stat(filepath.Join(repo, codegraphDir)); !os.IsNotExist(err) {
		t.Fatal("tạo .codegraph khi không có chỉ mục")
	}
}

// Codegraph treo quá ngân sách: hook trả về đúng hạn, không có additionalContext.
func TestLocalPromptSlowCodeGraphTimesOut(t *testing.T) {
	localPackEnv(t)
	fakeCodeGraphSh(t)
	t.Setenv("HIVE_FAKE_CG_SLEEP", "5")
	repo := packRepo(t)
	writeIn(t, filepath.Join(repo, codegraphDir), "codegraph.db", "db")
	old := localPackTimeout
	t.Cleanup(func() { localPackTimeout = old })
	localPackTimeout = 500 * time.Millisecond
	start := time.Now()
	if got := callLocalJSON(t, "prompt", "s1", promptInput(repo, "Sửa LoginHandler")); got != nil {
		t.Fatalf("quá giờ vẫn có pack: %v", got)
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("hook chờ %s", d)
	}
}

func TestRepoURLForms(t *testing.T) {
	got := repoURLForms("git@github.com:acme/app.git")
	for _, want := range []string{"git@github.com:acme/app.git", "git@github.com:acme/app", "https://github.com/acme/app.git", "https://github.com/acme/app"} {
		if !slices.Contains(got, want) {
			t.Fatalf("thiếu %q trong %v", want, got)
		}
	}
	if got := repoURLForms("https://gitlab.example.com/g/sub/app"); !slices.Contains(got, "git@gitlab.example.com:g/sub/app.git") {
		t.Fatalf("%v", got)
	}
	if repoURLForms("") != nil {
		t.Fatal("url rỗng")
	}
}

func TestInteractivePresetContextPackOption(t *testing.T) {
	if p := InteractivePreset("claude", "2.1.296", ""); slices.Contains(p.Hooks, "prompt") {
		t.Fatalf("mặc định bật context pack: %v", p.Hooks)
	}
	p := InteractivePresetWith("claude", "2.1.296", PresetBalanced, PresetOptions{ContextPack: true})
	if !slices.Contains(p.Hooks, "prompt") {
		t.Fatalf("hooks = %v", p.Hooks)
	}
	// CLI cũ vẫn nhận hook prompt: chỉ dùng additionalContext, chạy được dạng shell.
	if p := InteractivePresetWith("claude", "", PresetAggressive, PresetOptions{ContextPack: true}); !slices.Contains(p.Hooks, "prompt") {
		t.Fatalf("hooks = %v", p.Hooks)
	}
	h, ok := InteractiveHook("prompt")
	if !ok || h.Event != "UserPromptSubmit" || h.Command != "prompt" || h.Matcher != "" {
		t.Fatalf("hook = %+v", h)
	}
	if p := InteractivePresetWith("codex", "", PresetBalanced, PresetOptions{ContextPack: true}); len(p.Hooks) != 0 {
		t.Fatalf("codex hooks = %v", p.Hooks)
	}
	if p := InteractivePresetWith("claude", "2.1.296", PresetOff, PresetOptions{ContextPack: true}); len(p.Hooks) != 0 {
		t.Fatalf("off hooks = %v", p.Hooks)
	}
}
