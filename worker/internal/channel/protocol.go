package channel

import (
	"encoding/json"

	"github.com/tdduydev/xdev-hive/worker/internal/accounts"
	"github.com/tdduydev/xdev-hive/worker/internal/runner"
)

// Kiểu gói của giao thức worker ↔ hub (docs/architecture.md mục 5). Nguồn chuẩn là zod trong
// packages/contracts/src/worker-protocol.ts; protocol_test.go đọc chung file mẫu với test TypeScript để hai bên khớp.

// Envelope là phần đầu chung của mọi gói, đủ để biết loại gói trước khi giải mã cả gói.
type Envelope struct {
	Type string `json:"type"`
	V    int    `json:"v"`
	ID   string `json:"id"`
}

// ---- Worker → hub ----

type Hello struct {
	Type       string   `json:"type"`
	V          int      `json:"v"`
	ID         string   `json:"id"`
	MachineID  string   `json:"machineId"`
	Version    string   `json:"version"`
	ProtoRange [2]int   `json:"protoRange"`
	OS         string   `json:"os"`
	RunnerMode string   `json:"runnerMode,omitempty"`
	CPUCount   int      `json:"cpuCount,omitempty"`
	MemoryMB   uint64   `json:"memoryMB,omitempty"`
	CLIs       []string `json:"clis"`
	Capacity   int      `json:"capacity"`
	// Capabilities: việc ngoài run code worker làm được (runner.Capabilities).
	Capabilities []string `json:"capabilities,omitempty"`
	ResumeRuns   []string `json:"resumeRuns"`
	// LocalProjects nil với runner host: hub hiểu là máy chưa gắn dự án nào, như worker cũ.
	LocalProjects *LocalProjects `json:"localProjects,omitempty"`
}

// LocalProjects là dự án máy đã gắn repo và dự án máy cho toàn quyền (projects.json, ADR 0020), để hub biết máy nào
// chạy được run cần toàn quyền (Antigravity).
type LocalProjects struct {
	Bound []string `json:"bound"`
	Full  []string `json:"full"`
}

type HeartbeatRun struct {
	RunID   string `json:"runId"`
	Attempt int    `json:"attempt"`
	LeaseID string `json:"leaseId"`
}

type Heartbeat struct {
	Type string         `json:"type"`
	V    int            `json:"v"`
	ID   string         `json:"id"`
	Load int            `json:"load"`
	Runs []HeartbeatRun `json:"runs"`
	// LocalProjects gửi lại mỗi heartbeat, để công tắc đổi trong app tới hub mà không cần nối lại.
	LocalProjects *LocalProjects `json:"localProjects,omitempty"`
	// Accounts là tóm tắt tài khoản CLI (không token, không email); nil khi máy không có accounts pool (runner host) hay
	// không đọc được file, để hub giữ tóm tắt cũ. Con trỏ để danh sách rỗng vẫn gửi là [] (omitempty bỏ slice rỗng).
	Accounts *[]accounts.Summary `json:"accounts,omitempty"`
}

type JobAccept struct {
	Type    string `json:"type"`
	V       int    `json:"v"`
	ID      string `json:"id"`
	RunID   string `json:"runId"`
	Attempt int    `json:"attempt"`
}

type JobReject struct {
	Type    string `json:"type"`
	V       int    `json:"v"`
	ID      string `json:"id"`
	RunID   string `json:"runId"`
	Attempt int    `json:"attempt"`
	Reason  string `json:"reason"`
}

// RunEvent dùng `event` cho loại sự kiện vì `type` đã là loại gói.
type RunEvent struct {
	Type    string          `json:"type"`
	V       int             `json:"v"`
	ID      string          `json:"id"`
	RunID   string          `json:"runId"`
	Attempt int             `json:"attempt"`
	Seq     int64           `json:"seq"`
	Event   string          `json:"event"`
	Data    json.RawMessage `json:"data"`
}

