package branches

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/gitexec"
)

func TestReadInputEmptyIsEmptyObject(t *testing.T) {
	for _, raw := range []string{"", "\n", "  \r\n", "{}\n"} {
		_, in, err := ReadInput(strings.NewReader(raw))
		if err != nil || in.Busy != nil || in.Items != nil {
			t.Fatalf("%q phải là {}: %+v %v", raw, in, err)
		}
	}
}

func TestReadInputBadJSON(t *testing.T) {
	_, _, err := ReadInput(strings.NewReader("{busy\n"))
	if err == nil || err.Code != CodeInvalidInput {
		t.Fatalf("dòng đầu sai phải là invalid_input: %+v", err)
	}
}

// Dòng đầu của clean có thể dài hơn giới hạn 64 KB của bufio.Scanner.
func TestReadInputLongLineAndCRLF(t *testing.T) {
	label := strings.Repeat("x", 100_000)
	s, in, err := ReadInput(strings.NewReader(`{"busy":[{"path":"/a","kind":"agent","label":"` + label + `"}]}` + "\r\n"))
	if err != nil || len(in.Busy) != 1 || in.Busy[0].Label != label {
		t.Fatalf("không đọc được dòng dài: %v", err)
	}
	if got := s.Busy(); len(got) != 1 || got[0].Path != "/a" {
		t.Fatalf("Busy() phải là danh sách của dòng đầu: %+v", got)
	}
}

func TestFollowReplacesBusyAndCancels(t *testing.T) {
	stdin := "{}\n" +
		`{"busy":[{"path":"/one","kind":"terminal"}]}` + "\n" +
		"không phải json\n" +
		`{"other":1}` + "\n" +
		`{"busy":[{"path":"/two","kind":"agent"}]}` + "\r\n" +
		"cancel\n"
	s, _, err := ReadInput(strings.NewReader(stdin))
	if err != nil {
		t.Fatal(err)
	}
	cancelled := 0
	var log bytes.Buffer
	s.Follow(func() { cancelled++ }, &log)
	if cancelled != 1 {
		t.Fatalf("cancel phải gọi đúng một lần: %d", cancelled)
	}
	if got := s.Busy(); len(got) != 1 || got[0].Path != "/two" {
		t.Fatalf("busy mới phải thay cũ: %+v", got)
	}
	if n := strings.Count(log.String(), "bỏ qua dòng stdin"); n != 2 {
		t.Fatalf("hai dòng lạ phải được ghi stderr: %q", log.String())
	}
}

// EOF sau dòng đầu không phải huỷ: Rust đóng stdin thì job chạy tiếp.
func TestFollowEOFIsNotCancel(t *testing.T) {
	s, _, _ := ReadInput(strings.NewReader(`{"busy":[{"path":"/a","kind":"app"}]}`))
	s.Follow(func() { t.Fatal("EOF không được huỷ") }, &bytes.Buffer{})
	if len(s.Busy()) != 1 {
		t.Fatal("busy của dòng đầu phải còn")
	}
}

func TestBusyOwnedLongestPath(t *testing.T) {
	base := t.TempDir()
	main := filepath.Join(base, "repo")
	nested := filepath.Join(main, ".claude", "worktrees", "a")
	other := filepath.Join(base, "repo-wt", "b")
	wts := []string{main, nested, other}
	busy := []BusyDir{
		{Path: filepath.Join(main, "apps", "web"), Kind: BusyTerminal},
		{Path: filepath.Join(nested, "src"), Kind: BusyAgent},
		{Path: other, Kind: BusyApp},
		{Path: filepath.Join(base, "elsewhere"), Kind: BusyAgent},
	}
	// Thư mục phải có thật: CleanAbs chỉ đi qua symlink /var → /private/var của macOS khi đường dẫn còn.
	for _, b := range busy {
		if err := os.MkdirAll(b.Path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if got := busyKind(busyOwned(wts, 0, busy)); got != BusyTerminal {
		t.Fatalf("agent trong worktree con không được chặn thư mục chính: %q", got)
	}
	if got := busyKind(busyOwned(wts, 1, busy)); got != BusyAgent {
		t.Fatalf("worktree con phải là agent: %q", got)
	}
	if got := busyKind(busyOwned(wts, 2, busy)); got != BusyApp {
		t.Fatalf("SamePath phải tính là thuộc worktree: %q", got)
	}
}

func TestBusyKindRank(t *testing.T) {
	got := busyKind([]BusyDir{{Kind: BusyApp}, {Kind: BusyAgent}, {Kind: BusyTerminal}})
	if got != BusyAgent || busyKind(nil) != "" {
		t.Fatalf("agent phải được ưu tiên: %q", got)
	}
}

func TestGitFailureCodes(t *testing.T) {
	cases := []struct {
		err  error
		code string
	}{
		{context.Canceled, CodeCancelled},
		{context.DeadlineExceeded, CodeTimeout},
		{&gitexec.GitError{Timeout: true, Msg: "x"}, CodeTimeout},
		{&gitexec.GitError{Auth: true, Msg: "x"}, CodeAuth},
		{&gitexec.GitError{Msg: "fatal: x"}, CodeGit},
		{errors.New("khác"), CodeGit},
	}
	for _, c := range cases {
		if got := gitFailure(c.err); got.Code != c.code || got.Message == "" {
			t.Fatalf("%v: %+v", c.err, got)
		}
	}
	if d := gitFailure(&gitexec.GitError{Msg: "fatal: x"}).Detail; d != "fatal: x" {
		t.Fatalf("lỗi git phải giữ dòng của git: %q", d)
	}
}
