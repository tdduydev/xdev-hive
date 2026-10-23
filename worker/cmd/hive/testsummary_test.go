package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/testreport"
)

func TestSummaryCommand(t *testing.T) {
	path := filepath.Join(t.TempDir(), "junit.xml")
	if err := os.WriteFile(path, []byte(`<testsuite><testcase name="TC-001"><failure message="secret"/></testcase></testsuite>`), 0600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	a := &app{stdout: &stdout, stderr: &stderr}
	// Test hỏng vẫn xuất metadata và kết thúc thành công để agent gửi kết quả lên cổng.
	if code := a.run([]string{"test-summary", path, "--format", "junit"}); code != exitOK {
		t.Fatalf("%d: %s", code, stderr.String())
	}
	var summary testreport.Summary
	if err := json.Unmarshal(stdout.Bytes(), &summary); err != nil {
		t.Fatal(err)
	}
	if summary.Totals.Failed != 1 || len(summary.Cases) != 1 || bytes.Contains(stdout.Bytes(), []byte("secret")) {
		t.Fatalf("metadata: %s", stdout.String())
	}
	stdout.Reset()
	if a.run([]string{"test-summary", path, "--commit", "main"}) != exitUsage || stdout.Len() != 0 {
		t.Fatal("SHA sai vẫn có kết quả")
	}
}
