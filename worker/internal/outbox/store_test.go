package outbox

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/hubclient"
)

var t0 = time.Date(2026, 10, 22, 3, 0, 0, 0, time.UTC)

type clock struct{ now time.Time }

func (c *clock) Now() time.Time      { return c.now }
func (c *clock) add(d time.Duration) { c.now = c.now.Add(d) }
func newStore(t *testing.T) (Store, *clock) {
	t.Helper()
	c := &clock{now: t0}
	return Store{Root: filepath.Join(t.TempDir(), "outbox"), Now: c.Now}, c
}

var testID = Identity{HubURL: "https://hub.example.test", MachineID: "may-1"}

// fakeSender giả hub: nhớ khoá đã nhận để trả `duplicate` như withClientEvent của hub, hoặc trả lỗi/outcome đặt sẵn.
type fakeSender struct {
	mu       sync.Mutex
	seen     map[string]int
	events   []hubclient.ClientEvent
	outcome  string
	err      error
	code     string
	accepted int
}

func newFakeSender() *fakeSender {
	return &fakeSender{seen: map[string]int{}, outcome: hubclient.OutcomeAccepted}
}

func (f *fakeSender) send(_ context.Context, ev hubclient.ClientEvent) (hubclient.ClientEventResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events = append(f.events, ev)
	if f.err != nil {
		return hubclient.ClientEventResult{}, f.err
	}
	res := hubclient.ClientEventResult{Key: ev.Key, Outcome: f.outcome, ReceivedAt: "2026-10-22T03:00:01Z"}
	if f.outcome == hubclient.OutcomeRejected {
		res.Code, res.Reason = f.code, "Hub không nhận."
		return res, nil
	}
	if f.seen[ev.Key] > 0 {
		res.Outcome = hubclient.OutcomeDuplicate
	} else {
		f.accepted++
	}
	f.seen[ev.Key]++
	return res, nil
}

func submit(t *testing.T, s Store, kind, payload string) Item {
	t.Helper()
	it, err := s.Submit(testID, Submission{Kind: kind, Source: "worker", Payload: json.RawMessage(payload)})
	if err != nil {
		t.Fatal(err)
	}
	return it
}

func list(t *testing.T, s Store) []Item {
	t.Helper()
	items, err := s.List(testID)
	if err != nil {
		t.Fatal(err)
	}
	return items
}

func TestSubmitWritesItemFile(t *testing.T) {
	s, _ := newStore(t)
	it := submit(t, s, KindTokenScore, `{"days":7}`)
	if !keyPattern.MatchString(it.Key) || it.State != StatePending || it.Transport != TransportWorker ||
		it.Stream != KindTokenScore || it.Group != "progress" || !it.CreatedAt.Equal(t0) {
		t.Fatalf("mục: %+v", it)
	}
	path := filepath.Join(s.Root, "machine-may-1", it.Key+".json")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Errorf("quyền file %v, cần 0600", info.Mode().Perm())
	}
	var onDisk Item
	b, _ := os.ReadFile(path)
	if err := json.Unmarshal(b, &onDisk); err != nil || onDisk.Key != it.Key || string(onDisk.Body) != `{"days":7}` {
		t.Errorf("file: %s %v", b, err)
	}
	if got := list(t, s); len(got) != 1 || got[0].Key != it.Key {
		t.Errorf("list: %+v", got)
	}
}

func TestSubmitValidates(t *testing.T) {
	s, _ := newStore(t)
	for name, sub := range map[string]Submission{
		"kind lạ":       {Kind: "memory.write", Payload: json.RawMessage(`{}`)},
		"payload hỏng":  {Kind: KindTokenScore, Payload: json.RawMessage(`{`)},
		"payload mảng":  {Kind: KindTokenScore, Payload: json.RawMessage(`[1]`)},
		"khoá sai dạng": {Kind: KindTokenScore, Payload: json.RawMessage(`{}`), Key: "a/b"},
	} {
		if _, err := s.Submit(testID, sub); err == nil {
			t.Errorf("%s: phải lỗi", name)
		}
	}
	if _, err := s.Submit(Identity{HubURL: "https://hub.example.test"}, Submission{Kind: KindTokenScore, Payload: json.RawMessage(`{}`)}); err == nil {
		t.Error("thiếu machineId phải lỗi")
	}
}

