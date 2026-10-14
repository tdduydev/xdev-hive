package terminal

import "errors"

// Giao diện giữa kênh hub và phiên terminal trên máy cá nhân (specs/010 T010, D14). Kênh đổi gói term_* sang các kiểu
// dưới đây rồi gọi Handler; Handler trả lời qua Sender. Kiểu ở đây tự đứng, không import gói channel, vì channel đã
// import terminal (Host của terminal Leader), nên import ngược sẽ thành vòng.

// ErrHubNoTerminal: hub không khai "terminal" trong welcome.features, hoặc phiên kênh đã đóng. Worker không gửi gói
// term_* mới cho hub cũ vì hub cũ đóng kết nối 4400 khi gặp gói lạ.
var ErrHubNoTerminal = errors.New("hub không hỗ trợ điều khiển terminal từ xa")

// WelcomeOwner là chủ máy theo hub. Shared là máy dùng chung: không có chủ riêng để ghép thiết bị.
type WelcomeOwner struct {
	UserID string
	Shared bool
}

// WelcomePolicy chỉ dùng để tắt: TOTPFallback false thì worker từ chối TOTP dù chủ máy đã bật.
type WelcomePolicy struct {
	TOTPFallback bool
}

// WelcomeInfo là phần của welcome mà Handler cần. Owner, Policy nil là hub không gửi (hub cũ hoặc không có điều khiển
// từ xa).
type WelcomeInfo struct {
	Features []string
	// Terminal: hub khai "terminal"; chỉ khi đó Sender mới gửi được.
	Terminal bool
	Owner    *WelcomeOwner
	Policy   *WelcomePolicy
}

// Handler hiện thực phía worker của điều khiển từ xa. Mọi hàm được gọi từ vòng đọc của kênh nên phải trả về nhanh,
// việc nặng (spawn PTY, kiểm chữ ký) để goroutine riêng làm; chặn ở đây là chặn cả heartbeat_ack và lệnh huỷ run.
// Chỉ có hàm gọi khi hub đã khai "terminal"; gói H→W không khai bị kênh bỏ qua.
type Handler interface {
	// OnWelcome gọi mỗi lần nối lại thành công, trước mọi gói khác của phiên. send chỉ dùng được trong phiên này: sang
	// phiên sau Handler nhận Sender mới, Sender cũ trả ErrHubNoTerminal.
	OnWelcome(info WelcomeInfo, send Sender)
	// OnDisconnect gọi khi mất kết nối hub: người xem từ xa không còn, phiên trên máy vẫn chạy.
	OnDisconnect()

	Start(StartRequest)
	Control(ControlRequest)
	Detach(DetachRequest)
	Ack(AckRequest)
	// Input, Resize chỉ tới đây khi có ConnID (phiên điều khiển từ xa); phím của phiên Leader đi vào Host.
	Input(InputRequest)
	Resize(ResizeRequest)
	Disable(DisableRequest)
	Pair(PairRequest)
	DeviceRevoke(DeviceRevokeRequest)
}

// Sender là đường gửi gói term_* về hub cho Handler. Hub không khai "terminal" thì mọi hàm trả ErrHubNoTerminal và
// không ghi gì (SC-010). Mất kết nối trả lỗi ghi; gói state/event do Handler gửi lại sau khi nối lại.
type Sender interface {
	// Enabled cho biết hub đã khai "terminal", để Handler khỏi dựng gói vô ích.
	Enabled() bool
	State(State) error
	Denied(Denied) error
	Opened(Opened) error
	Output(sessionID string, seq int64, data []byte) error
	Exit(Exit) error
	Event(SessionEvent) error
	Granted(Granted) error
	Revoked(Revoked) error
	PairResult(PairResult) error
}

// ---- Hub → worker ----

// Auth là bằng chứng của Start/Control; Handler tự kiểm bằng remoteauth, hub chỉ chuyển. Code (TOTP) không ghi log.
type Auth struct {
	Kind      string
	Assertion *Assertion
	Code      string
	EphPub    string
	TS        int64
	Nonce     string
}

// Assertion giữ nguyên chuỗi base64url trình duyệt gửi, để kiểm chữ ký trên đúng byte đó.
type Assertion struct {
	CredentialID      string
	AuthenticatorData string
	ClientDataJSON    string
	Signature         string
	UserHandle        string
}

type StartRequest struct {
	RequestID, UserID, DeviceID string
	CLI, AccountID              string
	RootID, Subdir              string
	Model, Permissions          string
	ProjectID, TaskID, Prompt   string
	Cols, Rows                  int
	Auth                        Auth
}

type ControlRequest struct {
	SessionID, ConnID, UserID, DeviceID string
	Auth                                *Auth
	ResumeToken                         string
}

type DetachRequest struct{ SessionID, ConnID string }

// AckRequest: hub đã ghi output tới Upto; Host xoá đệm đĩa tới đó.
type AckRequest struct {
	SessionID string
	Upto      int64
}

// InputRequest và ResizeRequest mang Seq, MAC của kết nối: Handler kiểm bằng khoá phiên (remoteauth.InputVerifier).
type InputRequest struct {
	SessionID, ConnID string
	Data              []byte
	Seq               *int64
	MAC               string
}

type ResizeRequest struct {
	SessionID, ConnID string
	Cols, Rows        int
	Seq               *int64
	MAC               string
}

// DisableRequest chỉ tắt; bật chỉ làm được tại máy (FR-012).
type DisableRequest struct{ By string }

type PairRequest struct {
	PairID, UserID, Label string
	CredentialID, SPKI    string
	Tag                   string
}

type DeviceRevokeRequest struct{ DeviceID, By string }

// ---- Worker → hub ----

type StateTOTP struct {
	Enabled     bool
	Locked      bool
	LockedUntil string
}

type StateRoot struct{ ID, Label string }

type StateAccount struct{ ID, Label, CLI, State string }

type StateDevice struct {
	ID, Label, UserID string
	Synced            bool
}

type StateSession struct {
	ID, Origin string
	// Controller nil là chưa ai điều khiển; vẫn gửi null.
	Controller *string
}

// State không có đường dẫn tuyệt đối của root hay khoá TOTP: hub chỉ cần nhãn để hiện trên điện thoại.
type State struct {
	Enabled          bool
	TOTP             StateTOTP
	Roots            []StateRoot
	CLIs             []string
	Accounts         []StateAccount
	Devices          []StateDevice
	Sessions         []StateSession
	ConfirmOnMachine bool
}

// Denied trả lời Start/Control bị từ chối; Code là mã lỗi của hợp đồng, Reason là chữ hiện cho người dùng.
type Denied struct{ RequestID, Code, Reason string }

// Opened báo phiên trên máy cá nhân (Origin "local" hoặc "remote"); khác Event KindOpened của phiên Leader.
type Opened struct {
	SessionID, Origin string
	RequestID         string
	AccountLabel      *string
	Permissions       string
	CLI, CwdLabel     string
	ProjectID, TaskID string
	Cols, Rows        int
	Record, Remote    *bool
}

type Exit struct {
	SessionID string
	ExitCode  *int
	Reason    string
	Message   string
	By        string
}

// SessionEvent là sự kiện của phiên (đổi người điều khiển, cần xác nhận...); Data là JSON theo từng Event.
type SessionEvent struct {
	SessionID string
	Seq       int64
	Event     string
	Data      []byte
}

type Granted struct {
	SessionID, ConnID string
	WorkerEphPub      string
	ResumeToken       string
}

type Revoked struct{ SessionID, ConnID, Reason string }

type PairResult struct {
	PairID   string
	OK       bool
	DeviceID string
	Reason   string
}