// LogChunk: encoding/json mã hoá []byte thành base64, đúng như hợp đồng đòi.
type LogChunk struct {
	Type    string `json:"type"`
	V       int    `json:"v"`
	ID      string `json:"id"`
	RunID   string `json:"runId"`
	Attempt int    `json:"attempt"`
	Seq     int64  `json:"seq"`
	Offset  int64  `json:"offset"`
	Bytes   []byte `json:"bytes"`
}

type RunResult struct {
	Type    string `json:"type"`
	V       int    `json:"v"`
	ID      string `json:"id"`
	RunID   string `json:"runId"`
	Attempt int    `json:"attempt"`
	Seq     int64  `json:"seq"`
	Exit    int    `json:"exit"`
	// HeadSHA nil khi agent không tạo commit; vẫn gửi `null` vì hợp đồng đòi có trường.
	HeadSHA   *string           `json:"headSha"`
	Report    json.RawMessage   `json:"report"`
	DiffStats *runner.DiffStats `json:"diffStats,omitempty"`
}

// ---- Hub → worker ----

type Welcome struct {
	Type           string `json:"type"`
	V              int    `json:"v"`
	ID             string `json:"id"`
	SessionID      string `json:"sessionId"`
	HeartbeatSec   int    `json:"heartbeatSec"`
	AccessTokenExp string `json:"accessTokenExp,omitempty"`
	// Features là điều hub cho máy này (vd. "shared"); hub cũ không gửi.
	Features []string `json:"features,omitempty"`
	// Owner, Policy chỉ hub có điều khiển từ xa gửi (specs/010 D14); nil là hub cũ.
	Owner  *WelcomeOwner  `json:"owner,omitempty"`
	Policy *WelcomePolicy `json:"policy,omitempty"`
}

type WelcomeOwner struct {
	UserID string `json:"userId"`
	Shared bool   `json:"shared"`
}

// WelcomePolicy chỉ dùng để tắt: TOTPFallback false thì worker từ chối TOTP dù chủ máy đã bật.
type WelcomePolicy struct {
	TOTPFallback bool `json:"totpFallback"`
}

type UpgradeRequired struct {
	Type   string `json:"type"`
	V      int    `json:"v"`
	ID     string `json:"id"`
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Sig    string `json:"sig"`
}

type HeartbeatAck struct {
	Type    string   `json:"type"`
	V       int      `json:"v"`
	ID      string   `json:"id"`
	Renewed []string `json:"renewed"`
	Cancel  []string `json:"cancel"`
}

type JobOffer struct {
	Type    string          `json:"type"`
	V       int             `json:"v"`
	ID      string          `json:"id"`
	RunID   string          `json:"runId"`
	Attempt int             `json:"attempt"`
	Spec    json.RawMessage `json:"spec"`
	TTL     int             `json:"ttl"`
}

type Lease struct {
	Type      string `json:"type"`
	V         int    `json:"v"`
	ID        string `json:"id"`
	RunID     string `json:"runId"`
	Attempt   int    `json:"attempt"`
	LeaseID   string `json:"leaseId"`
	ExpiresAt string `json:"expiresAt"`
	RunToken  string `json:"runToken"`
}

type Ack struct {
	Type    string `json:"type"`
	V       int    `json:"v"`
	ID      string `json:"id"`
	RunID   string `json:"runId"`
	UptoSeq int64  `json:"uptoSeq"`
}

// Steer: Attempt và SteerID do hub mới gửi. Chỉ khi có SteerID worker mới báo lại bằng run_event "steer_result".
type Steer struct {
	Type    string `json:"type"`
	V       int    `json:"v"`
	ID      string `json:"id"`
	RunID   string `json:"runId"`
	Attempt int    `json:"attempt,omitempty"`
	SteerID string `json:"steerId,omitempty"`
	Input   string `json:"input"`
}

type ApprovalResult struct {
	Type      string `json:"type"`
	V         int    `json:"v"`
	ID        string `json:"id"`
	RunID     string `json:"runId"`
	RequestID string `json:"requestId"`
	// Decision là "approve" hoặc "deny".
	Decision string `json:"decision"`
}

