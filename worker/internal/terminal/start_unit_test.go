package terminal

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// FR-019: chỉ mở trong thư mục được phép; `..`, đường tuyệt đối và symlink trỏ ra ngoài đều là ROOT_ESCAPE.
func TestResolveRoot(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "repo")
	outsideDir := filepath.Join(base, ".ssh")
	for _, d := range []string{filepath.Join(root, "apps", "web"), outsideDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	cases := []struct{ subdir, rel, code string }{
		{"", ".", ""},
		{"apps/web", "apps/web", ""},
		{"apps/../apps/web/", "apps/web", ""},
		{"../.ssh", "", codeRootEscape},
		{"apps/../../.ssh", "", codeRootEscape},
		{"..", "", codeRootEscape},
		{"/etc", "", codeRootEscape},
		{"khong-co", "", codeRootMissing},
		{"README.md", "", codeRootMissing},
	}
	for _, c := range cases {
		cwd, rel, code := resolveRoot(root, c.subdir)
		if code != c.code || rel != c.rel {
			t.Errorf("resolveRoot(%q) = %q, %q, %q; muốn rel %q, mã %q", c.subdir, cwd, rel, code, c.rel, c.code)
		}
		if code == "" && !filepath.IsAbs(cwd) {
			t.Errorf("resolveRoot(%q) cwd phải là đường tuyệt đối: %q", c.subdir, cwd)
		}
	}
	if _, _, code := resolveRoot(filepath.Join(base, "da-xoa"), ""); code != codeRootMissing {
		t.Fatalf("root không còn = %q", code)
	}

	if err := os.Symlink(outsideDir, filepath.Join(root, "lot")); err != nil {
		// Windows chưa bật Developer Mode thì không tạo được symlink.
		t.Skipf("không tạo được symlink: %v", err)
	}
	if _, _, code := resolveRoot(root, "lot"); code != codeRootEscape {
		t.Fatalf("symlink ra ngoài = %q, muốn ROOT_ESCAPE", code)
	}
}

func TestStartPermissions(t *testing.T) {
	cases := []struct {
		want  string
		allow bool
		got   string
	}{
		{"", false, PermWorkspace},
		{PermAsk, false, PermAsk},
		{PermWorkspace, true, PermWorkspace},
		{PermFull, false, PermWorkspace},
		{PermFull, true, PermFull},
		{"root", true, PermWorkspace},
	}
	for _, c := range cases {
		if got := startPermissions(c.want, c.allow); got != c.got {
			t.Errorf("startPermissions(%q, %v) = %q, muốn %q", c.want, c.allow, got, c.got)
		}
	}
}

func TestStartArgs(t *testing.T) {
	cases := []struct {
		cli, model, perm, prompt string
		shim                     bool
		args                     []string
		typed                    string
	}{
		{"claude", "opus", PermWorkspace, "-rf sửa lỗi", false,
			[]string{"--model", "opus", "--permission-mode", "acceptEdits", "--", "-rf sửa lỗi"}, ""},
		{"claude", "", PermAsk, "", false, nil, ""},
		{"claude", "", PermFull, "x & del", true, []string{"--permission-mode", "bypassPermissions"}, "x & del"},
		{"codex", "gpt-5", PermAsk, "hi", false, []string{"-m", "gpt-5", "-c", `approval_policy="untrusted"`, "--", "hi"}, ""},
		{"codex", "", PermWorkspace, "", false, []string{"-s", "workspace-write", "-c", `approval_policy="on-request"`}, ""},
		{"codex", "", PermFull, "", false, []string{"--dangerously-bypass-approvals-and-sandbox"}, ""},
		{"gemini", "gemini-2.5-pro", PermFull, "-v", false,
			[]string{"-m", "gemini-2.5-pro", "--approval-mode", "yolo", "--prompt-interactive=-v"}, ""},
		{"gemini", "", PermWorkspace, "", false, []string{"--approval-mode", "auto_edit"}, ""},
	}
	for _, c := range cases {
		args, typed := startArgs(c.cli, c.model, c.perm, c.prompt, c.shim)
		if !slices.Equal(args, c.args) || typed != c.typed {
			t.Errorf("startArgs(%s, %s, %s, %q) = %q, %q; muốn %q, %q", c.cli, c.model, c.perm, c.prompt, args, typed, c.args, c.typed)
		}
	}
}

func TestModelName(t *testing.T) {
	for _, m := range []string{"opus", "claude-opus-5-5", "gpt-5.1-codex", "models/gemini-2.5-pro", "us.anthropic.claude[1m]"} {
		if !modelName.MatchString(m) {
			t.Errorf("model %q phải hợp lệ", m)
		}
	}
	for _, m := range []string{"", "--dangerously-skip-permissions", "-m", "a b", "opus;rm", "x$(id)"} {
		if modelName.MatchString(m) {
			t.Errorf("model %q phải bị bỏ", m)
		}
	}
}
