package gitgroups

import (
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
)

// Biến môi trường của askpass. Git gọi GIT_ASKPASS (chính hive-worker) với câu hỏi "Username for 'https://host': " hay
// "Password for 'https://user@host': "; hive-worker thấy AskpassEnv thì trả lời từ biến môi trường rồi thoát, token không
// nằm trong file hay tham số dòng lệnh nào.
const (
	AskpassEnv      = "HIVE_GIT_ASKPASS"
	askpassUserEnv  = "HIVE_GIT_ASKPASS_USER"
	askpassTokenEnv = "HIVE_GIT_ASKPASS_TOKEN"
	askpassHostEnv  = "HIVE_GIT_ASKPASS_HOST"
	// TokensEnv là token của các kết nối app đưa cho lệnh gitgroups: JSON {id kết nối: token}.
	TokensEnv = "HIVE_GIT_TOKENS"
	// TokenEnv là token của kết nối đang thêm (chưa có id).
	TokenEnv = "HIVE_GIT_TOKEN"
)

// tokenUser là tên đăng nhập HTTPS đi với personal access token: GitLab nhận "oauth2", GitHub nhận "x-access-token".
func tokenUser(kind string) string {
	if kind == KindGitHub {
		return "x-access-token"
	}
	return "oauth2"
}

// Askpass trả lời câu hỏi của git. Chỉ trả token cho đúng máy chủ của kết nối: repo chuyển hướng sang máy chủ khác thì
// không nhận gì.
func Askpass(args []string, stdout io.Writer) int {
	prompt := strings.Join(args, " ")
	want := os.Getenv(askpassHostEnv)
	if host := promptHost(prompt); want == "" || !strings.EqualFold(host, want) {
		return 1
	}
	switch {
	case strings.HasPrefix(prompt, "Username"):
		_, _ = fmt.Fprintln(stdout, os.Getenv(askpassUserEnv))
	case strings.HasPrefix(prompt, "Password"):
		_, _ = fmt.Fprintln(stdout, os.Getenv(askpassTokenEnv))
	default:
		return 1
	}
	return 0
}

// promptHost đọc máy chủ (kèm cổng) trong câu hỏi của git: phần URL nằm giữa hai dấu nháy đơn.
func promptHost(prompt string) string {
	i := strings.Index(prompt, "'")
	j := strings.LastIndex(prompt, "'")
	if i < 0 || j <= i {
		return ""
	}
	u, err := url.Parse(prompt[i+1 : j])
	if err != nil {
		return ""
	}
	return u.Host
}

// hostOf là máy chủ kèm cổng của URL clone HTTPS; rỗng với SSH và đường dẫn tại máy.
func hostOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return ""
	}
	return u.Host
}
