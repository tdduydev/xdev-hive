package channel

import "encoding/json"

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
	CLIs       []string `json:"clis"`
	Capacity   int      `json:"capacity"`
	ResumeRuns []string `json:"resumeRuns"`
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
	HeadSHA *string         `json:"headSha"`
	Report  json.RawMessage `json:"report"`
}

// ---- Hub → worker ----

type Welcome struct {
	Type           string `json:"type"`
	V              int    `json:"v"`
	ID             string `json:"id"`
	SessionID      string `json:"sessionId"`
	HeartbeatSec   int    `json:"heartbeatSec"`
	AccessTokenExp string `json:"accessTokenExp,omitempty"`
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

type Steer struct {
	Type  string `json:"type"`
	V     int    `json:"v"`
	ID    string `json:"id"`
	RunID string `json:"runId"`
	Input string `json:"input"`
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
