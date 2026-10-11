package runner

import (
	"context"
	"path/filepath"
	"reflect"
	"testing"
)

func TestParseNumstat(t *testing.T) {
	stats, err := parseNumstat("7\t5\tsrc/a.ts\x00-\t-\tassets/icon.bin\x000\t3\told.txt\x001\t0\tname\twith\nspace.txt\x00")
	if err != nil {
		t.Fatal(err)
	}
	want := &DiffStats{AddedLines: 8, DeletedLines: 8, ChangedFiles: []string{"src/a.ts", "assets/icon.bin", "old.txt", "name\twith\nspace.txt"}}
	if !reflect.DeepEqual(stats, want) {
		t.Fatalf("stats = %#v, want %#v", stats, want)
	}
	empty, err := parseNumstat("")
	if err != nil || !reflect.DeepEqual(empty, &DiffStats{ChangedFiles: []string{}}) {
		t.Fatalf("empty = %#v, err = %v", empty, err)
	}
}

func TestParseNumstatRejectsMalformedCounts(t *testing.T) {
	for _, raw := range []string{"broken", "1\t0\t", "-\t0\tx\x00", "-1\t0\tx\x00", "1\tx\tx\x00"} {
		if _, err := parseNumstat(raw); err == nil {
			t.Errorf("accepted %q", raw)
		}
	}
}

func TestCollectDiffStatsUsesMergeBaseAndIncludesRenamedBinaryPaths(t *testing.T) {
	remote, _ := makeRemote(t)
	work := filepath.Join(t.TempDir(), "work")
	must(t, "git", "clone", remote, work)
	commit := func(message string) {
		must(t, "git", "-C", work, "add", ".")
		must(t, "git", "-C", work, "-c", "user.name=Runner Test", "-c", "user.email=runner@example.invalid", "commit", "-m", message)
	}
	mustDir(t, work, "text.txt", "one\ntwo\nthree\n")
	mustDir(t, work, "schema.bin", "\x00binary")
	commit("fixture")
	must(t, "git", "-C", work, "branch", "base")
	must(t, "git", "-C", work, "checkout", "-b", "run")
	mustDir(t, work, "text.txt", "one\nnew\n")
	must(t, "git", "-C", work, "mv", "schema.bin", "asset.bin")
	commit("run changes")
	must(t, "git", "-C", work, "checkout", "base")
	mustDir(t, work, "unrelated.txt", "base advanced\n")
	commit("advance base")
	must(t, "git", "-C", work, "checkout", "run")
	stats, err := collectDiffStats(context.Background(), work, "base")
	if err != nil {
		t.Fatal(err)
	}
	want := &DiffStats{AddedLines: 1, DeletedLines: 2, ChangedFiles: []string{"asset.bin", "schema.bin", "text.txt"}}
	if !reflect.DeepEqual(stats, want) {
		t.Fatalf("stats = %#v, want %#v", stats, want)
	}
}
