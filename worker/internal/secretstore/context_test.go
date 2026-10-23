package secretstore

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestContextBlockContract(t *testing.T) {
	for _, policy := range []string{PolicyAllow, PolicyApprove, PolicyDeny} {
		items := []Secret{{Name: "STRIPE_TEST_KEY", Description: "Khoá Stripe môi trường test, quyền đọc"}, {Name: "DB_URL_STAGING"}}
		golden := "context-allow.md"
		if policy == PolicyDeny {
			golden = "context-deny.md"
		}
		want, err := os.ReadFile(filepath.Join("testdata", golden))
		if err != nil {
			t.Fatal(err)
		}
		if ContextBlock(policy, items) != strings.ReplaceAll(string(want), "\r\n", "\n") {
			t.Fatal("khối ngữ cảnh lệch contract")
		}
	}
	if ContextBlock(PolicyAllow, nil) != "" {
		t.Fatal("dự án rỗng vẫn có khối")
	}
}

func TestContextBlockFiltersTamperedDescriptions(t *testing.T) {
	items := []Secret{{Name: "SAFE_NAME", Description: "ghp_" + strings.Repeat("a", 36)}, {Name: "OTHER_NAME", Description: strings.Repeat("đ", 300)}}
	for range 70 {
		items = append(items, Secret{Name: "ANOTHER_NAME"})
	}
	got := ContextBlock(PolicyAllow, items)
	if strings.Contains(got, "ghp_") || strings.Contains(got, strings.Repeat("đ", 201)) || strings.Count(got, "\n- ") != MaxPerProject {
		t.Fatal("ngữ cảnh không giới hạn/quét mô tả")
	}
}