type Cancel struct {
	Type     string `json:"type"`
	V        int    `json:"v"`
	ID       string `json:"id"`
	RunID    string `json:"runId"`
	GraceSec int    `json:"graceSec"`
}

type Drain struct {
	Type string `json:"type"`
	V    int    `json:"v"`
	ID   string `json:"id"`
}

// Update là lệnh tự cập nhật admin bấm trên web. Version rỗng là bản mới nhất.
type Update struct {
	Type    string `json:"type"`
	V       int    `json:"v"`
	ID      string `json:"id"`
	Version string `json:"version,omitempty"`
}

// AccountSet bật hoặc tắt một tài khoản CLI trên máy dùng chung (specs/011 FR-044).
type AccountSet struct {
	Type      string `json:"type"`
	V         int    `json:"v"`
	ID        string `json:"id"`
	AccountID string `json:"accountId"`
	Enabled   bool   `json:"enabled"`
}

// AccountLoginStart mở một phiên đăng nhập gói mới ngay trên máy không màn hình (T063).
type AccountLoginStart struct {
	Type      string `json:"type"`
	V         int    `json:"v"`
	ID        string `json:"id"`
	RequestID string `json:"requestId"`
	CLI       string `json:"cli"`
	Label     string `json:"label"`
	How       string `json:"how"`
}

// AccountLoginInput là chữ người dùng dán trên web (mã xác nhận hay token); không được ghi log.
type AccountLoginInput struct {
	Type      string `json:"type"`
	V         int    `json:"v"`
	ID        string `json:"id"`
	RequestID string `json:"requestId"`
	Text      string `json:"text"`
}

type AccountLoginCancel struct {
	Type      string `json:"type"`
	V         int    `json:"v"`
	ID        string `json:"id"`
	RequestID string `json:"requestId"`
}

// AccountLoginEvent là bước đăng nhập worker báo hub: chỉ URL, mã thiết bị và lời nhắc cố định, không có output thô.
type AccountLoginEvent struct {
	Type      string `json:"type"`
	V         int    `json:"v"`
	ID        string `json:"id"`
	RequestID string `json:"requestId"`
	Kind      string `json:"kind"`
	Text      string `json:"text"`
	AccountID string `json:"accountId,omitempty"`
}

// ---- Terminal Leader (specs/010 lát đầu) ----

// TermOpened: PTY đã chạy. AccountLabel nil khi chạy bằng đăng nhập mặc định của CLI.
type TermOpened struct {
	Type         string  `json:"type"`
	V            int     `json:"v"`
	ID           string  `json:"id"`
	SessionID    string  `json:"sessionId"`
	AccountLabel *string `json:"accountLabel"`
	Permissions  string  `json:"permissions"`
	// Các trường dưới chỉ có ở phiên trên máy cá nhân; phiên Leader (term_open) bỏ trống để hub cũ vẫn nhận.
	Origin    string `json:"origin,omitempty"`
	RequestID string `json:"requestId,omitempty"`
	CLI       string `json:"cli,omitempty"`
	CwdLabel  string `json:"cwdLabel,omitempty"`
	ProjectID string `json:"projectId,omitempty"`
	TaskID    string `json:"taskId,omitempty"`
	Cols      int    `json:"cols,omitempty"`
	Rows      int    `json:"rows,omitempty"`
	Record    *bool  `json:"record,omitempty"`
	Remote    *bool  `json:"remote,omitempty"`
}

// TermOutput: Data là byte thô của PTY đã che bí mật; encoding/json mã hoá base64 như hợp đồng đòi.
type TermOutput struct {
	Type      string `json:"type"`
	V         int    `json:"v"`
	ID        string `json:"id"`
	SessionID string `json:"sessionId"`
	Seq       int64  `json:"seq"`
	Data      []byte `json:"data"`
}

// TermExit: ExitCode nil khi CLI không tự thoát (đóng, không hoạt động, từ chối, lỗi); vẫn gửi `null`.
type TermExit struct {
	Type      string `json:"type"`
	V         int    `json:"v"`
	ID        string `json:"id"`
	SessionID string `json:"sessionId"`
	ExitCode  *int   `json:"exitCode"`
	Reason    string `json:"reason"`
	Message   string `json:"message,omitempty"`
	By        string `json:"by,omitempty"`
}

