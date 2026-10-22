package optimizeall

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "ghi lại testdata/*.json")

// normalize bỏ phần đổi theo máy và lần chạy (HOME tạm, ULID, mã băm, phần ngẫu nhiên của id memstore) để fixture ổn
// định cho test kiểu TS của app so khớp.
func normalize(t *testing.T, home string, v any, runID string) string {
	t.Helper()
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	s := string(raw)
	esc, _ := json.Marshal(home)
	s = strings.ReplaceAll(s, strings.Trim(string(esc), `"`), "$HOME")
	s = strings.ReplaceAll(s, `\\`, "/")
	if runID != "" {
		s = strings.ReplaceAll(s, runID, "01JBRUNID0000000000000000")
	}
	s = regexp.MustCompile(`[0-9a-f]{64}`).ReplaceAllString(s, "<sha256>")
	s = regexp.MustCompile(`(context-sync)-[0-9a-f]{6}`).ReplaceAllString(s, "$1-xxxxxx")
	return s + "\n"
}

func checkFixture(t *testing.T, name, got string) {
	t.Helper()
	path := filepath.Join("testdata", name)
	if *update {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("thiếu %s, chạy go test -run TestFixtures -update: %v", path, err)
	}
	if compact(t, want) != compact(t, []byte(got)) {
		t.Fatalf("%s đổi; kiểm lại kiểu TS rồi chạy -update:\n%s", path, got)
	}
}

// compact bỏ khoảng trắng trước khi so: biome định dạng lại testdata/*.json khác MarshalIndent của Go.
func compact(t *testing.T, raw []byte) string {
	t.Helper()
	var b bytes.Buffer
	if err := json.Compact(&b, raw); err != nil {
		t.Fatal(err)
	}
	return b.String()
}

func TestFixtures(t *testing.T) {
	f := newFixture(t)
	f.machine.RTKSupported = true
	f.machine.Fixes = []FixSuggestion{{ID: "codegraph.mcp", Profile: "codex-2"}, {ID: "tool.codegraph"}}
	plan, err := f.runner.Plan(map[string]Policy{"acme/web": {Level: "aggressive", RTK: true, AutoCompactWindow: intPtr(150_000)}})
	if err != nil {
		t.Fatal(err)
	}
	checkFixture(t, "optimize-plan.json", normalize(t, f.home, plan, ""))

	for i := range plan.Steps {
		if plan.Steps[i].ID == "tool.codegraph" {
			plan.Steps[i].Status = StatusOK
		}
	}
	run, err := f.runner.Apply(plan)
	if err != nil {
		t.Fatal(err)
	}
	checkFixture(t, "optimize-run.json", normalize(t, f.home, run, run.ID))

	undone, err := f.runner.Undo(run.ID)
	if err != nil {
		t.Fatal(err)
	}
	checkFixture(t, "optimize-run-undone.json", normalize(t, f.home, undone, run.ID))
}
