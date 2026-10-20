package branches

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestParseStatus(t *testing.T) {
	out := "# branch.oid 1111111111111111111111111111111111111111\x00" +
		"# branch.head feature/x\x00" +
		"# branch.upstream origin/feature/x\x00" +
		"# branch.ab +2 -3\x00" +
		"1 .M N... 100644 100644 100644 aaaa bbbb file with space.txt\x00" +
		"2 R. N... 100644 100644 100644 aaaa bbbb R100 new.txt\x00old.txt\x00" +
		"1 .M SC.. 160000 160000 160000 aaaa bbbb vendor/sub\x00" +
		"u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict.txt\x00" +
		"? tệp mới.txt\x00" +
		"! node_modules/\x00"
	got := parseStatus(out)
	if got.head != "feature/x" || got.detached || got.upstream != "origin/feature/x" || !got.hasAB ||
		got.ahead != 2 || got.behind != 3 {
		t.Fatalf("nhánh đọc sai: %+v", got)
	}
	if want := []string{"file with space.txt", "new.txt", "vendor/sub", "conflict.txt"}; !slices.Equal(got.tracked, want) {
		t.Fatalf("tracked = %q, muốn %q", got.tracked, want)
	}
	if !slices.Equal(got.untracked, []string{"tệp mới.txt"}) || !slices.Equal(got.ignored, []string{"node_modules/"}) {
		t.Fatalf("untracked/ignored sai: %+v", got)
	}
	if !got.submodule || got.state() != StateDirty {
		t.Fatalf("submodule và dirty: %+v", got)
	}
}

func TestParseStatusDetachedAndGoneUpstream(t *testing.T) {
	got := parseStatus("# branch.oid (initial)\x00# branch.head (detached)\x00")
	if !got.detached || got.head != "" || got.oid != "" || got.state() != StateClean {
		t.Fatalf("detached sai: %+v", got)
	}
	gone := parseStatus("# branch.oid 1\x00# branch.head x\x00# branch.upstream origin/x\x00? a\x00")
	if gone.hasAB || gone.state() != StateUntracked {
		t.Fatalf("upstream đã xoá không có branch.ab: %+v", gone)
	}
}

func TestFilesCap(t *testing.T) {
	var tr tree
	for i := range 25 {
		tr.untracked = append(tr.untracked, string(rune('a'+i)))
	}
	tr.tracked = []string{"T"}
	files, total := tr.files()
	if len(files) != maxFiles || total != 26 || files[0] != "T" {
		t.Fatalf("files phải cắt ở 20, file theo dõi trước: %d %d %q", len(files), total, files[0])
	}
}

func TestOperationIn(t *testing.T) {
	cases := []struct {
		files []string
		want  string
	}{
		{nil, ""},
		{[]string{"MERGE_HEAD"}, OpMerge},
		{[]string{"rebase-merge/", "MERGE_HEAD"}, OpRebase},
		{[]string{"rebase-apply/"}, OpRebase},
		{[]string{"CHERRY_PICK_HEAD"}, OpCherryPick},
		{[]string{"REVERT_HEAD"}, OpRevert},
		{[]string{"BISECT_LOG"}, OpBisect},
	}
	for _, c := range cases {
		dir := t.TempDir()
		for _, f := range c.files {
			p := filepath.Join(dir, filepath.FromSlash(f))
			if f[len(f)-1] == '/' {
				if err := os.MkdirAll(p, 0o755); err != nil {
					t.Fatal(err)
				}
			} else if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		if got := OperationIn(dir); got != c.want {
			t.Fatalf("%v: %q, muốn %q", c.files, got, c.want)
		}
	}
}

func TestIgnoredBlocking(t *testing.T) {
	ignored := []string{"node_modules/", "apps/web/node_modules/", "dist/", ".env", "apps/hub/.env.local", "target/"}
	got := IgnoredBlocking(ignored, DefaultRebuildable())
	if !slices.Contains(got, ".env") || !slices.Contains(got, "apps/hub/.env.local") {
		t.Fatalf(".env phải chặn: %q", got)
	}
	for _, p := range got {
		if p == "node_modules/" || p == "apps/web/node_modules/" {
			t.Fatalf("node_modules dựng lại được: %q", got)
		}
	}
}

func TestPathState(t *testing.T) {
	dir := t.TempDir()
	if s := pathState(dir); s != "" {
		t.Fatalf("thư mục còn: %q", s)
	}
	if s := pathState(filepath.Join(dir, "gone")); s != StateMissing {
		t.Fatalf("cha còn là missing: %q", s)
	}
	if s := pathState(filepath.Join(dir, "no-parent", "gone")); s != StateUnreachable {
		t.Fatalf("cha mất là unreachable: %q", s)
	}
}

// Thao tác dở đọc từ thư mục git riêng của worktree, kể cả worktree liên kết.
func TestReadTreeMergeConflict(t *testing.T) {
	isolateGit(t)
	repo := newRepo(t)
	gitT(t, repo, "switch", "-c", "other")
	writeFile(t, repo, "README.md", "other\n")
	gitT(t, repo, "commit", "-qam", "other")
	gitT(t, repo, "switch", "main")
	writeFile(t, repo, "README.md", "main\n")
	gitT(t, repo, "commit", "-qam", "main")
	gitTry(repo, "merge", "other")
	tr, op, err := testEnv(t).readTree(context.Background(), repo, false)
	if err != nil {
		t.Fatal(err)
	}
	if op != OpMerge || tr.state() != StateDirty {
		t.Fatalf("merge dở: op=%q state=%q", op, tr.state())
	}
}
