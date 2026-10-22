package ctxsync

import (
	"strings"
	"testing"
)

// Khoá giả ghép lúc chạy để công cụ quét bí mật của repo công khai không coi file test là lộ khoá.
func fakeKey(prefix string, n int) string {
	const alphabet = "Q7mZ2xK9pL4vT8nR3sW6yB1cD5fG0hJ"
	var b strings.Builder
	b.WriteString(prefix)
	for i := 0; i < n; i++ {
		b.WriteByte(alphabet[(i*7)%len(alphabet)])
	}
	return b.String()
}

func TestLooksSecretCatchesCredentials(t *testing.T) {
	cases := map[string]string{
		"khoá riêng":       "Khoá deploy:\n-----BEGIN " + "OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n",
		"PAT GitHub":       "Dùng " + fakeKey("gh"+"p_", 36) + " để gọi API.",
		"PAT GitLab":       "GitLab: " + fakeKey("gl"+"pat-", 20),
		"khoá AWS":         "AWS " + "AK" + "IA" + strings.ToUpper(fakeKey("", 16)),
		"khoá OpenAI":      "OPENAI=" + fakeKey("sk"+"-", 40),
		"JWT":              "token mẫu eyJ" + fakeKey("", 20) + ".eyJ" + fakeKey("", 20) + "." + fakeKey("", 20),
		"URL kèm mật khẩu": "git clone https://deploy:s3cr3t@gitlab.local/team/app.git",
		"password=":        "Môi trường test: password=hunter22x",
		"API key có ngoặc": `cấu hình "apiKey": "a8F3k2Lm9Qz"`,
		"Bearer":           "curl -H 'Authorization: Bearer " + fakeKey("", 24) + "'",
		"chuỗi ngẫu nhiên": "Mã cài đặt " + fakeKey("", 32),
	}
	for name, s := range cases {
		if !looksSecret(s) {
			t.Errorf("%s: không nhận ra bí mật", name)
		}
	}
}

func TestLooksSecretIgnoresOrdinaryMemory(t *testing.T) {
	cases := []string{
		"Không commit secret, token, mật khẩu.",
		"Basic authentication đã tắt trên hub; dùng PAT.",
		"token: xem PAT trong 1Password của nhóm",
		"password: hỏi trưởng nhóm",
		"Đọc mật khẩu từ process.env.DB_PASSWORD, không viết thẳng vào code.",
		"DB_PASSWORD=${DB_PASSWORD} trong compose.yaml",
		"contextBudgetTokens: 2000, maxTokens=4096",
		"Lỗi do commit a3f5c9e1b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2, dự án 7f3c1b52-0a1e-4c0e-9d57-2f4c8f0b6a11.",
		"Sửa apps/hub/src/modules/knowledge/memory.service.ts trước, rồi worker/internal/ctxsync/hub.go.",
		"Test TestContextProjectFixtureMatchesGoType hỏng khi đổi Project.",
		"Gọi useQueryClientV2WithSuspense trong ProjectSettingsPage2.",
		"Clone bằng https://<user>:<token>@gitlab.example.com/team/app.git hoặc https://oauth2:$GITLAB_TOKEN@host/x.git",
		"Hub chạy ở https://hub.example.com:8443/api/v1/projects",
		"API_KEY=your-api-key-here",
	}
	for _, s := range cases {
		if looksSecret(s) {
			t.Errorf("bỏ nhầm memory thường: %q", s)
		}
	}
}
