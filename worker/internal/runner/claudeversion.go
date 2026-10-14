package runner

import (
	"context"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// claudeMinVersion là phiên bản Claude Code tối thiểu cho từng cờ/biến môi trường worker thêm vào lệnh. Không có trong
// bảng là mọi phiên bản. Cờ lạ làm Claude Code thoát ngay ("unknown option"), nên mọi cờ đều phải có trong bảng; biến
// môi trường lạ thì bị bỏ qua nên chỉ liệt kê biến đã biết phiên bản đầu tiên có nó.
//
// Cờ ghi 2.1.296 là phiên bản duy nhất đã thử trực tiếp (claude 2.1.296: --help, chạy -p với từng cờ); phiên bản thấp
// hơn chưa kiểm nên không bật. Hai biến có số phiên bản lấy từ tài liệu env-vars của Claude Code (chưa tự thử).
var claudeMinVersion = map[string]string{
	"--exclude-dynamic-system-prompt-sections": "2.1.296",
	"--tools":                     "2.1.296",
	"--disallowedTools":           "2.1.296",
	"--max-turns":                 "2.1.296",
	"--advisor":                   "2.1.296",
	"--append-system-prompt-file": "2.1.296",
	"--add-dir":                   "2.1.296",
	// Không phải cờ: hook dạng exec (command + args) và PostToolUse updatedToolOutput, đã thử trên claude 2.1.296.
	"hook-args":                              "2.1.296",
	"updatedToolOutput":                      "2.1.296",
	"CLAUDE_CODE_SUBAGENT_MODEL_FORCE":       "2.1.257",
	"CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH": "2.1.280",
}

// claudeSupports: version rỗng (không đọc được, hoặc chạy trong sandbox mà worker không hỏi được CLI trong container)
// là không bật gì có điều kiện. Mục không có trong bảng là luôn bật.
func claudeSupports(version, feature string) bool {
	min, ok := claudeMinVersion[feature]
	if !ok {
		return true
	}
	if version == "" {
		return false
	}
	return compareVersions(version, min) >= 0
}

var versionRe = regexp.MustCompile(`\d+(?:\.\d+)+`)

// parseClaudeVersion lấy số phiên bản từ đầu ra của `claude --version` ("2.1.296 (Claude Code)"); rỗng nếu không thấy.
func parseClaudeVersion(out string) string { return versionRe.FindString(out) }

// compareVersions so từng phần số; phần thiếu tính là 0. Trả âm, 0, dương.
func compareVersions(a, b string) int {
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < max(len(as), len(bs)); i++ {
		var x, y int
		if i < len(as) {
			x, _ = strconv.Atoi(as[i])
		}
		if i < len(bs) {
			y, _ = strconv.Atoi(bs[i])
		}
		if x != y {
			return x - y
		}
	}
	return 0
}

// versionTTL: người dùng nâng CLI khi worker đang chạy thì lần chạy sau vẫn thấy bản mới, mà không phải gọi
// `claude --version` (vài trăm ms) ở mọi run.
const versionTTL = 10 * time.Minute

var versionCache struct {
	sync.Mutex
	at time.Time
	v  string
}

// detectClaudeVersion chạy `claude --version`; rỗng khi lỗi (CLI chưa cài, hết giờ).
func detectClaudeVersion(ctx context.Context) string {
	versionCache.Lock()
	defer versionCache.Unlock()
	if versionCache.v != "" && time.Since(versionCache.at) < versionTTL {
		return versionCache.v
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "claude", "--version").Output()
	if err != nil {
		return ""
	}
	versionCache.v, versionCache.at = parseClaudeVersion(string(out)), time.Now()
	return versionCache.v
}

// claudeVersion là phiên bản dùng để chọn cờ cho run này. ClaudeVersion của Runner (đặt trong test) thắng; sandbox hay
// lệnh cấu hình riêng thì không hỏi, vì `claude` trên máy host không phải CLI sẽ chạy.
func (r Runner) claudeVersion(ctx context.Context, job Job) string {
	if r.ClaudeVersion != "" {
		return r.ClaudeVersion
	}
	if job.CLI != "claude" || r.Sandbox != nil || r.cliOverridden(job.CLI) {
		return ""
	}
	return detectClaudeVersion(ctx)
}

func (r Runner) cliOverridden(cli string) bool {
	if _, ok := r.CLICommands[cli]; ok {
		return true
	}
	fromEnv, err := CommandsFromEnv()
	if err != nil {
		return false
	}
	_, ok := fromEnv[cli]
	return ok
}

// claudeFlags lọc các cờ theo phiên bản; cờ chưa đủ phiên bản bị bỏ cùng đối số của nó. Mỗi phần tử là một cờ và đối
// số đi kèm.
func claudeFlags(version string, flags [][]string) []string {
	var out []string
	for _, f := range flags {
		if claudeSupports(version, f[0]) {
			out = append(out, f...)
		}
	}
	return out
}
