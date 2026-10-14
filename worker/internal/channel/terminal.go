package channel

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/pty"
	"github.com/tdduydev/xdev-hive/worker/internal/runner"
	"github.com/tdduydev/xdev-hive/worker/internal/terminal"
)

// capTerminal: worker giữ được phiên `claude` tương tác trong PTY (TERMINAL_CAPABILITY của hợp đồng).
const capTerminal = "terminal"

// featureTerminal: hub khai trong welcome.features rằng nó hiểu các gói term_* của máy cá nhân (specs/010 D14).
const featureTerminal = "terminal"

const msgTerminalNotShared = "Chỉ mở terminal Leader trên máy dùng chung."

// terminalCapable: runner host không có PTY cho người dùng gõ (CLI chạy trong container), Windows không có ConPTY, máy
// không có claude thì không khai.
func (c Config) terminalCapable() bool {
	return c.Sandbox == nil && pty.Supported && contains(c.CLIs, "claude")
}

// helloCapabilities thêm capability terminal khi máy có Handler điều khiển từ xa dù không giữ được phiên Leader (máy cá
// nhân không nhất thiết có claude hay accounts pool); đã khai vì terminalCapable thì không khai lần hai.
func (c Config) helloCapabilities() []string {
	caps := c.capabilities()
	if c.Terminal != nil && !contains(caps, capTerminal) {
		caps = append(caps, capTerminal)
	}
	return caps
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

// onTermClose chuyển cho cả Host (phiên Leader) và Handler (phiên trên máy cá nhân): mã phiên là của hub nên chỉ một
// bên có, bên kia bỏ qua.
func (j *jobs) onTermClose(m *TermClose) {
	if j.term != nil {
		j.term.Close(m.SessionID, m.Reason)
	}
	if h := j.cfg.Terminal; h != nil {
		h.CloseSession(terminal.CloseRequest{SessionID: m.SessionID, Reason: m.Reason, By: m.By})
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

// termLink là Sender của một phiên kênh: gắn với ctx của phiên nên Sender cũ chết theo kết nối cũ, không ghi nhầm sang
// kết nối sau (hub mới nối có thể không khai terminal).
type termLink struct {
	j       *jobs
	ctx     context.Context
	enabled bool
}

var _ terminal.Sender = (*termLink)(nil)

func newTermLink(ctx context.Context, j *jobs, w Welcome) *termLink {
	return &termLink{j: j, ctx: ctx, enabled: slices.Contains(w.Features, featureTerminal)}
}

func welcomeInfo(w Welcome) terminal.WelcomeInfo {
	info := terminal.WelcomeInfo{Features: slices.Clone(w.Features), Terminal: slices.Contains(w.Features, featureTerminal)}
	if w.Owner != nil {
		info.Owner = &terminal.WelcomeOwner{UserID: w.Owner.UserID, Shared: w.Owner.Shared}
	}
	if w.Policy != nil {
		info.Policy = &terminal.WelcomePolicy{TOTPFallback: w.Policy.TOTPFallback}
	}
	return info
}

func (l *termLink) Enabled() bool { return l.enabled && l.ctx.Err() == nil }

func (l *termLink) send(v any) error {
	if !l.Enabled() {
		return terminal.ErrHubNoTerminal
	}
	return l.j.write(v)
}

// nonNil: hub đòi mảng, không nhận null; slice nil của Go mã hoá thành null.
func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

func (l *termLink) State(s terminal.State) error {
	m := TermState{Type: "term_state", V: protocolVersion, ID: newID(), Enabled: s.Enabled, ConfirmOnMachine: s.ConfirmOnMachine,
		TOTP: TermStateTOTP{Enabled: s.TOTP.Enabled, Locked: s.TOTP.Locked, LockedUntil: s.TOTP.LockedUntil},
		CLIs: nonNil(s.CLIs), Roots: []TermStateRoot{}, Accounts: []TermStateAccount{}, Devices: []TermStateDevice{}, Sessions: []TermStateSession{}}
	for _, r := range s.Roots {
		m.Roots = append(m.Roots, TermStateRoot{ID: r.ID, Label: r.Label})
	}
	for _, a := range s.Accounts {
		m.Accounts = append(m.Accounts, TermStateAccount{ID: a.ID, Label: a.Label, CLI: a.CLI, State: a.State})
	}
	for _, d := range s.Devices {
		m.Devices = append(m.Devices, TermStateDevice{ID: d.ID, Label: d.Label, UserID: d.UserID, Synced: d.Synced})
	}
	for _, x := range s.Sessions {
		m.Sessions = append(m.Sessions, TermStateSession{ID: x.ID, Origin: x.Origin, Controller: x.Controller})
	}
	return l.send(m)
}

func (l *termLink) Denied(d terminal.Denied) error {
	return l.send(TermDenied{Type: "term_denied", V: protocolVersion, ID: newID(), RequestID: d.RequestID, Code: d.Code, Reason: d.Reason})
}

func (l *termLink) Opened(o terminal.Opened) error {
	return l.send(TermOpened{Type: "term_opened", V: protocolVersion, ID: newID(), SessionID: o.SessionID, AccountLabel: o.AccountLabel, Permissions: o.Permissions,
		Origin: o.Origin, RequestID: o.RequestID, CLI: o.CLI, CwdLabel: o.CwdLabel, ProjectID: o.ProjectID, TaskID: o.TaskID, Cols: o.Cols, Rows: o.Rows, Record: o.Record, Remote: o.Remote})
}

func (l *termLink) Output(sessionID string, seq int64, data []byte) error {
	return l.send(TermOutput{Type: "term_output", V: protocolVersion, ID: newID(), SessionID: sessionID, Seq: seq, Data: data})
}

func (l *termLink) Exit(e terminal.Exit) error {
	return l.send(TermExit{Type: "term_exit", V: protocolVersion, ID: newID(), SessionID: e.SessionID, ExitCode: e.ExitCode, Reason: e.Reason, Message: e.Message, By: e.By})
}

func (l *termLink) Event(e terminal.SessionEvent) error {
	m := TermEvent{Type: "term_event", V: protocolVersion, ID: newID(), SessionID: e.SessionID, Seq: e.Seq, Event: e.Event}
	if len(e.Data) > 0 {
		m.Data = json.RawMessage(e.Data)
	}
	return l.send(m)
}

func (l *termLink) Granted(g terminal.Granted) error {
	return l.send(TermGranted{Type: "term_granted", V: protocolVersion, ID: newID(), SessionID: g.SessionID, ConnID: g.ConnID, WorkerEphPub: g.WorkerEphPub, ResumeToken: g.ResumeToken})
}

func (l *termLink) Revoked(r terminal.Revoked) error {
	return l.send(TermRevoked{Type: "term_revoked", V: protocolVersion, ID: newID(), SessionID: r.SessionID, ConnID: r.ConnID, Reason: r.Reason})
}

func (l *termLink) PairResult(r terminal.PairResult) error {
	return l.send(TermPairResult{Type: "term_pair_result", V: protocolVersion, ID: newID(), PairID: r.PairID, OK: r.OK, DeviceID: r.DeviceID, Reason: r.Reason})
}

// isRemoteTerm: gói điều khiển phiên trên máy cá nhân. term_input/term_resize chỉ thuộc nhóm này khi có connId; không
// có thì là phím của phiên Leader trên máy dùng chung (Host).
func isRemoteTerm(m any) bool {
	switch v := m.(type) {
	case *TermStart, *TermControl, *TermDetach, *TermAck, *TermDisable, *TermPair, *TermDeviceRevoke:
		return true
	case *TermInput:
		return v.ConnID != ""
	case *TermResize:
		return v.ConnID != ""
	}
	return false
}

// routeRemote chuyển gói điều khiển từ xa của hub tới Handler; false là gói không thuộc nhóm này. Hub chưa khai
// terminal hay máy chưa có Handler thì bỏ gói và ghi log: worker không bao giờ đóng kênh vì gói term_* này.
func (j *jobs) routeRemote(link *termLink, m any) bool {
	if !isRemoteTerm(m) {
		return false
	}
	h := j.cfg.Terminal
	if h == nil || !link.enabled {
		j.log.Info("Bỏ gói điều khiển terminal từ xa: máy chưa hỗ trợ hoặc hub chưa khai terminal", "type", fmt.Sprintf("%T", m), "handler", h != nil, "hubTerminal", link.enabled)
		return true
	}
	switch v := m.(type) {
	case *TermStart:
		h.Start(terminal.StartRequest{RequestID: v.RequestID, UserID: v.UserID, DeviceID: v.DeviceID, CLI: v.CLI, AccountID: v.AccountID, RootID: v.RootID, Subdir: v.Subdir,
			Model: v.Model, Permissions: v.Permissions, ProjectID: v.ProjectID, TaskID: v.TaskID, Prompt: v.Prompt, Cols: v.Cols, Rows: v.Rows, Auth: toAuth(v.Auth)})
	case *TermControl:
		req := terminal.ControlRequest{SessionID: v.SessionID, ConnID: v.ConnID, UserID: v.UserID, DeviceID: v.DeviceID, ResumeToken: v.ResumeToken}
		if v.Auth != nil {
			a := toAuth(*v.Auth)
			req.Auth = &a
		}
		h.Control(req)
	case *TermDetach:
		h.Detach(terminal.DetachRequest{SessionID: v.SessionID, ConnID: v.ConnID})
	case *TermAck:
		h.Ack(terminal.AckRequest{SessionID: v.SessionID, Upto: v.Upto})
	case *TermInput:
		h.Input(terminal.InputRequest{SessionID: v.SessionID, ConnID: v.ConnID, Data: v.Data, Seq: v.Seq, MAC: v.MAC})
	case *TermResize:
		h.Resize(terminal.ResizeRequest{SessionID: v.SessionID, ConnID: v.ConnID, Cols: v.Cols, Rows: v.Rows, Seq: v.Seq, MAC: v.MAC})
	case *TermDisable:
		h.Disable(terminal.DisableRequest{By: v.By})
	case *TermPair:
		h.Pair(terminal.PairRequest{PairID: v.PairID, UserID: v.UserID, Label: v.Label, CredentialID: v.CredentialID, SPKI: v.SPKI, Tag: v.Tag})
	case *TermDeviceRevoke:
		h.DeviceRevoke(terminal.DeviceRevokeRequest{DeviceID: v.DeviceID, By: v.By})
	}
	return true
}

func toAuth(a RemoteAuth) terminal.Auth {
	out := terminal.Auth{Kind: a.Kind, Code: a.Code, EphPub: a.EphPub, TS: a.TS, Nonce: a.Nonce}
	if w := a.Assertion; w != nil {
		out.Assertion = &terminal.Assertion{CredentialID: w.CredentialID, AuthenticatorData: w.AuthenticatorData, ClientDataJSON: w.ClientDataJSON, Signature: w.Signature, UserHandle: w.UserHandle}
	}
	return out
}
