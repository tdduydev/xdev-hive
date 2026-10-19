package accounts

import "context"

// ClaudePrint chạy `claude <args>` bằng đăng nhập của một gói, như ReadUsage đọc /usage: CLAUDE_CONFIG_DIR và token
// OAuth của gói, ngoài mọi repo. configDir rỗng là đăng nhập mặc định. Lệnh thoát khác 0 vẫn trả stdout đã in.
func ClaudePrint(ctx context.Context, home, configDir string, args []string) ([]byte, error) {
	bin, err := lookPath("claude")
	if err != nil {
		return nil, err
	}
	var env map[string]string
	if dir := expandHome(home, configDir); dir != "" {
		env = map[string]string{envVar["claude"]: dir}
		if token := oauthToken(dir); token != "" {
			env[tokenEnv] = token
		}
	}
	return runCLI(ctx, bin, args, env)
}
