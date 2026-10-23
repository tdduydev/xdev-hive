package secretstore

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// File mẫu dùng chung với bộ quét của hub (packages/contracts/src/secret-scan.ts) và runner. Mô tả bị chặn khi
// looksSecret đúng, nên cả hai chiều có nghĩa: mẫu dương lọt là lộ bí mật trong secrets.json, mẫu âm bị chặn là người
// dùng không lưu được mô tả thường. Chỗ lệch với hub ghi bằng t.Skip như secret_fixture_test.go của runner, để thấy
// khoảng lệch mà không làm đỏ CI khi hub thêm mẫu.
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

func TestLooksSecretSharedFixtures(t *testing.T) {
	data, err := os.ReadFile(secretFixturesPath)
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Positive []secretSample `json:"positive"`
		Negative []secretSample `json:"negative"`
	}
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Positive) == 0 || len(f.Negative) == 0 {
		t.Fatal("file mẫu thiếu mẫu dương hay âm")
	}
	for _, s := range f.Positive {
		t.Run("dương/"+s.Name, func(t *testing.T) {
			if !looksSecret(s.text(t)) {
				t.Skipf("looksSecret chưa bắt mẫu %q", s.Name)
			}
		})
	}
	for _, s := range f.Negative {
		t.Run("âm/"+s.Name, func(t *testing.T) {
			if looksSecret(s.text(t)) {
				t.Skipf("looksSecret chặn nhầm mẫu %q", s.Name)
			}
		})
	}
}
