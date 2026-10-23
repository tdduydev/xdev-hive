package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/config"
	"github.com/tdduydev/xdev-hive/worker/internal/hubclient"
	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/outbox"
	"github.com/tdduydev/xdev-hive/worker/internal/version"
)

// Op hộp thư đi qua socket cục bộ (specs/027 contracts/outbox-ipc.md): `hive mcp`, `hive outbox`, app desktop và VS Code
// nộp lần ghi của người dùng cho worker giữ và gửi, để chỉ một tiến trình trên máy giữ hàng đợi và thứ tự gửi.

const (
	defaultSubmitWait = 10 * time.Second
	maxSubmitWait     = time.Minute
	immediateTimeout  = time.Minute
	defaultListLimit  = 200

	hubUp       = "up"
	hubDown     = "down"
	hubRetrying = "retrying"
)

// hubHealth là trạng thái hub theo lần gửi gần nhất, cho thanh "Hub đang vắng – N mục chờ gửi".
type hubHealth struct {
	State         string
	LastContactAt *time.Time
}

// flushState giữ một lượt gửi cho mỗi danh tính: nộp dồn dập chỉ gây thêm một lượt sau lượt đang chạy, không chạy
// song song (khoá file của Store cũng chặn, nhưng sẽ làm lượt sau chờ tới 30 giây).
type flushState struct {
	running bool
	again   bool
	started int
	waiters []*submitWaiter
}

// submitWaiter chờ kết quả của một khoá; after là số lượt đã bắt đầu lúc đăng ký, vì lượt đang chạy khi đó có thể đã
// đọc thư mục trước khi mục được ghi.
type submitWaiter struct {
	key   string
	after int
	ch    chan *outbox.Outcome
}

type outboxService struct {
	ctx   context.Context
	cfg   config.Config
	store outbox.Store
	creds *outbox.Credentials
	send  outbox.Dispatcher
	// flushMachine gửi mục kênh `worker` bằng machine token; test thay để khỏi cần hub giả cho sự kiện máy.
	flushMachine func(ctx context.Context, cfg config.Config) (outbox.FlushResult, error)
	now          func() time.Time

	mu       sync.Mutex
	flushes  map[string]*flushState
	health   map[string]*hubHealth
	loginFor map[string]string
	// notify đẩy sự kiện vào luồng watch (nil là máy không có watch). notifyMu xếp các lần báo `outbox` theo thứ tự,
	// để số liệu cũ không tới sau số liệu mới.
	notify      func(any)
	notifyMu    sync.Mutex
	lastSummary string
}

// newOutboxService dựng phần hộp thư đi của `hive-worker run`. ctx là đời của worker: lượt gửi không theo ctx của yêu
// cầu, để client hết waitMs không làm lần gửi đang dở bị huỷ rồi bị coi là hub vắng.
func newOutboxService(ctx context.Context, cfg config.Config) (*outboxService, error) {
	store, err := machineOutbox()
	if err != nil {
		return nil, err
	}
	hc := optimizeHubHTTP()
	creds := &outbox.Credentials{Resolve: outbox.MeResolver(hc)}
	sender := outbox.UserSender{HTTP: hc, Token: creds.Token, MachineID: cfg.MachineID, Client: "hive-worker/" + version.Version}
	return &outboxService{
		ctx: ctx, cfg: cfg, store: store, creds: creds, send: sender.Dispatch, flushMachine: flushMachineOutbox, now: optimizeNow,
		flushes: map[string]*flushState{}, health: map[string]*hubHealth{}, loginFor: map[string]string{},
	}, nil
}

func (s *outboxService) handle(ctx context.Context, c *localipc.Conn, req localipc.Request) error {
	switch req.Op {
	case "outbox.submit":
		return s.submit(ctx, c, req)
	case "outbox.status":
		return s.status(c)
	case "outbox.list":
		return s.list(c, req)
	case "outbox.drop":
		return s.drop(c, req)
	case "outbox.retry":
		return s.retry(c, req)
	case "outbox.export":
		return s.export(c, req)
	}
	return c.Fail(localipc.CodeUnsupported, fmt.Sprintf("hive-worker này chưa có op %s", req.Op))
}

