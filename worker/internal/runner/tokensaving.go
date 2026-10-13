package runner

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// TokenSavingEnv cho máy ghi đè nhóm biến tiết kiệm token mà không phải build lại worker: "off" tắt cả nhóm, hoặc JSON
// {"BASH_MAX_OUTPUT_LENGTH": "20000", "MAX_MCP_OUTPUT_TOKENS": ""} ghi đè từng biến ("" là không đặt biến đó).
const TokenSavingEnv = "HIVE_WORKER_TOKEN_SAVING"

// Mặc định của nhóm biến tiết kiệm token cho run Claude Code (số đo 7 ngày trên máy dev: output Bash chiếm ~22% chi
// phí ước tính vì bị đọc lại mỗi lượt, subagent 30%, ghi cache 1 giờ 26% chi phí run worker).
const (
	defaultBashMaxChars   = 15000
	defaultAutocompactPct = 70
	defaultSubagentModel  = "sonnet"
	defaultCacheTTL       = "5m"
	defaultMCPOutputToken = "15000"
	// Chặn phiên Claude Code phình tới gần 1 triệu token ngữ cảnh (số đo: phiên gần 1M token đọc lại cả ngữ cảnh mỗi lượt).
	defaultAutocompactWindow = 200000
	// Mặc định của Claude Code là 25000; đọc file lớn đi vào ngữ cảnh và bị đọc lại ở mọi lượt sau.
	defaultFileReadMaxTokens = "15000"
	// claudeCodeTools là tool có sẵn cho run code. Giữ Skill (bộ skill mặc định của Hive), TodoWrite và Task (subagent đã
	// bị ép model rẻ bằng CLAUDE_CODE_SUBAGENT_MODEL); bỏ phần còn lại (web, notebook...) cho prompt hệ thống gọn. MultiEdit
	// không có trong claude 2.1.296 nên không khai; init của bản này cũng chưa liệt kê TodoWrite, nhưng --tools nhận tên.
	claudeCodeTools = "Bash,Read,Edit,Write,Grep,Glob,Skill,TodoWrite,Task"
)

// TokenSavingJob là mục tokenSaving trong spec job (settings dự án "Tiết kiệm token"). nil là hub cũ chưa gửi: dùng
// mặc định, bật. Trường số 0 hay chuỗi rỗng cũng dùng mặc định, để spec thiếu trường không tắt cả nhóm.
type TokenSavingJob struct {
	Enabled        bool   `json:"enabled"`
	BashMaxChars   int    `json:"bashMaxChars"`
	AutocompactPct int    `json:"autocompactPct"`
	SubagentModel  string `json:"subagentModel"`
	CacheTTL       string `json:"cacheTtl"`
	// AutocompactWindow là cửa sổ ngữ cảnh (token) trước khi Claude Code nén; 0 là mặc định.
	AutocompactWindow int `json:"autocompactWindow"`
	// AllowWeb cho agent dùng web (WebFetch, WebSearch, web_search của Codex); mặc định tắt.
	AllowWeb bool `json:"allowWeb"`
}

// TokenSavingConfig là cấu hình của máy (xem TokenSavingEnv). Off thắng cả mặc định lẫn spec của hub: chủ máy tắt
// thì dự án không bật lại được.
type TokenSavingConfig struct {
	Off bool
	Env map[string]string
}

// TokenSavingFromEnv đọc HIVE_WORKER_TOKEN_SAVING; biến trống là cấu hình rỗng.
func TokenSavingFromEnv() (TokenSavingConfig, error) {
	raw := strings.TrimSpace(os.Getenv(TokenSavingEnv))
	switch strings.ToLower(raw) {
	case "":
		return TokenSavingConfig{}, nil
	case "off", "0", "false":
		return TokenSavingConfig{Off: true}, nil
	}
	var env map[string]string
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		return TokenSavingConfig{}, fmt.Errorf("%s phải là \"off\" hoặc JSON {\"BIẾN\": \"giá trị\"}: %w", TokenSavingEnv, err)
	}
	return TokenSavingConfig{Env: env}, nil
}

// savingJob áp mặc định lên cấu hình của dự án; false khi nhóm không áp cho run này (máy hay dự án tắt).
func savingJob(cfg TokenSavingConfig, job Job) (TokenSavingJob, bool) {
	if cfg.Off {
		return TokenSavingJob{}, false
	}
	ts := TokenSavingJob{Enabled: true}
	if job.TokenSaving != nil {
		ts = *job.TokenSaving
	}
	if !ts.Enabled {
		return ts, false
	}
	if ts.BashMaxChars <= 0 {
		ts.BashMaxChars = defaultBashMaxChars
	}
	if ts.AutocompactPct <= 0 {
		ts.AutocompactPct = defaultAutocompactPct
	}
	if ts.SubagentModel == "" {
		ts.SubagentModel = defaultSubagentModel
	}
	if ts.CacheTTL == "" {
		ts.CacheTTL = defaultCacheTTL
	}
	if ts.AutocompactWindow <= 0 {
		ts.AutocompactWindow = defaultAutocompactWindow
	}
	return ts, true
}

