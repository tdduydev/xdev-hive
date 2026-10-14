package channel

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/pty"
	"github.com/tdduydev/xdev-hive/worker/internal/runner"
	"github.com/tdduydev/xdev-hive/worker/internal/terminal"
)

// capTerminal: worker giữ được phiên `claude` tương tác trong PTY (TERMINAL_CAPABILITY của hợp đồng).
const capTerminal = "terminal"

const msgTerminalNotShared = "Chỉ mở terminal Leader trên máy dùng chung."

// terminalCapable: runner host không có PTY cho người dùng gõ (CLI chạy trong container), Windows chưa có PTY, máy
// không có claude thì không khai.
func (c Config) terminalCapable() bool {
	return c.Sandbox == nil && pty.Supported && contains(c.CLIs, "claude")
}

func newTerminalHost(j *jobs) *terminal.Host {
	if !j.cfg.terminalCapable() {
		return nil
	}
	return &terminal.Host{
		Runner:   runner.Runner{DataDir: j.cfg.DataDir, CLICommands: j.cfg.CLICommands},
		Accounts: j.cfg.Accounts,
		Send:     j.sendTerminal,
		Logger:   j.log,
	}
}

// sendTerminal đổi Event của Host thành gói term_*. Mất kết nối thì bỏ: hub đã coi phiên hỏng khi máy ngắt, và
// detach đóng mọi phiên.
func (j *jobs) sendTerminal(e terminal.Event) error {
	switch e.Kind {
	case terminal.KindOpened:
		var label *string
		if e.AccountLabel != "" {
			label = &e.AccountLabel
		}
		return j.write(TermOpened{Type: "term_opened", V: protocolVersion, ID: newID(), SessionID: e.SessionID, AccountLabel: label, Permissions: e.Permissions})
	case terminal.KindOutput:
		return j.write(TermOutput{Type: "term_output", V: protocolVersion, ID: newID(), SessionID: e.SessionID, Seq: e.Seq, Data: e.Data})
	default:
		return j.write(TermExit{Type: "term_exit", V: protocolVersion, ID: newID(), SessionID: e.SessionID, ExitCode: e.ExitCode, Reason: e.Reason, Message: e.Message})
	}
}

func (j *jobs) termExit(sessionID, reason, message string) {
	_ = j.write(TermExit{Type: "term_exit", V: protocolVersion, ID: newID(), SessionID: sessionID, Reason: reason, Message: message})
}

// sharedMachine: hub đã báo máy dùng chung trong welcome của phiên hiện tại. Máy cá nhân không mở terminal cho người
// khác dù hub lỗi hay bị giả mạo.
func (j *jobs) sharedMachine() bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.shared
}

func (j *jobs) onTermOpen(m *TermOpen) {
	j.mu.Lock()
	draining := j.draining
	j.mu.Unlock()
	switch {
	case j.term == nil:
		j.termExit(m.SessionID, terminal.ReasonDenied, "Máy này không mở được terminal Leader.")
		return
	case !j.sharedMachine():
		j.log.Warn("Từ chối mở terminal Leader: máy không phải máy dùng chung", "session", m.SessionID)
		j.termExit(m.SessionID, terminal.ReasonDenied, msgTerminalNotShared)
		return
	case draining:
		j.termExit(m.SessionID, terminal.ReasonDenied, "Máy đang thoát, không mở phiên mới.")
		return
	case m.CLI != "claude":
		j.termExit(m.SessionID, terminal.ReasonDenied, "Terminal Leader chỉ chạy Claude Code.")
		return
	}
	list, err := j.projectList()
	if err != nil {
		j.termExit(m.SessionID, terminal.ReasonError, "Không đọc được projects.json: "+err.Error())
		return
	}
	var saving *runner.TokenSavingJob
	if len(m.TokenSaving) > 0 && string(m.TokenSaving) != "null" {
		var ts runner.TokenSavingJob
		if err := json.Unmarshal(m.TokenSaving, &ts); err == nil {
			saving = &ts
		}
	}
	spec := runner.InteractiveSpec{
		SessionID: m.SessionID, ProjectID: strings.ToLower(m.ProjectID), ProjectKey: m.ProjectKey,
		RepoURL: normalizeRepoURL(m.RepoURL), BaseBranch: m.BaseBranch, HubURL: j.cfg.HubURL,
		Model: m.Model, Effort: m.Effort, Advisor: m.Advisor,
		RunPermissions: m.RunPermissions, FullAllowed: m.FullAllowed,
		MCPToken: m.MCPToken, SystemPrompt: m.SystemPrompt, TokenSaving: saving, Projects: list,
	}
	j.log.Info("Mở terminal Leader", "session", m.SessionID, "project", m.ProjectKey, "mode", m.Mode)
	j.term.Open(j.ctx, terminal.OpenRequest{SessionID: m.SessionID, AccountID: m.AccountID, Cols: m.Cols, Rows: m.Rows, Spec: spec})
}

func (j *jobs) onTermInput(m *TermInput) {
	if j.term != nil {
		j.term.Input(m.SessionID, m.Data)
	}
}

func (j *jobs) onTermResize(m *TermResize) {
	if j.term != nil {
		j.term.Resize(m.SessionID, m.Cols, m.Rows)
	}
}

func (j *jobs) onTermClose(m *TermClose) {
	if j.term != nil {
		j.term.Close(m.SessionID, m.Reason)
	}
}

// closeTerminals đóng mọi phiên khi mất kết nối hub: hub coi phiên đã hỏng khi máy ngắt, không ai còn xem phiên đó.
func (j *jobs) closeTerminals(message string) {
	if j.term != nil {
		j.term.CloseAll(message)
	}
}

// waitTerminals đóng và chờ mọi phiên dọn worktree khi worker tắt.
func (j *jobs) waitTerminals(timeout time.Duration) {
	if j.term == nil {
		return
	}
	j.term.CloseAll("Worker đang tắt.")
	if !j.term.Wait(timeout) {
		j.log.Warn("Phiên terminal chưa dọn xong khi worker thoát; lần khởi động sau sẽ dọn worktree còn lại")
	}
}
