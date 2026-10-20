package branches

import (
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
)

func TestAppendLogKeepsLast(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "xdev-hive")
	var batch []LogEntry
	for i := range logKeep + 5 {
		batch = append(batch, LogEntry{Time: "2026-10-20T03:20:00Z", Action: ActionClean, Folder: "/r", Branch: "ai/" + strconv.Itoa(i), Result: ResultRemoved})
	}
	if err := AppendLog(dir, batch[:logKeep-1]...); err != nil {
		t.Fatal(err)
	}
	if got := readLog(t, dir); len(got) != logKeep-1 {
		t.Fatalf("%d dòng", len(got))
	}
	if err := AppendLog(dir, batch[logKeep-1:]...); err != nil {
		t.Fatal(err)
	}
	got := readLog(t, dir)
	if len(got) != logKeep || got[0].Branch != "ai/5" || got[logKeep-1].Branch != "ai/"+strconv.Itoa(logKeep+4) {
		t.Fatalf("%d dòng, đầu %s, cuối %s", len(got), got[0].Branch, got[len(got)-1].Branch)
	}
}

// Hai repo dọn song song ghi cùng file: không dòng nào bị đè hay ghép nửa.
func TestAppendLogConcurrent(t *testing.T) {
	dir := t.TempDir()
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Go(func() {
			if err := AppendLog(dir, LogEntry{Action: ActionClean, Folder: "/r", Branch: "ai/" + strconv.Itoa(i), Result: ResultSkipped}); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if got := readLog(t, dir); len(got) != 20 {
		t.Fatalf("%d dòng", len(got))
	}
}

func TestAppendLogNoConfigDir(t *testing.T) {
	if err := AppendLog("", LogEntry{Action: ActionClean}); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := AppendLog(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(LogPath(dir)); !os.IsNotExist(err) {
		t.Fatal("không có dòng nào thì không tạo file")
	}
}
