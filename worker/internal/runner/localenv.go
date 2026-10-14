package runner

import (
	"os"
	"slices"
	"strings"
)

// loginEnv là biến đăng nhập của từng CLI. Máy không có gói trong accounts.json thì CLI đăng nhập mặc định bằng các biến
// này, nên phiên tại máy phải giữ chúng; giá trị vẫn bị che khỏi output.
var loginEnv = map[string][]string{
	"claude": claudeLoginEnv,
	"codex":  {"OPENAI_API_KEY"},
	"gemini": {"GEMINI_API_KEY", "GOOGLE_API_KEY"},
}

// LocalEnv là môi trường của phiên tương tác do `hive` mở tại máy (specs/010 T011): như phiên terminal Leader, bỏ
// HIVE_* và biến có dạng token/mật khẩu của worker (machine token không được lọt vào shell agent điều khiển), giữ biến
// đăng nhập của cli khi không có gói (account rỗng), rồi đặt env của gói và over. Secrets là giá trị phải che khỏi output.
func LocalEnv(cli string, account, over map[string]string) (env []string, secrets []string) {
	keep := []string(nil)
	if len(account) == 0 {
		keep = loginEnv[cli]
	}
	var base []string
	for _, kv := range os.Environ() {
		name, value, _ := strings.Cut(kv, "=")
		if !secretEnvName(name) {
			base = append(base, kv)
			continue
		}
		if slices.Contains(keep, name) {
			base = append(base, kv)
			secrets = append(secrets, value)
		}
	}
	merged := map[string]string{}
	for k, v := range over {
		merged[k] = v
	}
	// Đặt sau over để client không đổi được thư mục đăng nhập của gói.
	for k, v := range account {
		merged[k] = v
		if secretEnvName(k) && v != "" {
			secrets = append(secrets, v)
		}
	}
	return mergeEnv(base, merged), secrets
}