func TestSubmitLimits(t *testing.T) {
	s, _ := newStore(t)
	s.MaxItemBytes, s.MaxTotalBytes = 600, 1500
	big := `{"x":"` + strings.Repeat("a", 700) + `"}`
	var e *Error
	if _, err := s.Submit(testID, Submission{Kind: KindTokenScore, Payload: json.RawMessage(big)}); !errors.As(err, &e) || e.Code != "ITEM_TOO_LARGE" {
		t.Fatalf("mục quá lớn: %v", err)
	}
	mid := `{"x":"` + strings.Repeat("a", 200) + `"}`
	var err error
	for range 10 {
		if _, err = s.Submit(testID, Submission{Kind: KindMemoryPropose, Payload: json.RawMessage(mid)}); err != nil {
			break
		}
	}
	if !errors.As(err, &e) || e.Code != "OUTBOX_FULL" {
		t.Fatalf("hộp thư đầy: %v", err)
	}
}

func TestFlushAcceptedMovesToSentLog(t *testing.T) {
	s, c := newStore(t)
	it := submit(t, s, KindTokenScore, `{"days":7}`)
	hub := newFakeSender()
	c.add(time.Second)
	res, err := s.Flush(context.Background(), testID, hub.send)
	if err != nil {
		t.Fatal(err)
	}
	if res.Accepted != 1 || len(hub.events) != 1 {
		t.Fatalf("kết quả: %+v, hub nhận %d", res, len(hub.events))
	}
	ev := hub.events[0]
	if ev.Key != it.Key || ev.Kind != KindTokenScore || ev.CreatedAt != "2026-10-22T03:00:00Z" || string(ev.Payload) != `{"days":7}` {
		t.Errorf("sự kiện: %+v", ev)
	}
	if got := list(t, s); len(got) != 0 {
		t.Errorf("hub nhận thì xoá mục: %+v", got)
	}
	sent, err := s.Sent(testID)
	if err != nil || len(sent) != 1 || sent[0].Key != it.Key || sent[0].Outcome != "accepted" || sent[0].ReceivedAt == "" {
		t.Fatalf("sent.jsonl: %+v %v", sent, err)
	}
}

// Tiến trình chết sau khi hub đã nhận nhưng trước khi ghi kết quả: mục còn `sending`. Lần chạy sau gửi lại cùng khoá,
// hub trả `duplicate`, nên việc chỉ được thực hiện một lần (SC-006).
func TestFlushAfterCrashInSendingIsExactlyOnce(t *testing.T) {
	s, _ := newStore(t)
	it := submit(t, s, KindTokenScore, `{"days":7}`)
	hub := newFakeSender()
	crash := func(ctx context.Context, ev hubclient.ClientEvent) (hubclient.ClientEventResult, error) {
		_, _ = hub.send(ctx, ev)
		panic("tiến trình bị giết")
	}
	func() {
		defer func() { _ = recover() }()
		_, _ = s.Flush(context.Background(), testID, crash)
	}()
	if got := list(t, s); len(got) != 1 || got[0].State != StateSending || got[0].Attempts != 1 {
		t.Fatalf("sau khi chết giữa chừng: %+v", got)
	}

	restarted := Store{Root: s.Root, Now: s.Now}
	res, err := restarted.Flush(context.Background(), testID, hub.send)
	if err != nil {
		t.Fatal(err)
	}
	if hub.accepted != 1 || len(hub.events) != 2 || hub.events[1].Key != it.Key || res.Duplicate != 1 {
		t.Fatalf("hub thực hiện %d lần, nhận %d yêu cầu, kết quả %+v", hub.accepted, len(hub.events), res)
	}
	if string(hub.events[0].Payload) != string(hub.events[1].Payload) || hub.events[0].CreatedAt != hub.events[1].CreatedAt {
		t.Error("gửi lại phải đúng byte cũ")
	}
	if got := list(t, s); len(got) != 0 {
		t.Errorf("còn mục: %+v", got)
	}
	if sent, _ := s.Sent(testID); len(sent) != 1 || sent[0].Outcome != "duplicate" {
		t.Errorf("sent.jsonl: %+v", sent)
	}
	if _, err := restarted.Flush(context.Background(), testID, hub.send); err != nil || len(hub.events) != 2 {
		t.Errorf("không còn gì để gửi: %d %v", len(hub.events), err)
	}
}

