package runner

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// validEffort: hub chỉ gửi low|medium|high (cả Claude Code lẫn Codex nhận); giá trị khác bị bỏ thay vì chuyển thẳng vào
// CLI, vì spec lạ không nên làm CLI thoát ngay vì tham số sai.
func validEffort(e string) bool { return e == "low" || e == "medium" || e == "high" }

// routingEnv đặt effort của Claude Code qua CLAUDE_CODE_EFFORT_LEVEL (có trong binary claude 2.1.296, thắng --effort)
// thay vì cờ: biến lạ bị CLI cũ bỏ qua, còn cờ lạ làm nó thoát. Codex nhận effort qua `-c`, xem codexRoutingArgs.
func routingEnv(job Job) map[string]string {
	if job.CLI != "claude" || !validEffort(job.Effort) {
		return nil
	}
	return map[string]string{"CLAUDE_CODE_EFFORT_LEVEL": job.Effort}
}

// telemetryEnv: các biến làm Claude Code tắt advisor im lặng (tài liệu advisor của Claude Code).
var telemetryEnv = []string{"DISABLE_TELEMETRY", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"}

func envTruthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "", "0", "false", "no", "off":
		return false
	}
	return true
}

// advisorBlocked: advisor tắt khi telemetry bị tắt, nên không truyền --advisor để run không tưởng có cố vấn.
func advisorBlocked(job Job) bool {
	for _, k := range telemetryEnv {
		if envTruthy(job.Env[k]) || envTruthy(job.savingEnv[k]) || envTruthy(os.Getenv(k)) {
			return true
		}
	}
	return false
}

// claudeRoutingArgs là cờ định tuyến của Claude Code: --max-turns từ budget (hub đặt theo cấp độ hay dự án đặt) và
// --advisor. Trả kèm dòng ghi vào log run khi bỏ cờ vì lý do người xem nên biết.
func claudeRoutingArgs(j Job) (args []string, notice string) {
	var flags [][]string
	if j.Budget.MaxTurns != nil && *j.Budget.MaxTurns > 0 {
		flags = append(flags, []string{"--max-turns", strconv.Itoa(*j.Budget.MaxTurns)})
	}
	if j.Advisor != "" {
		if advisorBlocked(j) {
			notice = "[xdev-hive] Bỏ --advisor " + j.Advisor + ": telemetry đang tắt (DISABLE_TELEMETRY hay CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) nên Claude Code tắt advisor."
		} else {
			flags = append(flags, []string{"--advisor", j.Advisor})
		}
	}
	return claudeFlags(j.claudeVersion, flags), notice
}

// codexRoutingArgs đặt effort suy luận của Codex theo cấp độ task.
func codexRoutingArgs(j Job) []string {
	if !validEffort(j.Effort) {
		return nil
	}
	return []string{"-c", fmt.Sprintf("model_reasoning_effort=%q", j.Effort)}
}

// cliStopReason là lý do tiếng Việt khi CLI tự dừng vì giới hạn của run; rỗng khi không phải.
func cliStopReason(subtype string, b Budget) string {
	switch subtype {
	case "error_max_turns":
		if b.MaxTurns != nil {
			return fmt.Sprintf("Dừng vì chạm giới hạn %d lượt của run (cấp độ task hoặc cài đặt dự án). Chia nhỏ task hoặc nâng số lượt tối đa rồi chạy lại.", *b.MaxTurns)
		}
		return "Dừng vì chạm giới hạn số lượt của run."
	case "error_max_budget_usd":
		if b.MaxCostUSD != nil {
			return fmt.Sprintf("Dừng vì chạm trần chi phí $%.4f của run.", *b.MaxCostUSD)
		}
		return "Dừng vì chạm trần chi phí của run."
	}
	return ""
}
