package delivery

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestJobLogMasksSecretsLongestFirst(t *testing.T) {
	dir := t.TempDir()
	l, err := OpenJobLog(dir, "job-1", "abc", "abcdef", "")
	if err != nil {
		t.Fatal(err)
	}
	l.Printf("header Authorization: abcdef and abc")
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "job-1.log"))
	s := string(b)
	if strings.Contains(s, "abc") || strings.Count(s, "***") != 2 {
		t.Fatalf("log = %q", s)
	}
}

func TestJobLogRejectsEscapingJobID(t *testing.T) {
	for _, id := range []string{"../x", "a/b", "", strings.Repeat("a", 65)} {
		if _, err := OpenJobLog(t.TempDir(), id); CodeOf(err) != CodeBadRequest {
			t.Errorf("%q phải bị từ chối, got %v", id, err)
		}
	}
}