// TermOpen mở phiên `claude` tương tác. MCPToken chỉ đi vào file --mcp-config 0600 và bị che khỏi output; không ghi log.
type TermOpen struct {
	Type           string          `json:"type"`
	V              int             `json:"v"`
	ID             string          `json:"id"`
	SessionID      string          `json:"sessionId"`
	ProjectID      string          `json:"projectId"`
	PlanID         string          `json:"planId,omitempty"`
	Mode           string          `json:"mode"`
	Cols           int             `json:"cols"`
	Rows           int             `json:"rows"`
	CLI            string          `json:"cli"`
	RepoURL        string          `json:"repoUrl"`
	BaseBranch     string          `json:"baseBranch"`
	ProjectKey     string          `json:"projectKey"`
	AccountID      string          `json:"accountId,omitempty"`
	Model          string          `json:"model"`
	Effort         string          `json:"effort,omitempty"`
	Advisor        string          `json:"advisor,omitempty"`
	RunPermissions string          `json:"runPermissions"`
	FullAllowed    bool            `json:"fullAllowed"`
	MCPToken       string          `json:"mcpToken"`
	SystemPrompt   string          `json:"systemPrompt"`
	TokenSaving    json.RawMessage `json:"tokenSaving,omitempty"`
}

// TermInput là phím người mở gõ; Data base64 trong JSON. Phiên điều khiển từ xa thêm ConnID, Seq, MAC
// (remoteauth.InputMACPayload); phiên Leader trên máy dùng chung không có.
type TermInput struct {
	Type      string `json:"type"`
	V         int    `json:"v"`
	ID        string `json:"id"`
	SessionID string `json:"sessionId"`
	Data      []byte `json:"data"`
	ConnID    string `json:"connId,omitempty"`
	Seq       *int64 `json:"seq,omitempty"`
	MAC       string `json:"mac,omitempty"`
}

type TermResize struct {
	Type      string `json:"type"`
	V         int    `json:"v"`
	ID        string `json:"id"`
	SessionID string `json:"sessionId"`
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
	ConnID    string `json:"connId,omitempty"`
	Seq       *int64 `json:"seq,omitempty"`
	MAC       string `json:"mac,omitempty"`
}

type TermClose struct {
	Type      string `json:"type"`
	V         int    `json:"v"`
	ID        string `json:"id"`
	SessionID string `json:"sessionId"`
	Reason    string `json:"reason,omitempty"`
	By        string `json:"by,omitempty"`
}

// ---- Điều khiển từ xa phiên trên máy cá nhân (specs/010 US2–US5) ----

// RemoteAuth là bằng chứng của term_start/term_control; worker tự kiểm bằng remoteauth.VerifyAuth, hub chỉ chuyển.
// Code (TOTP) không bao giờ được ghi log.
type RemoteAuth struct {
	Kind      string             `json:"kind"`
	Assertion *WebauthnAssertion `json:"assertion,omitempty"`
	Code      string             `json:"code,omitempty"`
	EphPub    string             `json:"ephPub"`
	TS        int64              `json:"ts"`
	Nonce     string             `json:"nonce"`
}

// WebauthnAssertion giữ nguyên chuỗi base64url trình duyệt gửi để kiểm chữ ký trên đúng byte đó.
type WebauthnAssertion struct {
	CredentialID      string `json:"credentialId"`
	AuthenticatorData string `json:"authenticatorData"`
	ClientDataJSON    string `json:"clientDataJSON"`
	Signature         string `json:"signature"`
	UserHandle        string `json:"userHandle,omitempty"`
}