// loop gửi hộp thư đi theo nhịp: mục của máy, rồi mục của từng người còn trong hộp thư (cả người đã đăng xuất: mục chờ
// tới khi họ đăng nhập lại, Token giữ mục chứ không gửi bằng token của người khác).
func (s *outboxService) loop(every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		s.tick()
		select {
		case <-s.ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (s *outboxService) tick() {
	if s.cfg.HubURL != "" && s.cfg.MachineToken != "" {
		res, err := s.flushMachine(s.ctx, s.cfg)
		s.observe(s.cfg.HubURL, res)
		if err != nil && s.ctx.Err() == nil {
			slog.Warn("không gửi được hộp thư đi", "err", err)
		}
		s.changed()
	}
	ids, err := s.store.Identities()
	if err != nil {
		slog.Warn("không đọc được hộp thư đi", "err", err)
		return
	}
	for _, id := range ids {
		if !id.IsUser() {
			continue
		}
		s.releaseHeld(id)
		s.kick(id, nil)
	}
}

// releaseHeld đưa mục bị giữ vì đăng nhập về hàng đợi khi máy đổi sang đúng người (spec 027 FR-018). Chỉ làm khi lần
// đăng nhập đổi, để token bị thu hồi không làm mỗi nhịp lại gọi hub một lần 401.
func (s *outboxService) releaseHeld(id outbox.Identity) {
	token, err := s.creds.Token(s.ctx, id)
	if err != nil {
		return
	}
	sum := sha256.Sum256([]byte(token))
	fp := hex.EncodeToString(sum[:])
	s.mu.Lock()
	seen := s.loginFor[id.Key()] == fp
	s.loginFor[id.Key()] = fp
	s.mu.Unlock()
	if seen {
		return
	}
	for _, reason := range []string{outbox.HeldLoginRequired, outbox.HeldIdentityMismatch} {
		if _, err := s.store.RetryHeld(id, reason); err != nil {
			slog.Warn("không đưa được mục bị giữ về hàng đợi", "err", err)
		}
	}
}

// kick chạy một lượt gửi cho danh tính, hoặc hẹn thêm một lượt nếu đang có lượt chạy. w (có thể nil) nhận kết quả của
// lượt đầu tiên bắt đầu sau khi đăng ký.
func (s *outboxService) kick(id outbox.Identity, w *submitWaiter) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.flushes[id.Key()]
	if st == nil {
		st = &flushState{}
		s.flushes[id.Key()] = st
	}
	if w != nil {
		w.after = st.started
		st.waiters = append(st.waiters, w)
	}
	if st.running {
		st.again = true
		return
	}
	st.running = true
	go s.flushLoop(id, st)
}

func (s *outboxService) flushLoop(id outbox.Identity, st *flushState) {
	for {
		s.mu.Lock()
		st.started++
		n := st.started
		st.again = false
		s.mu.Unlock()

		res, err := s.store.FlushWith(s.ctx, id, s.send)
		if err != nil && s.ctx.Err() == nil {
			slog.Warn("không gửi được hộp thư đi", "err", err)
		}
		s.observe(id.HubURL, res)
		outcomes := map[string]outbox.Outcome{}
		for _, o := range res.Items {
			outcomes[o.Key] = o
			s.itemChanged(o)
		}
		s.changed()

		s.mu.Lock()
		keep := st.waiters[:0]
		for _, w := range st.waiters {
			if w.after >= n {
				keep = append(keep, w)
				continue
			}
			// Không có kết quả trong lượt (hub vắng, chờ backoff, chặn sau mục bị giữ) nghĩa là mục còn xếp hàng.
			if o, ok := outcomes[w.key]; ok {
				w.ch <- &o
			} else {
				w.ch <- nil
			}
		}
		clear(st.waiters[len(keep):])
		st.waiters = keep
		if !st.again || s.ctx.Err() != nil {
			st.running = false
			s.mu.Unlock()
			return
		}
		s.mu.Unlock()
	}
}

// observe cập nhật trạng thái hub từ một lượt gửi. Lượt không gửi mục nào thì không biết gì thêm về hub.
func (s *outboxService) observe(hub string, res outbox.FlushResult) {
	hub = strings.TrimRight(hub, "/")
	answered := res.Accepted+res.Duplicate+res.Rejected > 0 || (res.Retry > 0 && !res.Offline)
	if hub == "" || (!answered && !res.Offline) {
		return
	}
	s.setHealth(hub, res.Offline, res.Retry > 0)
}

func (s *outboxService) setHealth(hub string, offline, retrying bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	h := s.health[hub]
	if h == nil {
		h = &hubHealth{}
		s.health[hub] = h
	}
	switch {
	case offline:
		h.State = hubDown
		return
	case retrying:
		h.State = hubRetrying
	default:
		h.State = hubUp
	}
	now := s.now().UTC()
	h.LastContactAt = &now
}

// hubState là trạng thái của hub. Chưa gửi lần nào thì coi là `up`: worker chưa có bằng chứng hub vắng.
func (s *outboxService) hubState(hub string) (string, *time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	h := s.health[strings.TrimRight(hub, "/")]
	if h == nil || h.State == "" {
		return hubUp, nil
	}
	return h.State, h.LastContactAt
}

type outboxSubmitRequest struct {
	Key       string          `json:"key"`
	Source    string          `json:"source"`
	Transport string          `json:"transport"`
	Kind      string          `json:"kind"`
	Target    *outbox.Target  `json:"target"`
	Project   string          `json:"project"`
	Body      json.RawMessage `json:"body"`
	BodyFile  string          `json:"bodyFile"`
	CreatedAt string          `json:"createdAt"`
	WaitMs    *int            `json:"waitMs"`
}

func (s *outboxService) submit(ctx context.Context, c *localipc.Conn, req localipc.Request) error {
	var r outboxSubmitRequest
	if err := req.Decode(&r); err != nil {
		return c.Fail(localipc.CodeBadRequest, err.Error())
	}
	if r.Transport != outbox.TransportMCP && r.Transport != outbox.TransportRPC {
		return c.Fail(localipc.CodeBadRequest, "transport phải là mcp hoặc rpc")
	}
	body := r.Body
	if r.BodyFile != "" {
		b, err := s.readBodyFile(r.BodyFile)
		if err != nil {
			return failOutbox(c, err)
		}
		body = b
	}
	var created time.Time
	if r.CreatedAt != "" {
		t, err := time.Parse(time.RFC3339Nano, r.CreatedAt)
		if err != nil {
			return c.Fail(localipc.CodeBadRequest, "createdAt phải theo RFC 3339")
		}
		created = t
	}
	wait := defaultSubmitWait
	if r.WaitMs != nil {
		wait = min(max(time.Duration(*r.WaitMs)*time.Millisecond, 0), maxSubmitWait)
	}
	id, err := s.creds.Current(ctx)
	if err != nil {
		var oe *outbox.Error
		if errors.As(err, &oe) {
			return c.Fail(oe.Code, oe.Message)
		}
		// Hỏi hub danh tính của token mà hub vắng: chưa biết ghi mục cho ai thì không xếp hàng được.
		return c.Fail(localipc.CodeFailed, err.Error())
	}
	sub := outbox.Submission{
		Transport: r.Transport, Kind: r.Kind, Source: r.Source, Target: r.Target, Project: r.Project,
		Payload: unwrapBody(r.Transport, r.Kind, body), Key: r.Key, CreatedAt: created,
	}
	it, err := s.store.Prepare(id, sub)
	if err != nil {
		return failOutbox(c, err)
	}
	if !outbox.Queueable(it.Group) {
		return s.sendNow(ctx, c, it)
	}
	it, err = s.store.Submit(id, sub)
	if err != nil {
		return failOutbox(c, err)
	}
	s.changed()
	// Nộp lại khoá đã có kết quả (client gửi lại sau khi socket đứt): trả luôn kết quả cũ.
	switch it.State {
	case outbox.StateRejected, outbox.StateAccepted, outbox.StateDuplicate:
		o := outbox.Outcome{Key: it.Key, Kind: it.Kind, State: it.State}
		if it.Result != nil {
			o.Code, o.Reason, o.ReceivedAt, o.Response = it.Result.Code, it.Result.Reason, it.Result.ReceivedAt, it.Result.Response
		}
		return s.replyOutcome(c, id, &o)
	case outbox.StateHeld:
		return s.replyOutcome(c, id, &outbox.Outcome{Key: it.Key, Kind: it.Kind, State: it.State, HeldReason: it.HeldReason, Error: it.LastError})
	}
	if wait == 0 {
		s.kick(id, nil)
		return s.replyOutcome(c, id, &outbox.Outcome{Key: it.Key, Kind: it.Kind, State: outbox.StatePending})
	}
	w := &submitWaiter{key: it.Key, ch: make(chan *outbox.Outcome, 1)}
	s.kick(id, w)
	timer := time.NewTimer(wait)
	defer timer.Stop()
	var o *outbox.Outcome
	select {
	case o = <-w.ch:
	case <-timer.C:
	case <-ctx.Done():
		return ctx.Err()
	}
	if o == nil {
		o = &outbox.Outcome{Key: it.Key, Kind: it.Kind, State: outbox.StatePending}
	}
	return s.replyOutcome(c, id, o)
}

// sendNow gửi thẳng mục nhóm `immediate` (trả lời của trưởng nhóm, artifact): người gọi cần kết quả ngay nên không xếp
// hàng; hub vắng thì báo NOT_QUEUEABLE để client nói rõ cho người dùng.
func (s *outboxService) sendNow(ctx context.Context, c *localipc.Conn, it outbox.Item) error {
	ctx, cancel := context.WithTimeout(ctx, immediateTimeout)
	defer cancel()
	// Lần gửi thẳng cũng cho biết hub còn hay vắng.
	defer s.changed()
	d, err := s.send(ctx, it)
	var (
		hold      *outbox.HoldError
		statusErr *hubclient.StatusError
	)
	switch {
	case errors.As(err, &hold):
		return c.Fail("NOT_SIGNED_IN", hold.Message)
	case errors.As(err, &statusErr):
		s.setHealth(it.Identity.HubURL, false, statusErr.Status >= 500)
		return s.replyOutcome(c, it.Identity, &outbox.Outcome{
			Key: it.Key, Kind: it.Kind, State: outbox.StateRejected, Code: fmt.Sprintf("HTTP_%d", statusErr.Status), Reason: statusErr.Message,
		})
	case err != nil:
		s.setHealth(it.Identity.HubURL, true, false)
		return c.Fail("NOT_QUEUEABLE", fmt.Sprintf("Hub đang vắng (%s). Thao tác này cần hub trả lời ngay.", it.Identity.HubURL))
	}
	s.setHealth(it.Identity.HubURL, false, false)
	o := &outbox.Outcome{Key: it.Key, Kind: it.Kind, Code: d.Result.Code, Reason: d.Result.Reason, ReceivedAt: d.Result.ReceivedAt, Response: d.Response}
	switch d.Result.Outcome {
	case hubclient.OutcomeAccepted, hubclient.OutcomeDuplicate, hubclient.OutcomeRejected:
		o.State = outbox.State(d.Result.Outcome)
	default:
		return c.Fail(localipc.CodeFailed, fmt.Sprintf("hub trả kết quả lạ %q", d.Result.Outcome))
	}
	return s.replyOutcome(c, it.Identity, o)
}

func (s *outboxService) replyOutcome(c *localipc.Conn, id outbox.Identity, o *outbox.Outcome) error {
	switch o.State {
	case outbox.StateAccepted, outbox.StateDuplicate, outbox.StateRejected:
		result := map[string]any{"outcome": string(o.State)}
		if o.Code != "" {
			result["code"] = o.Code
		}
		if o.Reason != "" {
			result["reason"] = o.Reason
		}
		if o.ReceivedAt != "" {
			result["receivedAt"] = o.ReceivedAt
		}
		if len(o.Response) > 0 {
			result["response"] = o.Response
		}
		return c.OK(map[string]any{"state": string(o.State), "key": o.Key, "result": result})
	}
	st, _ := s.store.Stats(id)
	hub, _ := s.hubState(id.HubURL)
	if o.State == outbox.StateHeld {
		// Mục bị giữ vẫn nằm trong hộp thư; client báo người dùng đăng nhập lại thay vì gọi lại.
		return c.OK(map[string]any{"state": "held", "key": o.Key, "heldReason": o.HeldReason, "reason": o.Error, "pending": st.Pending, "hub": hub})
	}
	return c.OK(map[string]any{"state": "queued", "key": o.Key, "pending": st.Pending, "hub": hub})
}

// unwrapBody nhận body dạng `tools/call` params (`{name, arguments}`) hay `{path, input}` của oRPC như contract, hoặc
// chính đối số. Chỉ bóc khi tên trong body trùng kind, để đối số tình cờ có trường `name` không bị hiểu nhầm.
func unwrapBody(transport, kind string, body json.RawMessage) json.RawMessage {
	var w struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
		Path      string          `json:"path"`
		Input     json.RawMessage `json:"input"`
	}
	if json.Unmarshal(body, &w) != nil {
		return body
	}
	switch {
	case transport == outbox.TransportMCP && w.Name == kind:
		if len(w.Arguments) == 0 || string(w.Arguments) == "null" {
			return json.RawMessage(`{}`)
		}
		return w.Arguments
	case transport == outbox.TransportRPC && w.Path != "" && strings.ReplaceAll(strings.Trim(w.Path, "/"), "/", ".") == kind:
		if len(w.Input) == 0 || string(w.Input) == "null" {
			return json.RawMessage(`{}`)
		}
		return w.Input
	}
	return body
}

