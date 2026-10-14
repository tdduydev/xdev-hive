package runner

import "strconv"

// Mức của bộ tối ưu token cho phiên tương tác (app client, specs/015-client-token-optimizer). Rỗng là PresetBalanced.
const (
	PresetOff        = "off"
	PresetBalanced   = "balanced"
	PresetAggressive = "aggressive"
)

// Giá trị chỉ phiên tương tác dùng; phần còn lại lấy chung hằng số với run (tokensaving.go). Lý do từng giá trị nằm ở
// bảng Preset trong plan.md.
const (
	// Phiên tương tác cần giữ ngữ cảnh lâu hơn run nên nén muộn hơn mặc định của run.
	balancedAutocompactPct = 80
	// Read chiếm 41% phần bị đọc lại ở phiên tương tác.
	aggressiveFileReadMaxTokens = "10000"
	aggressiveMCPOutputToken    = "10000"
	aggressiveCodexToolOutput   = "6000"
	aggressiveCodexAutoCompact  = "120000"
)

// Preset là cấu hình tối ưu cho phiên tương tác của một CLI. Bên cài (package optimizer) không import runner nên mọi
// trường là dữ liệu thuần.
type Preset struct {
	// Env là khối env của settings.json (Claude Code).
	Env map[string]string `json:"env,omitempty"`
	// Codex là khoá của config.toml, giá trị đã ở dạng TOML.
	Codex map[string]string `json:"codex,omitempty"`
	// Hooks là tên lệnh `hive-worker hook <tên> --local` cần cài; InteractiveHook cho event và matcher.
	Hooks []string `json:"hooks,omitempty"`
	// HookExec: CLI nhận hook dạng exec (command + args). false thì Unix dùng dạng shell, Windows không cài hook.
	HookExec bool `json:"hookExec"`
	// Skipped là phần bị bỏ vì CLI chưa đủ phiên bản (hoặc không đọc được phiên bản), để màn tối ưu nói rõ cho người dùng.
	Skipped []SkipReason `json:"skipped,omitempty"`
}

// PresetOptions là tuỳ chọn bật riêng, ngoài mức. ContextPack (thử nghiệm, mặc định tắt) cài hook prompt dựng context
// pack ở prompt đầu tiên của phiên (contextpack_local.go): pack tiêm vào ngữ cảnh mà không chắc trúng, nên người dùng
// phải tự chọn.
type PresetOptions struct {
	ContextPack bool `json:"contextPack"`
}

// SkipReason: Key là biến, tên hook, hoặc "hook-args" (dạng exec); MinVersion lấy từ claudeMinVersion.
type SkipReason struct {
	Key        string `json:"key"`
	MinVersion string `json:"minVersion"`
}

// interactiveHooks dùng cùng event và matcher với hook của run (prepareGuard), để hai bên cắt cùng loại output.
var interactiveHooks = map[string]Hook{
	"pre-tool":  {Event: "PreToolUse", Name: "pre-tool", Command: "pre-tool", Matcher: "Bash|Read|Edit|Write|MultiEdit|NotebookEdit"},
	"post-tool": {Event: "PostToolUse", Name: "post-tool", Command: "post-tool", Matcher: "Bash|Grep|mcp__.*"},
	"prompt":    {Event: "UserPromptSubmit", Name: "prompt", Command: "prompt"},
}

// InteractiveHook trả event và matcher của một hook trong Preset.Hooks.
func InteractiveHook(name string) (Hook, bool) {
	h, ok := interactiveHooks[name]
	return h, ok
}

// InteractivePreset là preset cho phiên người dùng tự mở CLI. Khác preset của run ở chỗ không đặt cache TTL, không tắt
// auto memory, skill đi kèm hay workflow: người dùng cần chúng khi làm tay, và phiên tương tác hay nghỉ quá 5 phút.
// Mức lạ hay "off" ra preset rỗng; CLI chưa có preset (gemini, antigravity) cũng vậy.
func InteractivePreset(cli, version, level string) Preset {
	return InteractivePresetWith(cli, version, level, PresetOptions{})
}

// InteractivePresetWith như InteractivePreset, thêm tuỳ chọn. Codex chưa có hook nên bỏ qua ContextPack.
func InteractivePresetWith(cli, version, level string, opts PresetOptions) Preset {
	if level == "" {
		level = PresetBalanced
	}
	if level != PresetBalanced && level != PresetAggressive {
		return Preset{}
	}
	aggressive := level == PresetAggressive
	switch cli {
	case "claude":
		return claudePreset(version, aggressive, opts)
	case "codex":
		p := Preset{Codex: map[string]string{
			"tool_output_token_limit":        codexToolOutputLimit,
			"model_auto_compact_token_limit": codexAutoCompactLimit,
		}}
		if aggressive {
			p.Codex["tool_output_token_limit"] = aggressiveCodexToolOutput
			p.Codex["model_auto_compact_token_limit"] = aggressiveCodexAutoCompact
		}
		return p
	}
	return Preset{}
}

func claudePreset(version string, aggressive bool, opts PresetOptions) Preset {
	p := Preset{Env: map[string]string{
		// Đòn bẩy chính: 84% chi phí tương tác nằm ở phiên vượt 400k token.
		"CLAUDE_CODE_AUTO_COMPACT_WINDOW":         strconv.Itoa(defaultAutocompactWindow),
		"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE":         strconv.Itoa(balancedAutocompactPct),
		"BASH_MAX_OUTPUT_LENGTH":                  strconv.Itoa(defaultBashMaxChars),
		"CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS": defaultFileReadMaxTokens,
		"MAX_MCP_OUTPUT_TOKENS":                   defaultMCPOutputToken,
	}}
	skip := func(key, feature string) {
		p.Skipped = append(p.Skipped, SkipReason{Key: key, MinVersion: claudeMinVersion[feature]})
	}
	gated := func(key, value string) {
		if !setGated(p.Env, version, key, value) {
			skip(key, key)
		}
	}
	if aggressive {
		p.Env["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"] = strconv.Itoa(defaultAutocompactPct)
		p.Env["CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS"] = aggressiveFileReadMaxTokens
		p.Env["MAX_MCP_OUTPUT_TOKENS"] = aggressiveMCPOutputToken
		// Chỉ ở mức mạnh: đổi chất lượng subagent nên người dùng phải tự chọn. Cắt mô tả MCP cũng vậy vì model có thể
		// hiểu sai tool MCP lạ.
		p.Env["CLAUDE_CODE_SUBAGENT_MODEL"] = defaultSubagentModel
		gated("CLAUDE_CODE_SUBAGENT_MODEL_FORCE", "1")
		gated("CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH", mcpDescriptionLength)
	}
	// Hook pre-tool chỉ nhắc (additionalContext), chạy được ở dạng shell nên CLI cũ vẫn cài trên Unix.
	p.Hooks = append(p.Hooks, "pre-tool")
	if claudeSupports(version, "updatedToolOutput") {
		p.Hooks = append(p.Hooks, "post-tool")
	} else {
		skip("post-tool", "updatedToolOutput")
	}
	if opts.ContextPack {
		p.Hooks = append(p.Hooks, "prompt")
	}
	if p.HookExec = claudeSupports(version, "hook-args"); !p.HookExec {
		skip("hook-args", "hook-args")
	}
	return p
}
