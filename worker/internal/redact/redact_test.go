package redact

import (
	"strings"
	"testing"
)

func TestTextAndNestedJSON(t *testing.T) {
	token := "ghp_" + strings.Repeat("A", 36)
	input := `{"result":{"error":"token: ` + token + `","message":"opaque-secret"},"count":12}`
	b, err := JSON([]byte(input), []string{"opaque-secret"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), token) || strings.Contains(string(b), "opaque-secret") || !strings.Contains(string(b), `"count":12`) {
		t.Fatal(string(b))
	}
	if got := Text("ghp_\x1b[31m"+strings.Repeat("A", 36), nil); strings.Contains(got, "AAAA") {
		t.Fatal(got)
	}
}

func TestStreamEverySplitAndPEM(t *testing.T) {
	token := "ghp_" + strings.Repeat("A", 36)
	input := "xin chào " + token + "\n-----BEGIN PRIVATE KEY-----\nprivate-content\n-----END PRIVATE KEY-----\nxong"
	for split := 0; split <= len(input); split++ {
		s := &Stream{}
		out := string(s.Push([]byte(input[:split]))) + string(s.Push([]byte(input[split:]))) + string(s.Flush())
		if strings.Contains(out, token) || strings.Contains(out, "private-content") || !strings.Contains(out, "xin chào") || !strings.HasSuffix(out, "xong") {
			t.Fatalf("cắt %d: %s", split, out)
		}
	}
}

func TestLongLineBounded(t *testing.T) {
	s := &Stream{}
	out := string(s.Push([]byte("TOKEN="+strings.Repeat("a", 100000)))) + string(s.Push([]byte("không gửi\nxong\n"))) + string(s.Flush())
	if out != Mask+"xong\n" {
		t.Fatal(out)
	}
}