// savingEnv là biến môi trường tiết kiệm token cho run; nil khi không áp (CLI khác claude, máy hoặc dự án tắt).
// Thứ tự thắng: mặc định < spec của hub < cấu hình máy; job.Env của dự án thắng tất cả ở chỗ gọi (mergeMap).
//
// Chỉ claude: các CLI khác chưa có biến tương đương đã kiểm trong tài liệu chính thức nên không đặt gì (Codex nhận cấu
// hình qua `-c`, xem savingArgs). Biến có phiên bản tối thiểu (claudeMinVersion) chỉ đặt khi job.claudeVersion đủ.
func savingEnv(cfg TokenSavingConfig, job Job) map[string]string {
	if job.CLI != "claude" {
		return nil
	}
	ts, ok := savingJob(cfg, job)
	if !ok {
		return nil
	}
	env := map[string]string{
		// Output Bash dài bị đọc lại ở mọi lượt sau, nên cắt sớm rẻ hơn nhiều so với giữ nguyên.
		"BASH_MAX_OUTPUT_LENGTH": strconv.Itoa(ts.BashMaxChars),
		// Chỉ hạ được ngưỡng tự nén: nén sớm giữ ngữ cảnh dài của run khỏi phình tới p90 ~170k token.
		"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": strconv.Itoa(ts.AutocompactPct),
		// Subagent đọc/tìm là việc nhẹ; mặc định kế thừa model chính (thường Opus) làm chi phí subagent chiếm 30%.
		"CLAUDE_CODE_SUBAGENT_MODEL": ts.SubagentModel,
		// Run chạy liên tục, các lượt cách nhau vài phút nên cache 5 phút vẫn trúng mà ghi cache rẻ hơn 1 giờ. Run hay
		// có lượt cách nhau quá 5 phút (build hay test dài, chờ chỉ dẫn lâu) thì dự án đặt cacheTtl 1h, nếu không mỗi
		// lượt sau chỗ trống phải ghi lại cả ngữ cảnh.
		"CLAUDE_CODE_PROMPT_CACHE_TTL":          ts.CacheTTL,
		"CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL": ts.CacheTTL,
		"MAX_MCP_OUTPUT_TOKENS":                 defaultMCPOutputToken,
		// Cửa sổ ngữ cảnh tối đa trước khi nén; AUTOCOMPACT_PCT chỉ hạ ngưỡng theo phần trăm của cửa sổ này.
		"CLAUDE_CODE_AUTO_COMPACT_WINDOW": strconv.Itoa(ts.AutocompactWindow),
		// Bỏ skill đi kèm CLI khỏi prompt hệ thống (tài liệu env-vars của Claude Code); skill của dự án vẫn do repo/hub cấp.
		"CLAUDE_CODE_DISABLE_BUNDLED_SKILLS": "1",
		// Run dùng memory của hub (knowledge) nên tắt memory tự động của CLI.
		"CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
		"CLAUDE_CODE_DISABLE_WORKFLOWS":   "1",
		// Bỏ phần prompt CFC khỏi prompt hệ thống (tài liệu env-vars); run chạy không có trình duyệt.
		"CLAUDE_CODE_DISABLE_CFC_PROMPT":          "1",
		"CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS": defaultFileReadMaxTokens,
	}
	// Chỉ đặt khi phiên bản đủ: CLI cũ bỏ qua biến lạ nhưng khi đó FORCE không có tác dụng và mô tả MCP không bị cắt,
	// nên đặt cũng vô ích; chặn ở đây để log của run không khai điều không đúng.
	if claudeSupports(job.claudeVersion, "CLAUDE_CODE_SUBAGENT_MODEL_FORCE") {
		// CLAUDE_CODE_SUBAGENT_MODEL chỉ là mặc định: agent Explore có sẵn vẫn chạy model chính nếu thiếu FORCE.
		env["CLAUDE_CODE_SUBAGENT_MODEL_FORCE"] = "1"
	}
	if claudeSupports(job.claudeVersion, "CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH") {
		// Mô tả tool MCP của hub nằm trong prompt mỗi lượt.
		env["CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH"] = "512"
	}
	for k, v := range cfg.Env {
		if v == "" {
			delete(env, k)
		} else {
			env[k] = v
		}
	}
	return env
}

// savingArgs là cờ dòng lệnh của nhóm tiết kiệm token; nil khi nhóm không áp. Claude: cờ lọc theo phiên bản. Codex: các
// `-c`; Codex bỏ qua khoá cấu hình không biết (thử trên codex 0.162.1: `features list -c khoá_lạ=1` vẫn chạy, còn
// --strict-config mới báo "unknown configuration field"), nên không cần chặn theo phiên bản.
func savingArgs(cfg TokenSavingConfig, job Job) []string {
	ts, ok := savingJob(cfg, job)
	if !ok {
		return nil
	}
	code := !readOnlyKind(job.Kind)
	switch job.CLI {
	case "claude":
		flags := [][]string{
			// Chuyển cwd, git status, đường dẫn memory từ prompt hệ thống sang tin nhắn đầu: phần cố định của prompt giống
			// nhau giữa các máy nên cache prompt dùng lại được.
			{"--exclude-dynamic-system-prompt-sections"},
		}
		if code {
			flags = append(flags, []string{"--tools", claudeCodeTools})
			if !ts.AllowWeb {
				// Thừa với --tools nhưng giữ để run vẫn chặn web nếu ai đó nới danh sách tool.
				flags = append(flags, []string{"--disallowedTools", "WebFetch,WebSearch"})
			}
		}
		return claudeFlags(job.claudeVersion, flags)
	case "codex":
		args := []string{
			// Không cần tóm tắt suy luận hay bản tin dài dòng: chúng là output token và bị đọc lại trong ngữ cảnh.
			"-c", `model_reasoning_summary="none"`,
			"-c", `model_verbosity="low"`,
			"-c", "hide_agent_reasoning=true",
			"-c", "tool_output_token_limit=8000",
			"-c", "model_auto_compact_token_limit=150000",
			// Subagent của Codex làm việc đọc/tìm; effort thấp là đủ.
			"-c", `agents.default_subagent_reasoning_effort="low"`,
		}
		if code && !ts.AllowWeb {
			args = append(args, "-c", `web_search="disabled"`)
		}
		return args
	}
	return nil
}