type TermStart struct {
	Type        string     `json:"type"`
	V           int        `json:"v"`
	ID          string     `json:"id"`
	RequestID   string     `json:"requestId"`
	UserID      string     `json:"userId"`
	DeviceID    string     `json:"deviceId"`
	CLI         string     `json:"cli"`
	AccountID   string     `json:"accountId,omitempty"`
	RootID      string     `json:"rootId"`
	Subdir      string     `json:"subdir,omitempty"`
	Model       string     `json:"model,omitempty"`
	Permissions string     `json:"permissions,omitempty"`
	ProjectID   string     `json:"projectId,omitempty"`
	TaskID      string     `json:"taskId,omitempty"`
	Prompt      string     `json:"prompt,omitempty"`
	Cols        int        `json:"cols"`
	Rows        int        `json:"rows"`
	Auth        RemoteAuth `json:"auth"`
}

type TermControl struct {
	Type        string      `json:"type"`
	V           int         `json:"v"`
	ID          string      `json:"id"`
	SessionID   string      `json:"sessionId"`
	ConnID      string      `json:"connId"`
	UserID      string      `json:"userId"`
	DeviceID    string      `json:"deviceId"`
	Auth        *RemoteAuth `json:"auth,omitempty"`
	ResumeToken string      `json:"resumeToken,omitempty"`
}

type TermDetach struct {
	Type      string `json:"type"`
	V         int    `json:"v"`
	ID        string `json:"id"`
	SessionID string `json:"sessionId"`
	ConnID    string `json:"connId"`
}

type TermAck struct {
	Type      string `json:"type"`
	V         int    `json:"v"`
	ID        string `json:"id"`
	SessionID string `json:"sessionId"`
	Upto      int64  `json:"upto"`
}

// TermDisable chỉ tắt; không có gói bật vì bật chỉ làm được tại máy (FR-012).
type TermDisable struct {
	Type string `json:"type"`
	V    int    `json:"v"`
	ID   string `json:"id"`
	By   string `json:"by"`
}

type TermPair struct {
	Type         string `json:"type"`
	V            int    `json:"v"`
	ID           string `json:"id"`
	PairID       string `json:"pairId"`
	UserID       string `json:"userId"`
	Label        string `json:"label"`
	CredentialID string `json:"credentialId"`
	SPKI         string `json:"spki"`
	Tag          string `json:"tag"`
}

type TermDeviceRevoke struct {
	Type     string `json:"type"`
	V        int    `json:"v"`
	ID       string `json:"id"`
	DeviceID string `json:"deviceId"`
	By       string `json:"by"`
}

type TermStateTOTP struct {
	Enabled     bool   `json:"enabled"`
	Locked      bool   `json:"locked"`
	LockedUntil string `json:"lockedUntil,omitempty"`
}

type TermStateRoot struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type TermStateAccount struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	CLI   string `json:"cli"`
	State string `json:"state"`
}

type TermStateDevice struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	UserID string `json:"userId"`
	Synced bool   `json:"synced"`
}

type TermStateSession struct {
	ID         string  `json:"id"`
	Origin     string  `json:"origin"`
	Controller *string `json:"controller"`
}

// TermState không có đường dẫn tuyệt đối của root hay khoá TOTP: hub chỉ cần nhãn để hiện trên điện thoại.
type TermState struct {
	Type             string             `json:"type"`
	V                int                `json:"v"`
	ID               string             `json:"id"`
	Enabled          bool               `json:"enabled"`
	TOTP             TermStateTOTP      `json:"totp"`
	Roots            []TermStateRoot    `json:"roots"`
	CLIs             []string           `json:"clis"`
	Accounts         []TermStateAccount `json:"accounts"`
	Devices          []TermStateDevice  `json:"devices"`
	Sessions         []TermStateSession `json:"sessions"`
	ConfirmOnMachine bool               `json:"confirmOnMachine"`
}

type TermDenied struct {
	Type      string `json:"type"`
	V         int    `json:"v"`
	ID        string `json:"id"`
	RequestID string `json:"requestId"`
	Code      string `json:"code"`
	Reason    string `json:"reason"`
}

type TermEvent struct {
	Type      string          `json:"type"`
	V         int             `json:"v"`
	ID        string          `json:"id"`
	SessionID string          `json:"sessionId"`
	Seq       int64           `json:"seq"`
	Event     string          `json:"event"`
	Data      json.RawMessage `json:"data,omitempty"`
}

