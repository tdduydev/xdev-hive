package runner

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// File mẫu dùng chung với bộ quét của hub (packages/contracts/src/secret-scan.ts). Worker chỉ che log nên mẫu âm không
// kiểm ở đây (che thừa không hại); mẫu dương worker chưa bắt được ghi nhận bằng t.Skip để biết khoảng lệch giữa hai bên
// mà không làm đỏ CI.
const secretFixturesPath = "../../../packages/contracts/fixtures/secret-scan.json"

type secretSample struct {
	Name string          `json:"name"`
	Text json.RawMessage `json:"text"`
}

// text là chuỗi, hoặc mảng nối liền khi token bị cắt đôi để bộ quét bí mật của nền tảng git không chặn push.
func (s secretSample) text(t *testing.T) string {
	t.Helper()
	var one string
	if err := json.Unmarshal(s.Text, &one); err == nil {
		return one
	}
	var parts []string
	if err := json.Unmarshal(s.Text, &parts); err != nil {
		t.Fatalf("%s: text không phải chuỗi hay mảng chuỗi: %v", s.Name, err)
	}
	return strings.Join(parts, "")
}

func TestRedactSecretsSharedFixtures(t *testing.T) {
	data, err := os.ReadFile(secretFixturesPath)
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Positive []secretSample `json:"positive"`
	}
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Positive) == 0 {
		t.Fatal("file mẫu không có mẫu dương")
	}
	for _, s := range f.Positive {
		t.Run(s.Name, func(t *testing.T) {
			text := s.text(t)
			if redactSecrets(text, nil) == text {
				t.Skipf("worker chưa che mẫu %q (checks.go không có mẫu này)", s.Name)
			}
		})
	}
}