// Chết sau khi đã ghi `accepted` nhưng chưa xoá file: lần sau chỉ dọn, không gửi lại.
func TestFlushFinishesAcceptedLeftover(t *testing.T) {
	s, _ := newStore(t)
	it := submit(t, s, KindTokenScore, `{}`)
	it.State, it.Result = StateAccepted, &Result{Outcome: "accepted", ReceivedAt: "2026-10-22T03:00:01Z"}
	if err := writeAtomic(s.itemPath(testID, it.Key), mustJSON(t, it)); err != nil {
		t.Fatal(err)
	}
	// File tạm của lần ghi dở bị bỏ qua và dọn đi.
	tmp := filepath.Join(s.Root, "machine-may-1", "."+it.Key+".json-123")
	if err := os.WriteFile(tmp, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	hub := newFakeSender()
	if _, err := s.Flush(context.Background(), testID, hub.send); err != nil {
		t.Fatal(err)
	}
	if len(hub.events) != 0 || len(list(t, s)) != 0 {
		t.Fatalf("hub nhận %d, còn %d mục", len(hub.events), len(list(t, s)))
	}
	if sent, _ := s.Sent(testID); len(sent) != 1 {
		t.Errorf("sent.jsonl: %+v", sent)
	}
	if _, err := os.Stat(tmp); !os.IsNotExist(err) {
		t.Errorf("file tạm còn: %v", err)
	}
}

func TestFlushRejectedIsKeptAndNotResent(t *testing.T) {
	s, _ := newStore(t)
	rejected := submit(t, s, KindTokenScore, `{"a":1}`)
	hub := newFakeSender()
	hub.outcome, hub.code = hubclient.OutcomeRejected, "TOKEN_SCORE_TOO_FREQUENT"
	res, err := s.Flush(context.Background(), testID, hub.send)
	if err != nil || res.Rejected != 1 {
		t.Fatalf("%+v %v", res, err)
	}
	got := list(t, s)
	if len(got) != 1 || got[0].State != StateRejected || got[0].Result == nil || got[0].Result.Code != "TOKEN_SCORE_TOO_FREQUENT" {
		t.Fatalf("mục bị từ chối: %+v", got)
	}
	// Mục bị từ chối không chặn mục sau cùng stream và không bị gửi lại.
	hub.outcome = hubclient.OutcomeAccepted
	next := submit(t, s, KindTokenScore, `{"a":2}`)
	if _, err := s.Flush(context.Background(), testID, hub.send); err != nil {
		t.Fatal(err)
	}
	if len(hub.events) != 2 || hub.events[1].Key != next.Key {
		t.Fatalf("sự kiện: %+v", hub.events)
	}
	if got := list(t, s); len(got) != 1 || got[0].Key != rejected.Key {
		t.Errorf("còn: %+v", got)
	}
	if err := s.Drop(testID, rejected.Key); err != nil || len(list(t, s)) != 0 {
		t.Errorf("bỏ mục: %v", err)
	}
}

func TestFlushHTTPStatusClassification(t *testing.T) {
	for _, tc := range []struct {
		status int
		state  State
	}{
		{http.StatusBadRequest, StateRejected},
		{http.StatusUnprocessableEntity, StateRejected},
		{http.StatusUnauthorized, StatePending},
		{http.StatusForbidden, StatePending},
		{http.StatusNotFound, StatePending},
		{http.StatusTooManyRequests, StatePending},
		{http.StatusServiceUnavailable, StatePending},
	} {
		s, _ := newStore(t)
		submit(t, s, KindTokenScore, `{}`)
		hub := newFakeSender()
		hub.err = &hubclient.StatusError{Status: tc.status, Message: "x"}
		if _, err := s.Flush(context.Background(), testID, hub.send); err != nil {
			t.Fatal(err)
		}
		got := list(t, s)
		if len(got) != 1 || got[0].State != tc.state {
			t.Errorf("mã %d: %+v", tc.status, got)
			continue
		}
		if tc.state == StateRejected && (got[0].Result == nil || got[0].Result.Code != "HTTP_"+itoa(tc.status)) {
			t.Errorf("mã %d: kết quả %+v", tc.status, got[0].Result)
		}
	}
}

func TestFlushBackoff(t *testing.T) {
	s, c := newStore(t)
	submit(t, s, KindTokenScore, `{}`)
	hub := newFakeSender()
	hub.err = errors.New("mất mạng")
	want := []time.Duration{5 * time.Second, 10 * time.Second, 20 * time.Second, 40 * time.Second, 80 * time.Second,
		160 * time.Second, 5 * time.Minute, 5 * time.Minute}
	for i, wait := range want {
		res, err := s.Flush(context.Background(), testID, hub.send)
		if err != nil || res.Retry != 1 {
			t.Fatalf("lần %d: %+v %v", i+1, res, err)
		}
		it := list(t, s)[0]
		if it.State != StatePending || it.Attempts != i+1 || it.NextAttemptAt == nil || !it.NextAttemptAt.Equal(c.now.Add(wait)) ||
			it.LastError == "" {
			t.Fatalf("lần %d: %+v", i+1, it)
		}
		// Chưa tới giờ thì không gửi.
		c.add(wait - time.Millisecond)
		if res, _ := s.Flush(context.Background(), testID, hub.send); len(hub.events) != i+1 || res.Waiting != 1 {
			t.Fatalf("lần %d: gửi trước giờ (%d yêu cầu, %+v)", i+1, len(hub.events), res)
		}
		c.add(time.Millisecond)
	}
	hub.err = nil
	if res, err := s.Flush(context.Background(), testID, hub.send); err != nil || res.Accepted != 1 || len(list(t, s)) != 0 {
		t.Fatalf("có mạng lại: %+v %v", res, err)
	}
}

func TestFlushExpiresAfter14Days(t *testing.T) {
	s, c := newStore(t)
	submit(t, s, KindTokenScore, `{}`)
	hub := newFakeSender()
	hub.err = errors.New("mất mạng")
	if _, err := s.Flush(context.Background(), testID, hub.send); err != nil {
		t.Fatal(err)
	}
	c.add(14*24*time.Hour - time.Second)
	if _, err := s.Flush(context.Background(), testID, hub.send); err != nil || len(hub.events) != 2 {
		t.Fatalf("chưa đủ 14 ngày vẫn gửi: %d %v", len(hub.events), err)
	}
	c.add(time.Second)
	hub.err = nil
	res, err := s.Flush(context.Background(), testID, hub.send)
	if err != nil || res.Expired != 1 || len(hub.events) != 2 {
		t.Fatalf("hết hạn: %+v %v, hub nhận %d", res, err, len(hub.events))
	}
	if got := list(t, s); len(got) != 1 || got[0].State != StateExpired {
		t.Fatalf("mục hết hạn được giữ: %+v", got)
	}
	// Hết hạn không chặn stream.
	submit(t, s, KindTokenScore, `{"b":1}`)
	if res, _ := s.Flush(context.Background(), testID, hub.send); res.Accepted != 1 {
		t.Errorf("mục mới sau mục hết hạn: %+v", res)
	}
}

func TestFlushOrdersWithinStream(t *testing.T) {
	s, c := newStore(t)
	first := submit(t, s, KindMemoryPropose, `{"n":1}`)
	c.add(time.Millisecond)
	second := submit(t, s, KindMemoryPropose, `{"n":2}`)
	c.add(time.Millisecond)
	other, err := s.Submit(testID, Submission{Kind: KindProjectTokenUsage, Payload: json.RawMessage(`{}`), Stream: "project:p1"})
	if err != nil {
		t.Fatal(err)
	}
	failFirst := func(ctx context.Context, ev hubclient.ClientEvent) (hubclient.ClientEventResult, error) {
		if ev.Key == first.Key {
			return hubclient.ClientEventResult{}, &hubclient.StatusError{Status: http.StatusServiceUnavailable}
		}
		return hubclient.ClientEventResult{Key: ev.Key, Outcome: "accepted", ReceivedAt: "2026-10-22T03:00:01Z"}, nil
	}
	var keys []string
	record := func(ctx context.Context, ev hubclient.ClientEvent) (hubclient.ClientEventResult, error) {
		keys = append(keys, ev.Key)
		return failFirst(ctx, ev)
	}
	if _, err := s.Flush(context.Background(), testID, record); err != nil {
		t.Fatal(err)
	}
	if len(keys) != 2 || keys[0] != first.Key || keys[1] != other.Key {
		t.Fatalf("mục lỗi phải chặn mục sau cùng stream, không chặn stream khác: %v", keys)
	}
	c.add(5 * time.Second)
	keys = nil
	ok := func(_ context.Context, ev hubclient.ClientEvent) (hubclient.ClientEventResult, error) {
		keys = append(keys, ev.Key)
		return hubclient.ClientEventResult{Key: ev.Key, Outcome: "accepted", ReceivedAt: "2026-10-22T03:00:01Z"}, nil
	}
	if _, err := s.Flush(context.Background(), testID, ok); err != nil {
		t.Fatal(err)
	}
	if len(keys) != 2 || keys[0] != first.Key || keys[1] != second.Key {
		t.Fatalf("thứ tự trong stream: %v", keys)
	}
}

func TestFlushStopsOnNetworkError(t *testing.T) {
	s, _ := newStore(t)
	submit(t, s, KindMemoryPropose, `{}`)
	if _, err := s.Submit(testID, Submission{Kind: KindProjectTokenUsage, Payload: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	hub := newFakeSender()
	hub.err = errors.New("dial tcp: không có mạng")
	res, err := s.Flush(context.Background(), testID, hub.send)
	if err != nil || len(hub.events) != 1 || res.Retry != 1 {
		t.Fatalf("mất mạng thì dừng lượt gửi: %d yêu cầu, %+v %v", len(hub.events), res, err)
	}
}

func TestFlushSkipsOtherHub(t *testing.T) {
	s, _ := newStore(t)
	submit(t, s, KindTokenScore, `{}`)
	hub := newFakeSender()
	other := testID
	other.HubURL = "https://other.example.test/"
	if _, err := s.Flush(context.Background(), other, hub.send); err != nil || len(hub.events) != 0 {
		t.Fatalf("không gửi mục của hub khác: %d %v", len(hub.events), err)
	}
	withSlash := testID
	withSlash.HubURL += "/"
	if res, err := s.Flush(context.Background(), withSlash, hub.send); err != nil || res.Accepted != 1 {
		t.Fatalf("dấu / cuối không đổi hub: %+v %v", res, err)
	}
}

func TestSubmitReplaceDropsOlderOfSameKind(t *testing.T) {
	s, c := newStore(t)
	old := submit(t, s, KindTokenScore, `{"v":1}`)
	keep := submit(t, s, KindMemoryPropose, `{}`)
	c.add(time.Second)
	nu, err := s.Submit(testID, Submission{Kind: KindTokenScore, Payload: json.RawMessage(`{"v":2}`), Replace: true})
	if err != nil {
		t.Fatal(err)
	}
	keys := map[string]bool{}
	for _, it := range list(t, s) {
		keys[it.Key] = true
	}
	if keys[old.Key] || !keys[keep.Key] || !keys[nu.Key] {
		t.Errorf("thay bản cũ cùng kind: %v", keys)
	}
}

func TestSubmitKeepsGivenKeyAndIsIdempotent(t *testing.T) {
	s, _ := newStore(t)
	at := t0.Add(-time.Hour)
	sub := Submission{Kind: KindTokenScore, Payload: json.RawMessage(`{}`), Key: "01JABCDEFGHJKMNPQRSTVWXYZ0", CreatedAt: at}
	a, err := s.Submit(testID, sub)
	if err != nil || a.Key != sub.Key || !a.CreatedAt.Equal(at) {
		t.Fatalf("%+v %v", a, err)
	}
	if _, err := s.Submit(testID, sub); err != nil || len(list(t, s)) != 1 {
		t.Errorf("nộp lại cùng khoá không tạo mục mới: %v", err)
	}
}

func TestSentLogPrunedAfter14Days(t *testing.T) {
	s, c := newStore(t)
	submit(t, s, KindTokenScore, `{}`)
	hub := newFakeSender()
	if _, err := s.Flush(context.Background(), testID, hub.send); err != nil {
		t.Fatal(err)
	}
	c.add(15 * 24 * time.Hour)
	if _, err := s.Flush(context.Background(), testID, hub.send); err != nil {
		t.Fatal(err)
	}
	if sent, _ := s.Sent(testID); len(sent) != 0 {
		t.Errorf("sent.jsonl giữ 14 ngày: %+v", sent)
	}
}

func TestIdentityKey(t *testing.T) {
	if got := testID.Key(); got != "machine-may-1" {
		t.Errorf("khoá danh tính: %q", got)
	}
	weird := Identity{MachineID: "../x y"}
	if k := weird.Key(); strings.ContainsAny(k, `/\. `) || !strings.HasPrefix(k, "machine-") {
		t.Errorf("khoá danh tính phải an toàn làm tên thư mục: %q", k)
	}
}

func TestNewKey(t *testing.T) {
	a, b := NewKey(t0), NewKey(t0)
	if len(a) != 26 || a == b || a[:10] != b[:10] || !keyPattern.MatchString(a) {
		t.Fatalf("khoá: %q %q", a, b)
	}
	if later := NewKey(t0.Add(time.Second)); later <= a {
		t.Errorf("khoá sau phải xếp sau: %q <= %q", later, a)
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

var userID = Identity{HubURL: "https://hub.example.test/", OrgID: "org-1", UserID: "u-1", Email: "a@example.test"}

func TestUserIdentityKey(t *testing.T) {
	k := userID.Key()
	if len(k) != 16 || strings.Trim(k, "0123456789abcdef") != "" {
		t.Fatalf("khoá người dùng phải là 16 hex: %q", k)
	}
	same := Identity{HubURL: "https://hub.example.test", UserID: "u-1"}
	other := Identity{HubURL: "https://hub2.example.test", UserID: "u-1"}
	if same.Key() != k || other.Key() == k || strings.Contains(k, "u-1") {
		t.Errorf("khoá phải chỉ theo hub và người: %q %q %q", k, same.Key(), other.Key())
	}
}

func TestSubmitUserTransports(t *testing.T) {
	s, _ := newStore(t)
	it, err := s.Submit(userID, Submission{
		Transport: TransportMCP, Kind: "task_update", Target: &Target{Type: "task", ID: "t1"},
		Payload: json.RawMessage(`{"taskId":"t1","note":"xong bước 1"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if it.Stream != "task:t1" || it.Source != "mcp-local" || it.Group != GroupProgress || it.Transport != TransportMCP {
		t.Errorf("mục: %+v", it)
	}
	if _, err := os.Stat(filepath.Join(s.Root, userID.Key(), it.Key+".json")); err != nil {
		t.Errorf("mục phải nằm trong thư mục của người dùng: %v", err)
	}
	rpc, err := s.Submit(userID, Submission{Transport: TransportRPC, Kind: "memory.write", Payload: json.RawMessage(`{}`)})
	if err != nil || rpc.Source != "hive-cli" || rpc.Stream != "memory.write" {
		t.Errorf("mục rpc: %+v %v", rpc, err)
	}

	for _, c := range []struct {
		id   Identity
		sub  Submission
		code string
	}{
		{userID, Submission{Transport: TransportMCP, Kind: "artifact_create", Payload: json.RawMessage(`{}`)}, "NOT_QUEUEABLE"},
		{userID, Submission{Transport: TransportMCP, Kind: "task_get", Payload: json.RawMessage(`{}`)}, "UNKNOWN_KIND"},
		{userID, Submission{Transport: TransportRPC, Kind: "task_update", Payload: json.RawMessage(`{}`)}, "UNKNOWN_KIND"},
		{testID, Submission{Transport: TransportMCP, Kind: "task_update", Payload: json.RawMessage(`{}`)}, "NOT_SIGNED_IN"},
	} {
		var e *Error
		if _, err := s.Submit(c.id, c.sub); !errors.As(err, &e) || e.Code != c.code {
			t.Errorf("%s/%s: muốn %s, được %v", c.sub.Transport, c.sub.Kind, c.code, err)
		}
	}
	if _, err := s.Submit(userID, Submission{Transport: TransportMCP, Kind: "task_update", Source: "ftp", Payload: json.RawMessage(`{}`)}); err == nil {
		t.Error("nguồn lạ phải bị chặn")
	}
	if _, err := s.Submit(userID, Submission{Transport: TransportMCP, Kind: "task_update", Target: &Target{Type: "task"}, Payload: json.RawMessage(`{}`)}); err == nil {
		t.Error("đích thiếu id phải bị chặn")
	}
}

func TestHeldBlocksOnlyItsStream(t *testing.T) {
	s, c := newStore(t)
	hub := newFakeSender()
	sub := func(stream string) Item {
		c.add(time.Millisecond)
		it, err := s.Submit(testID, Submission{Kind: KindProjectTokenUsage, Stream: stream, Payload: json.RawMessage(`{}`)})
		if err != nil {
			t.Fatal(err)
		}
		return it
	}
	a1, a2, b1 := sub("project:a"), sub("project:a"), sub("project:b")
	if err := s.Hold(testID, a1.Key, HeldLoginRequired); err != nil {
		t.Fatal(err)
	}
	res, err := s.Flush(context.Background(), testID, hub.send)
	if err != nil {
		t.Fatal(err)
	}
	if res.Accepted != 1 || len(hub.events) != 1 || hub.events[0].Key != b1.Key {
		t.Fatalf("chỉ stream b được gửi: %+v %+v", res, hub.events)
	}
	st, err := s.Stats(testID)
	if err != nil || st.Held != 1 || st.Pending != 1 || st.Bytes <= 0 || st.LimitBytes != DefaultMaxTotalBytes {
		t.Errorf("stats: %+v %v", st, err)
	}
	if items := list(t, s); items[0].HeldReason != HeldLoginRequired {
		t.Errorf("lý do giữ: %+v", items[0])
	}

	if n, err := s.RetryHeld(testID, HeldLoginRequired); n != 1 || err != nil {
		t.Fatalf("gửi lại mục bị giữ: %d %v", n, err)
	}
	if _, err := s.Flush(context.Background(), testID, hub.send); err != nil {
		t.Fatal(err)
	}
	if len(hub.events) != 3 || hub.events[1].Key != a1.Key || hub.events[2].Key != a2.Key || len(list(t, s)) != 0 {
		t.Errorf("stream a phải gửi đúng thứ tự sau khi đăng nhập lại: %+v", hub.events)
	}
}

func TestRetryExpiredAndExport(t *testing.T) {
	s, c := newStore(t)
	hub := newFakeSender()
	it := submit(t, s, KindTokenScore, `{"days":7}`)
	c.add(15 * 24 * time.Hour)
	if res, err := s.Flush(context.Background(), testID, hub.send); err != nil || res.Expired != 1 {
		t.Fatalf("mục phải hết hạn: %+v %v", res, err)
	}
	got, err := s.Export(testID, []string{it.Key, "KHONGCOKHOA00000000"})
	if err != nil || len(got) != 1 || got[0].State != StateExpired {
		t.Fatalf("xuất: %+v %v", got, err)
	}
	if all, _ := s.Export(testID, nil); len(all) != 1 {
		t.Errorf("xuất hết: %+v", all)
	}
	if n, err := s.Retry(testID, []string{it.Key}); n != 1 || err != nil {
		t.Fatalf("gửi lại: %d %v", n, err)
	}
	if res, err := s.Flush(context.Background(), testID, hub.send); err != nil || res.Accepted != 1 {
		t.Errorf("mục gửi lại phải được tính hạn từ lúc bấm: %+v %v", res, err)
	}
	if _, err := s.Retry(testID, []string{"../x"}); err == nil {
		t.Error("khoá lạ phải bị chặn")
	}
}