type TermGranted struct {
	Type         string `json:"type"`
	V            int    `json:"v"`
	ID           string `json:"id"`
	SessionID    string `json:"sessionId"`
	ConnID       string `json:"connId"`
	WorkerEphPub string `json:"workerEphPub"`
	ResumeToken  string `json:"resumeToken"`
}

type TermRevoked struct {
	Type      string `json:"type"`
	V         int    `json:"v"`
	ID        string `json:"id"`
	SessionID string `json:"sessionId"`
	ConnID    string `json:"connId"`
	Reason    string `json:"reason"`
}

type TermPairResult struct {
	Type     string `json:"type"`
	V        int    `json:"v"`
	ID       string `json:"id"`
	PairID   string `json:"pairId"`
	OK       bool   `json:"ok"`
	DeviceID string `json:"deviceId,omitempty"`
	Reason   string `json:"reason,omitempty"`
}

// newMessage trả con trỏ tới struct đúng loại gói, nil nếu loại lạ. Dùng khi giải mã gói theo `type`.
func newMessage(msgType string) any {
	switch msgType {
	case "hello":
		return &Hello{}
	case "heartbeat":
		return &Heartbeat{}
	case "job_accept":
		return &JobAccept{}
	case "job_reject":
		return &JobReject{}
	case "run_event":
		return &RunEvent{}
	case "log_chunk":
		return &LogChunk{}
	case "run_result":
		return &RunResult{}
	case "welcome":
		return &Welcome{}
	case "upgrade_required":
		return &UpgradeRequired{}
	case "heartbeat_ack":
		return &HeartbeatAck{}
	case "job_offer":
		return &JobOffer{}
	case "lease":
		return &Lease{}
	case "ack":
		return &Ack{}
	case "steer":
		return &Steer{}
	case "approval_result":
		return &ApprovalResult{}
	case "cancel":
		return &Cancel{}
	case "drain":
		return &Drain{}
	case "update":
		return &Update{}
	case "account_set":
		return &AccountSet{}
	case "account_login_start":
		return &AccountLoginStart{}
	case "account_login_input":
		return &AccountLoginInput{}
	case "account_login_cancel":
		return &AccountLoginCancel{}
	case "account_login_event":
		return &AccountLoginEvent{}
	case "term_opened":
		return &TermOpened{}
	case "term_output":
		return &TermOutput{}
	case "term_exit":
		return &TermExit{}
	case "term_open":
		return &TermOpen{}
	case "term_input":
		return &TermInput{}
	case "term_resize":
		return &TermResize{}
	case "term_close":
		return &TermClose{}
	case "term_start":
		return &TermStart{}
	case "term_control":
		return &TermControl{}
	case "term_detach":
		return &TermDetach{}
	case "term_ack":
		return &TermAck{}
	case "term_disable":
		return &TermDisable{}
	case "term_pair":
		return &TermPair{}
	case "term_device_revoke":
		return &TermDeviceRevoke{}
	case "term_state":
		return &TermState{}
	case "term_denied":
		return &TermDenied{}
	case "term_event":
		return &TermEvent{}
	case "term_granted":
		return &TermGranted{}
	case "term_revoked":
		return &TermRevoked{}
	case "term_pair_result":
		return &TermPairResult{}
	}
	return nil
}

// Decode giải mã một gói theo trường `type`. Trả lỗi với gói lạ để kênh không lặng lẽ bỏ qua lệnh từ hub mới hơn.
func Decode(payload []byte) (any, error) {
	var env Envelope
	if err := json.Unmarshal(payload, &env); err != nil {
		return nil, err
	}
	msg := newMessage(env.Type)
	if msg == nil {
		return nil, &UnknownMessageError{Type: env.Type}
	}
	if err := json.Unmarshal(payload, msg); err != nil {
		return nil, err
	}
	return msg, nil
}

type UnknownMessageError struct{ Type string }

func (e *UnknownMessageError) Error() string { return "gói không hỗ trợ: " + e.Type }
