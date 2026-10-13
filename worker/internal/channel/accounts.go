package channel

import (
	"slices"

	"github.com/tdduydev/xdev-hive/worker/internal/accounts"
	"github.com/tdduydev/xdev-hive/worker/internal/runner"
)

// capAccountsRemote: worker nhận account_set và đăng nhập gói từ web (specs/011 FR-044, T063).
const capAccountsRemote = "accounts-remote"

// featureShared: hub báo trong welcome rằng máy là máy dùng chung (ADR 0017).
const featureShared = "shared"

// capabilities là capability khai trong hello. Chỉ khai accounts-remote khi máy có accounts pool: runner host không có
// accounts.json nên không có gói để bật/tắt hay đăng nhập.
func (c Config) capabilities() []string {
	caps := runner.MachineCapabilities(c.Sandbox != nil)
	if c.Accounts != nil {
		caps = append(caps, capAccountsRemote)
	}
	return caps
}

// setShared ghi cờ máy dùng chung của phiên vừa nối; hub chỉ báo lại khi nối lại nên giữ tới phiên sau.
func (j *jobs) setShared(w Welcome) {
	j.mu.Lock()
	j.shared = slices.Contains(w.Features, featureShared)
	j.mu.Unlock()
}

// remoteAccounts: chỉ nhận lệnh gói từ hub khi máy có pool và hub đã báo máy dùng chung. Máy cá nhân dùng gói riêng của
// chủ máy, nên dù hub lỗi hay bị giả mạo cũng không được đổi gói của họ.
func (j *jobs) remoteAccounts() bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.shared && j.cfg.Accounts != nil
}

// accountSummaries là tóm tắt gói cho heartbeat; nil khi không có pool hay không đọc được file (hub giữ tóm tắt cũ).
func (j *jobs) accountSummaries() []accounts.Summary {
	p := j.cfg.Accounts
	if p == nil {
		return nil
	}
	list, err := accounts.Summaries(p.Path(), p.Home(), j.now())
	if err != nil {
		j.log.Warn("Không đọc được tài khoản CLI cho heartbeat", "error", err)
		return nil
	}
	// Không có tài khoản nào: gửi mảng rỗng chứ không bỏ trường, để hub xoá tóm tắt cũ khi người dùng xoá hết gói.
	if list == nil {
		list = []accounts.Summary{}
	}
	return list
}

func (j *jobs) onAccountSet(m *AccountSet) {
	if !j.remoteAccounts() {
		j.log.Warn("Bỏ lệnh bật/tắt gói: máy không phải máy dùng chung", "account", m.AccountID)
		return
	}
	if err := accounts.ApplySet(j.cfg.Accounts.Path(), m.AccountID, m.Enabled); err != nil {
		j.log.Warn("Không bật/tắt được gói theo lệnh hub", "account", m.AccountID, "error", err)
		return
	}
	j.log.Info("Hub đổi trạng thái gói", "account", m.AccountID, "enabled", m.Enabled)
	// Gửi heartbeat ngay để web thấy trạng thái thật mà không chờ chu kỳ kế.
	_ = j.write(j.heartbeat())
}

func (j *jobs) loginEvent(requestID string) accounts.LoginEvent {
	return func(kind, text, accountID string) {
		// Mất kết nối thì bỏ: hub đã kết thúc phiên ở phía nó khi máy ngắt.
		_ = j.write(AccountLoginEvent{Type: "account_login_event", V: protocolVersion, ID: newID(), RequestID: requestID, Kind: kind, Text: text, AccountID: accountID})
		if kind == accounts.LoginDone {
			_ = j.write(j.heartbeat())
		}
	}
}

func (j *jobs) onLoginStart(m *AccountLoginStart) {
	if !j.remoteAccounts() {
		j.loginEvent(m.RequestID)(accounts.LoginError, "Chỉ đăng nhập gói từ web trên máy dùng chung.", "")
		return
	}
	j.log.Info("Bắt đầu đăng nhập gói từ web", "cli", m.CLI, "how", m.How)
	j.cfg.Accounts.Login().Start(j.ctx, m.RequestID, m.CLI, m.Label, m.How, j.loginEvent(m.RequestID))
}

// onLoginInput không ghi log chữ dán: đó là mã xác nhận hay token.
func (j *jobs) onLoginInput(m *AccountLoginInput) {
	if j.cfg.Accounts == nil || !j.cfg.Accounts.Login().Input(m.RequestID, m.Text) {
		j.log.Warn("Bỏ chữ dán cho phiên đăng nhập không còn chạy")
	}
}

func (j *jobs) onLoginCancel(m *AccountLoginCancel) {
	if j.cfg.Accounts != nil && j.cfg.Accounts.Login().Cancel(m.RequestID) {
		j.log.Info("Hub huỷ phiên đăng nhập gói")
	}
}

// cancelLogin huỷ phiên đăng nhập khi mất kết nối: không còn ai trên web để dán mã hay nhận kết quả, và hub đã báo lỗi
// cho phiên đó.
func (j *jobs) cancelLogin() {
	if j.cfg.Accounts != nil {
		j.cfg.Accounts.Login().CancelAll()
	}
}
