package channel

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/runner"
)

// File mẫu dùng chung với test TypeScript (packages/contracts/src/worker-protocol.test.ts). Test TypeScript kiểm mẫu
// khớp zod; test này kiểm struct Go giải mã rồi mã hoá lại ra đúng JSON đó, nên tên trường và kiểu hai bên không lệch.
const fixturesPath = "../../../packages/contracts/fixtures/worker-protocol.json"

func loadFixtures(t *testing.T) []json.RawMessage {
	t.Helper()
	data, err := os.ReadFile(fixturesPath)
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		WorkerToHub []json.RawMessage `json:"workerToHub"`
		HubToWorker []json.RawMessage `json:"hubToWorker"`
	}
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	return append(f.WorkerToHub, f.HubToWorker...)
}

func TestProtocolRoundTrip(t *testing.T) {
	seen := map[string]bool{}
	for _, raw := range loadFixtures(t) {
		msg, err := Decode(raw)
		if err != nil {
			t.Fatalf("giải mã %s: %v", raw, err)
		}
		encoded, err := json.Marshal(msg)
		if err != nil {
			t.Fatal(err)
		}
		var want, got map[string]any
		_ = json.Unmarshal(raw, &want)
		_ = json.Unmarshal(encoded, &got)
		if !reflect.DeepEqual(want, got) {
			t.Errorf("%s: mã hoá lại khác mẫu\nmẫu: %v\nGo:  %v", want["type"], want, got)
		}
		seen[want["type"].(string)] = true
	}
	// Mọi loại Go biết phải có mẫu, để thêm gói mới mà quên cập nhật một bên thì test hỏng.
	for _, typ := range []string{"hello", "heartbeat", "job_accept", "job_reject", "run_event", "log_chunk", "run_result", "welcome", "upgrade_required", "heartbeat_ack", "job_offer", "lease", "ack", "steer", "approval_result", "cancel", "drain", "update", "account_set", "account_login_start", "account_login_input", "account_login_cancel", "account_login_event", "term_opened", "term_output", "term_exit", "term_open", "term_input", "term_resize", "term_close", "term_start", "term_control", "term_detach", "term_ack", "term_disable", "term_pair", "term_device_revoke", "term_state", "term_denied", "term_event", "term_granted", "term_revoked", "term_pair_result"} {
		if newMessage(typ) == nil {
			t.Errorf("newMessage thiếu %s", typ)
		}
		if !seen[typ] {
			t.Errorf("file mẫu thiếu %s", typ)
		}
	}
	if len(seen) != 43 {
		t.Errorf("file mẫu có %d loại, Go biết 43", len(seen))
	}
}

// Payload của run_event "subagent" trong file mẫu (khớp subagentEventData của zod) giải mã vào struct runner rồi mã hoá
// lại phải y nguyên, để tên trường Go không lệch hợp đồng.
func TestSubagentEventMatchesFixture(t *testing.T) {
	found := false
	for _, raw := range loadFixtures(t) {
		var ev RunEvent
		if json.Unmarshal(raw, &ev) != nil || ev.Type != "run_event" || ev.Event != "subagent" {
			continue
		}
		found = true
		var data runner.SubagentEvent
		if err := json.Unmarshal(ev.Data, &data); err != nil {
			t.Fatal(err)
		}
		encoded, _ := json.Marshal(data)
		var want, got map[string]any
		_ = json.Unmarshal(ev.Data, &want)
		_ = json.Unmarshal(encoded, &got)
		if !reflect.DeepEqual(want, got) {
			t.Errorf("subagent: mã hoá lại khác mẫu\nmẫu: %v\nGo:  %v", want, got)
		}
	}
	if !found {
		t.Fatal("file mẫu thiếu run_event subagent")
	}
}

func TestLogChunkBase64(t *testing.T) {
	msg, err := Decode([]byte(`{"type":"log_chunk","v":1,"id":"l","runId":"r","attempt":1,"seq":0,"offset":0,"bytes":"aGVsbG8K"}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := string(msg.(*LogChunk).Bytes); got != "hello\n" {
		t.Fatalf("bytes = %q", got)
	}
}

func TestRunResultNullHeadSHA(t *testing.T) {
	b, _ := json.Marshal(RunResult{Type: "run_result", V: 1, ID: "x", RunID: "r", Attempt: 1, Report: json.RawMessage("null")})
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if v, ok := m["headSha"]; !ok || v != nil {
		t.Fatalf("headSha = %v, %v; cần null", v, ok)
	}
}

func TestDecodeUnknown(t *testing.T) {
	_, err := Decode([]byte(`{"type":"la","v":1,"id":"x"}`))
	if _, ok := err.(*UnknownMessageError); !ok {
		t.Fatalf("err = %v", err)
	}
}