// readBodyFile đọc rồi xoá file tạm của mục lớn. Chỉ nhận file trong `<outbox>/incoming`, để socket không thành đường
// đọc (rồi xoá) file bất kỳ của người dùng.
func (s *outboxService) readBodyFile(path string) (json.RawMessage, error) {
	dir := filepath.Join(s.store.Root, outbox.IncomingDir)
	clean := filepath.Clean(path)
	rel, err := filepath.Rel(dir, clean)
	if err != nil || !filepath.IsAbs(clean) || rel == "." || strings.HasPrefix(rel, "..") || strings.ContainsAny(rel, `/\`) {
		return nil, fmt.Errorf("bodyFile phải nằm trong %s", dir)
	}
	f, err := os.Open(clean)
	if err != nil {
		return nil, fmt.Errorf("không đọc được bodyFile: %w", err)
	}
	limit := s.store.MaxItemBytes
	if limit <= 0 {
		limit = outbox.DefaultMaxItemBytes
	}
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	_ = f.Close()
	_ = os.Remove(clean)
	if err != nil {
		return nil, fmt.Errorf("không đọc được bodyFile: %w", err)
	}
	if int64(len(b)) > limit {
		return nil, &outbox.Error{Code: "ITEM_TOO_LARGE", Message: fmt.Sprintf("Việc chờ gửi quá lớn (tối đa %d MB).", limit>>20)}
	}
	return b, nil
}

func failOutbox(c *localipc.Conn, err error) error {
	var oe *outbox.Error
	if errors.As(err, &oe) {
		return c.Fail(oe.Code, oe.Message)
	}
	return c.Fail(localipc.CodeBadRequest, err.Error())
}

// statusHub là hub hiển thị: hub người dùng đăng nhập, không có thì hub máy đăng ký.
func (s *outboxService) statusHub() string {
	if hub := s.creds.HubURL(); hub != "" {
		return hub
	}
	return strings.TrimRight(s.cfg.HubURL, "/")
}

func (s *outboxService) status(c *localipc.Conn) error {
	out, err := s.summary()
	if err != nil {
		return c.Fail(localipc.CodeFailed, err.Error())
	}
	return c.OK(out)
}

func (s *outboxService) summary() (map[string]any, error) {
	ids, err := s.store.Identities()
	if err != nil {
		return nil, err
	}
	var total outbox.Stats
	for _, id := range ids {
		st, err := s.store.Stats(id)
		if err != nil {
			return nil, err
		}
		total.Pending += st.Pending
		total.Held += st.Held
		total.Rejected += st.Rejected
		total.Expired += st.Expired
		total.Bytes += st.Bytes
	}
	total.LimitBytes = s.store.MaxTotalBytes
	if total.LimitBytes <= 0 {
		total.LimitBytes = outbox.DefaultMaxTotalBytes
	}
	hubURL := s.statusHub()
	hub, last := s.hubState(hubURL)
	out := map[string]any{
		"hub": hub, "hubUrl": hubURL, "pending": total.Pending, "held": total.Held, "rejected": total.Rejected,
		"expired": total.Expired, "bytes": total.Bytes, "limitBytes": total.LimitBytes,
	}
	if last != nil {
		out["lastContactAt"] = last.Format(time.RFC3339)
	}
	return out, nil
}

// setNotify nối hộp thư với luồng watch. loop đã chạy từ trước khi socket mở nên giữ dưới khoá.
func (s *outboxService) setNotify(f func(any)) {
	s.mu.Lock()
	s.notify = f
	s.mu.Unlock()
}

func (s *outboxService) notifier() func(any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.notify
}

// changed báo `outbox` khi số mục hay trạng thái hub đổi. Lượt gửi chạy mỗi nhịp, nên bỏ qua khi không có gì mới để
// app không phải vẽ lại liên tục.
func (s *outboxService) changed() {
	f := s.notifier()
	if f == nil {
		return
	}
	s.notifyMu.Lock()
	defer s.notifyMu.Unlock()
	sum, err := s.summary()
	if err != nil {
		return
	}
	e := map[string]any{"event": "outbox"}
	for _, k := range []string{"hub", "pending", "held", "rejected", "expired"} {
		e[k] = sum[k]
	}
	b, _ := json.Marshal(e)
	if string(b) == s.lastSummary {
		return
	}
	s.lastSummary = string(b)
	f(e)
}

// itemChanged báo kết quả của từng mục trong lượt gửi (bị từ chối, bị giữ, hub đã nhận) để app hiện ngay.
func (s *outboxService) itemChanged(o outbox.Outcome) {
	f := s.notifier()
	if f == nil {
		return
	}
	e := map[string]any{"event": "outbox.item", "key": o.Key, "kind": o.Kind, "state": string(o.State)}
	if o.Code != "" {
		e["code"] = o.Code
	}
	switch {
	case o.Reason != "":
		e["reason"] = o.Reason
	case o.Error != "":
		e["reason"] = o.Error
	}
	if o.HeldReason != "" {
		e["heldReason"] = o.HeldReason
	}
	f(e)
}

type outboxListItem struct {
	Key        string         `json:"key"`
	Kind       string         `json:"kind"`
	State      string         `json:"state"`
	CreatedAt  time.Time      `json:"createdAt"`
	Target     *outbox.Target `json:"target,omitempty"`
	Title      string         `json:"title"`
	Attempts   int            `json:"attempts"`
	Result     *listResult    `json:"result,omitempty"`
	HeldReason *string        `json:"heldReason"`
	LastError  string         `json:"lastError,omitempty"`
	Email      string         `json:"email,omitempty"`
}

type listResult struct {
	Code   string `json:"code,omitempty"`
	Reason string `json:"reason,omitempty"`
}

// allItems là mọi mục của mọi danh tính theo thứ tự tạo; danh tính đi kèm để drop/retry ghi đúng thư mục.
func (s *outboxService) allItems() ([]outbox.Item, error) {
	ids, err := s.store.Identities()
	if err != nil {
		return nil, err
	}
	var all []outbox.Item
	for _, id := range ids {
		items, err := s.store.List(id)
		if err != nil {
			return nil, err
		}
		all = append(all, items...)
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].CreatedAt.Before(all[j].CreatedAt) })
	return all, nil
}

func (s *outboxService) list(c *localipc.Conn, req localipc.Request) error {
	var r struct {
		States []string `json:"states"`
		Limit  int      `json:"limit"`
	}
	if err := req.Decode(&r); err != nil {
		return c.Fail(localipc.CodeBadRequest, err.Error())
	}
	want := map[outbox.State]bool{}
	for _, st := range r.States {
		want[outbox.State(st)] = true
		if outbox.State(st) == outbox.StatePending {
			want[outbox.StateSending] = true
		}
	}
	limit := r.Limit
	if limit <= 0 {
		limit = defaultListLimit
	}
	all, err := s.allItems()
	if err != nil {
		return c.Fail(localipc.CodeFailed, err.Error())
	}
	out := []outboxListItem{}
	for _, it := range all {
		if len(want) > 0 && !want[it.State] {
			continue
		}
		if len(out) == limit {
			break
		}
		v := outboxListItem{
			Key: it.Key, Kind: it.Kind, State: string(it.State), CreatedAt: it.CreatedAt, Target: it.Target,
			Title: itemTitle(it), Attempts: it.Attempts, LastError: it.LastError, Email: it.Identity.Email,
		}
		if v.State == string(outbox.StateSending) {
			v.State = string(outbox.StatePending)
		}
		if it.Result != nil && (it.Result.Code != "" || it.Result.Reason != "") {
			v.Result = &listResult{Code: it.Result.Code, Reason: it.Result.Reason}
		}
		if it.HeldReason != "" {
			reason := it.HeldReason
			v.HeldReason = &reason
		}
		out = append(out, v)
	}
	return c.OK(map[string]any{"items": out})
}

var kindTitles = map[string]string{
	"task_update":                "Cập nhật task",
	"sdlc_report":                "Báo cáo tiến độ",
	"sdlc_ask":                   "Câu hỏi cho người dùng",
	"doc_propose":                "Đề xuất tài liệu",
	"doc_suggest":                "Gợi ý sửa tài liệu",
	"doc_comment":                "Bình luận tài liệu",
	"skill_propose":              "Đề xuất skill",
	"skill_proposal_submit":      "Đề xuất skill",
	"memory_write":               "Ghi nhớ",
	"memory.write":               "Ghi nhớ",
	outbox.KindMemoryPropose:     "Đề xuất ghi nhớ",
	"plan_submit":                "Kế hoạch",
	"review_submit":              "Kết quả review",
	"brief_submit":               "Bản tóm tắt",
	"doc_check_submit":           "Kết quả kiểm tài liệu",
	"doc_assist_submit":          "Bản hỗ trợ tài liệu",
	outbox.KindTokenScore:        "Điểm máy",
	outbox.KindProjectTokenUsage: "Số liệu token của dự án",
}

// itemTitle dựng từ kind và target, không bao giờ từ body: danh sách hiện ở thanh trạng thái, body có thể chứa code.
func itemTitle(it outbox.Item) string {
	title := kindTitles[it.Kind]
	if title == "" {
		title = it.Kind
	}
	if t := it.Target; t != nil {
		id := t.ID
		if r := []rune(id); len(r) > 8 {
			id = string(r[:8])
		}
		title += fmt.Sprintf(" (%s %s)", t.Type, id)
	}
	return title
}

type keysRequest struct {
	Keys []string `json:"keys"`
	Path string   `json:"path"`
}

func (s *outboxService) keyed(c *localipc.Conn, req localipc.Request) (keysRequest, map[string]outbox.Item, bool, error) {
	var r keysRequest
	if err := req.Decode(&r); err != nil {
		return r, nil, false, c.Fail(localipc.CodeBadRequest, err.Error())
	}
	all, err := s.allItems()
	if err != nil {
		return r, nil, false, c.Fail(localipc.CodeFailed, err.Error())
	}
	byKey := map[string]outbox.Item{}
	for _, it := range all {
		byKey[it.Key] = it
	}
	return r, byKey, true, nil
}

func (s *outboxService) drop(c *localipc.Conn, req localipc.Request) error {
	r, byKey, ok, err := s.keyed(c, req)
	if !ok {
		return err
	}
	if len(r.Keys) == 0 {
		return c.Fail(localipc.CodeBadRequest, "cần ít nhất một khoá")
	}
	dropped, skipped := []string{}, []string{}
	for _, key := range r.Keys {
		it, found := byKey[key]
		// Mục đang chờ gửi không bỏ được: hub có thể đang nhận nó, bỏ thì người dùng tưởng chưa ghi.
		if !found || (it.State != outbox.StateRejected && it.State != outbox.StateExpired && it.State != outbox.StateHeld) {
			skipped = append(skipped, key)
			continue
		}
		if err := s.store.Drop(it.Identity, key); err != nil {
			return c.Fail(localipc.CodeFailed, err.Error())
		}
		dropped = append(dropped, key)
	}
	s.changed()
	return c.OK(map[string]any{"dropped": dropped, "skipped": skipped})
}

func (s *outboxService) retry(c *localipc.Conn, req localipc.Request) error {
	r, byKey, ok, err := s.keyed(c, req)
	if !ok {
		return err
	}
	groups := map[string][]string{}
	ids := map[string]outbox.Identity{}
	for _, key := range r.Keys {
		if it, found := byKey[key]; found {
			groups[it.Identity.Key()] = append(groups[it.Identity.Key()], key)
			ids[it.Identity.Key()] = it.Identity
		}
	}
	n := 0
	for k, keys := range groups {
		m, err := s.store.Retry(ids[k], keys)
		if err != nil {
			return c.Fail(localipc.CodeFailed, err.Error())
		}
		n += m
		if m > 0 && ids[k].IsUser() {
			s.kick(ids[k], nil)
		}
	}
	s.changed()
	return c.OK(map[string]any{"retried": n})
}

// export ghi mục (cả body) ra file người dùng chọn, để giữ lại nội dung trước khi bỏ mục bị từ chối. Không ghi token:
// mục không chứa token.
func (s *outboxService) export(c *localipc.Conn, req localipc.Request) error {
	r, byKey, ok, err := s.keyed(c, req)
	if !ok {
		return err
	}
	if r.Path == "" || !filepath.IsAbs(r.Path) {
		return c.Fail(localipc.CodeBadRequest, "path phải là đường dẫn tuyệt đối")
	}
	items := []outbox.Item{}
	if len(r.Keys) == 0 {
		all, err := s.allItems()
		if err != nil {
			return c.Fail(localipc.CodeFailed, err.Error())
		}
		items = append(items, all...)
	}
	for _, key := range r.Keys {
		if it, found := byKey[key]; found {
			items = append(items, it)
		}
	}
	b, err := json.MarshalIndent(map[string]any{"items": items}, "", "  ")
	if err != nil {
		return c.Fail(localipc.CodeFailed, err.Error())
	}
	if err := os.WriteFile(r.Path, append(b, '\n'), 0o600); err != nil {
		return c.Fail(localipc.CodeFailed, fmt.Sprintf("không ghi được %s: %v", r.Path, err))
	}
	return c.OK(map[string]any{"path": r.Path, "count": len(items)})
}
