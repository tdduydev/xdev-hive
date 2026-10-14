package runner

import (
	"context"
	"os/exec"
	"testing"
)

// Bản xuất phải đọc đúng bảng claudeMinVersion mà run dùng, kể cả mục không phải cờ.
func TestClaudeSupportsExportedMatchesTable(t *testing.T) {
	for feature, min := range claudeMinVersion {
		if !ClaudeSupports(min, feature) {
			t.Fatalf("%s: %s phải đủ", feature, min)
		}
		if ClaudeSupports("2.0.0", feature) || ClaudeSupports("", feature) {
			t.Fatalf("%s: bản cũ hay không rõ phiên bản không được bật", feature)
		}
	}
	if !ClaudeSupports("", "BASH_MAX_OUTPUT_LENGTH") {
		t.Fatal("mục không có trong bảng là luôn bật")
	}
}

func TestDetectClaudeVersionExported(t *testing.T) {
	if _, err := exec.LookPath("claude"); err != nil {
		t.Skip("không có claude trong PATH")
	}
	if v := DetectClaudeVersion(context.Background()); v != detectClaudeVersion(context.Background()) || v == "" {
		t.Fatalf("version = %q", v)
	}
}
