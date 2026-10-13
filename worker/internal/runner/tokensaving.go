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
)

// TokenSavingJob là mục tokenSaving trong spec job (settings dự án "Tiết kiệm token"). nil là hub cũ chưa gửi: dùng
// mặc định, bật. Trường số 0 hay chuỗi rỗng cũng dùng mặc định, để spec thiếu trường không tắt cả nhóm.
type TokenSavingJob struct {
	Enabled        bool   `json:"enabled"`
	BashMaxChars   int    `json:"bashMaxChars"`
	AutocompactPct int    `json:"autocompactPct"`
	SubagentModel  string `json:"subagentModel"`
	CacheTTL       string `json:"cacheTtl"`
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

// savingEnv là biến môi trường tiết kiệm token cho run; nil khi không áp (CLI khác claude, máy hoặc dự án tắt).
// Thứ tự thắng: mặc định < spec của hub < cấu hình máy; job.Env của dự án thắng tất cả ở chỗ gọi (mergeMap).
//
// Chỉ claude: các CLI khác chưa có biến tương đương đã kiểm trong tài liệu chính thức nên không đặt gì.
func savingEnv(cfg TokenSavingConfig, job Job) map[string]string {
	if job.CLI != "claude" || cfg.Off {
		return nil
	}
	ts := TokenSavingJob{Enabled: true}
	if job.TokenSaving != nil {
		ts = *job.TokenSaving
	}
	if !ts.Enabled {
		return nil
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
