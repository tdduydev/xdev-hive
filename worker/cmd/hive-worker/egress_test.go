package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEgressProxyFlags(t *testing.T) {
	for _, args := range [][]string{nil, {"--allowlist", "missing"}, {"--listen", "127.0.0.1:0"}, {"--allowlist", "missing", "--listen", "127.0.0.1:0", "--connect-timeout", "0s"}, {"--allowlist", "missing", "--listen", "127.0.0.1:0", "--idle-timeout", "-1s"}, {"--allowlist", "missing", "--listen", "127.0.0.1:0", "extra"}} {
		var output bytes.Buffer
		if code := egressProxy(args, &output); code != 2 {
			t.Fatalf("args=%v code=%d output=%s", args, code, &output)
		}
	}
}

func TestEgressProxyRejectsInvalidPolicyBeforeListening(t *testing.T) {
	path := filepath.Join(t.TempDir(), "allowlist.txt")
	if err := os.WriteFile(path, []byte("example:0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if code := egressProxy([]string{"--allowlist", path, "--listen", "127.0.0.1:0"}, &output); code != 1 || !strings.Contains(output.String(), "allowlist dòng 1") {
		t.Fatalf("code=%d output=%s", code, &output)
	}
}
