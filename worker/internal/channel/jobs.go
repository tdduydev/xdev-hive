package channel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/tdduydev/xdev-hive/worker/internal/runner"
)

const (
	// defaultGrace là thời gian CLI có để tự dừng khi bị huỷ mà hub không nói rõ (heartbeat_ack.cancel).
	defaultGrace = 10 * time.Second
	// minOfferWait: hub gửi lease ngay sau job_accept. Chờ quá lâu nghĩa là gói lease đã mất cùng kết nối cũ và hub
	// đã giao run cho máy khác, nên bỏ đề nghị để không giữ chỗ mãi.
	minOfferWait = time.Minute
	writeTimeout = 10 * time.Second
	// flushWait: lúc thoát vì drain, chờ hub ack các gói cuối trước khi đóng kết nối.
	flushWait     = 5 * time.Second
	restartReason = "worker khởi động lại giữa chừng, tiến trình CLI đã dừng"
	// steerBuffer: chỉ dẫn tới lúc run còn chuẩn bị (clone, setup) nằm chờ ở đây tới khi CLI chạy.
	steerBuffer = 16
)

// errOffline: chưa có kết nối. Gói của run đã nằm trên đĩa và sẽ được gửi lại khi nối lại.
var errOffline = errors.New("chưa kết nối hub")

type activeRun struct {
	runID     string
	attempt   int
	leaseID   string
	cancel    context.CancelFunc
	cancelled atomic.Bool
	grace     atomic.Int64
	steers    chan runner.Steer
}

func (r *activeRun) stop(grace time.Duration) {
	// Lệnh huỷ đầu tiên quyết định thời gian chờ: heartbeat_ack.cancel đến sau không kéo dài cancel.graceSec của hub.
	if r.cancelled.CompareAndSwap(false, true) {
		r.grace.Store(int64(grace))
	}
	r.cancel()
}

type pendingOffer struct {
	msg     *JobOffer
	expires time.Time
}

// runMarker đánh dấu run đang chạy trên máy, kèm seq đã dùng. Worker chết giữa chừng thì lần khởi động sau đọc nó để
// báo hub run đã hỏng với seq lớn hơn mọi gói đã gửi (hub bỏ gói trùng seq).
type runMarker struct {
	RunID   string `json:"runId"`
	Attempt int    `json:"attempt"`
	LeaseID string `json:"leaseId"`
	Seq     int64  `json:"seq"`
}

// jobs giữ việc của máy qua các lần nối lại. Run không phụ thuộc kết nối: mất kết nối giữa chừng chỉ làm gói đến hub
// muộn hơn, vì gói nằm trên đĩa tới khi hub ack.
type jobs struct {
	cfg     Config
	ctx     context.Context
	log     *slog.Logger
	pending string
	markers string
	now     func() time.Time

	// writeMu giữ thứ tự gói trên kết nối; mu giữ trạng thái. Không giữ mu khi ghi ra mạng.
	writeMu  sync.Mutex
	mu       sync.Mutex
	conn     *websocket.Conn
	connCtx  context.Context
	active   map[string]*activeRun
	offers   map[string]pendingOffer
	draining bool
	flushing bool
	done     chan struct{}
	wg       sync.WaitGroup
}

func newJobs(ctx context.Context, cfg Config) *jobs {
	return &jobs{
		cfg:     cfg,
		ctx:     ctx,
		log:     cfg.Logger,
		pending: filepath.Join(cfg.DataDir, "pending"),
		markers: filepath.Join(cfg.DataDir, "active"),
		now:     time.Now,
		active:  map[string]*activeRun{},
		offers:  map[string]pendingOffer{},
		done:    make(chan struct{}),
	}
}

// write gửi một gói qua kết nối hiện tại, errOffline khi chưa có kết nối.
func (j *jobs) write(v any) error {
	j.writeMu.Lock()
	defer j.writeMu.Unlock()
	j.mu.Lock()
	conn, ctx := j.conn, j.connCtx
	j.mu.Unlock()
	if conn == nil {
		return errOffline
	}
	wctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return conn.Write(wctx, websocket.MessageText, mustJSON(v))
}

// attach nhận kết nối mới. Gói chưa ack được gửi lại theo thứ tự seq trước mọi gói mới, vì hub ack "tới seq": gói mới đi
// trước sẽ làm worker xoá gói cũ khỏi đĩa khi gói cũ chưa tới hub. Rồi gửi lại job_accept của đề nghị còn chờ lease;
// hub trả lại lease nếu run vẫn là của máy này.
func (j *jobs) attach(ctx context.Context, conn *websocket.Conn) error {
	j.writeMu.Lock()
	defer j.writeMu.Unlock()
	for _, p := range pendingMessages(j.pending) {
		if err := conn.Write(ctx, websocket.MessageText, p); err != nil {
			return fmt.Errorf("gửi lại gói chờ ack: %w", err)
		}
	}
	j.mu.Lock()
	j.conn, j.connCtx = conn, ctx
	accepts := make([]JobAccept, 0, len(j.offers))
	for _, o := range j.offers {
		accepts = append(accepts, JobAccept{Type: "job_accept", V: protocolVersion, ID: newID(), RunID: o.msg.RunID, Attempt: o.msg.Attempt})
	}
	j.mu.Unlock()
	for _, a := range accepts {
		if err := conn.Write(ctx, websocket.MessageText, mustJSON(a)); err != nil {
			return fmt.Errorf("gửi lại job_accept: %w", err)
		}
	}
	return nil
}

func (j *jobs) detach(conn *websocket.Conn) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.conn == conn {
		j.conn, j.connCtx = nil, nil
	}
}

// runIDs là run đang chạy và run còn gói chưa ack, gửi trong hello.resumeRuns.
func (j *jobs) runIDs() []string {
	set := map[string]bool{}
	for _, id := range queuedRunIDs(j.pending) {
		set[id] = true
	}
	j.mu.Lock()
	for id := range j.active {
		set[id] = true
	}
	j.mu.Unlock()
	out := make([]string, 0, len(set))
	for id := range set {
		out = append(out, id)
	}
	sort.Strings(out)
	if len(out) > 64 {
		out = out[:64]
	}
	return out
}

func (j *jobs) heartbeat() Heartbeat {
	j.expireOffers()
	j.mu.Lock()
	runs := make([]HeartbeatRun, 0, len(j.active))
	for _, a := range j.active {
		runs = append(runs, HeartbeatRun{RunID: a.runID, Attempt: a.attempt, LeaseID: a.leaseID})
	}
	j.mu.Unlock()
	return Heartbeat{Type: "heartbeat", V: protocolVersion, ID: newID(), Load: len(runs), Runs: runs}
}

func (j *jobs) onOffer(m *JobOffer) {
	cli := specCLI(m.Spec)
	reason := ""
	j.mu.Lock()
	_, offered := j.offers[m.RunID]
	_, running := j.active[m.RunID]
	switch {
	case j.draining:
		reason = "máy đang thoát"
	case running:
		reason = "run này đang chạy trên máy"
	case offered:
		// Hub gửi lại đề nghị đã nhận: trả lời lại như lần đầu.
	case len(j.active)+len(j.offers) >= j.cfg.Capacity:
		reason = "máy đã đầy"
	case !contains(j.cfg.CLIs, cli):
		reason = fmt.Sprintf("máy không có CLI %q", cli)
	default:
		wait := max(time.Duration(m.TTL)*time.Second, minOfferWait)
		j.offers[m.RunID] = pendingOffer{msg: m, expires: j.now().Add(wait)}
	}
	j.mu.Unlock()
	var err error
	if reason != "" {
		err = j.write(JobReject{Type: "job_reject", V: protocolVersion, ID: newID(), RunID: m.RunID, Attempt: m.Attempt, Reason: reason})
	} else {
		// Mất kết nối thì attach gửi lại job_accept của mọi đề nghị còn giữ.
		err = j.write(JobAccept{Type: "job_accept", V: protocolVersion, ID: newID(), RunID: m.RunID, Attempt: m.Attempt})
	}
	if err != nil {
		j.log.Debug("Chưa trả lời được đề nghị job", "run", m.RunID, "error", err)
	}
}

func (j *jobs) onLease(l *Lease) {
	j.mu.Lock()
	o, ok := j.offers[l.RunID]
	if !ok || o.msg.Attempt != l.Attempt {
		j.mu.Unlock()
		// Lease gửi lại cho run đã chạy, hoặc của đề nghị đã bỏ (hết hạn, bị huỷ).
		j.log.Debug("Bỏ lease không khớp đề nghị nào", "run", l.RunID, "attempt", l.Attempt)
		return
	}
	delete(j.offers, l.RunID)
	ctx, cancel := context.WithCancel(j.ctx)
	run := &activeRun{runID: l.RunID, attempt: l.Attempt, leaseID: l.LeaseID, cancel: cancel, steers: make(chan runner.Steer, steerBuffer)}
	run.grace.Store(int64(defaultGrace))
	j.active[l.RunID] = run
	j.wg.Add(1)
	j.mu.Unlock()
	go j.execute(ctx, run, o.msg, *l)
}

func (j *jobs) execute(ctx context.Context, run *activeRun, offer *JobOffer, lease Lease) {
	defer j.wg.Done()
	defer j.finish(run)
	sink, err := j.newSink(run)
	if err != nil {
		// Không ghi được đĩa thì cũng không giữ được gói: để hub tự giao lại khi hết lease.
		j.log.Error("Không bắt đầu được run", "run", run.runID, "error", err)
		return
	}
	job, err := decodeJob(offer, lease, j.cfg.HubURL, j.cfg.Project)
	if err == nil {
		job.Steers = run.steers
		r := runner.Runner{DataDir: j.cfg.DataDir, CLICommands: j.cfg.CLICommands, Grace: func() time.Duration { return time.Duration(run.grace.Load()) }}
		err = r.Run(ctx, job, sink)
	}
	if err != nil {
		j.log.Info("Run kết thúc có lỗi", "run", run.runID, "error", err)
	}
	// Runner từ chối job trước khi chạy (thiếu repo, nhánh sai) thì chưa có kết quả: báo ngay để hub không chờ hết lease.
	if !sink.hasResult() {
		msg := "job không hợp lệ"
		if err != nil {
			msg += ": " + err.Error()
		}
		_ = sink.Emit(runner.Event{Type: "result", RunID: run.runID, Attempt: run.attempt, Result: &runner.Result{Status: "failed", Error: msg}})
	}
}

func (j *jobs) finish(run *activeRun) {
	run.cancel()
	_ = os.Remove(markerPath(j.markers, run.runID))
	j.mu.Lock()
	if j.active[run.runID] == run {
		delete(j.active, run.runID)
	}
	j.mu.Unlock()
	j.checkIdle()
}

func (j *jobs) cancel(runID string, grace time.Duration) {
	j.mu.Lock()
	delete(j.offers, runID)
	run := j.active[runID]
	j.mu.Unlock()
	if run != nil {
		run.stop(grace)
	}
	j.checkIdle()
}

// steer chuyển chỉ dẫn của hub tới run đang chạy. Run không còn trên máy (đã xong, chưa nhận lease) hay khác lần thử thì
// bỏ: không trả lời thì hub giữ delivered false và chỉ dẫn vẫn vào prompt của lần thử sau.
func (j *jobs) steer(m *Steer) {
	j.mu.Lock()
	run := j.active[m.RunID]
	j.mu.Unlock()
	switch {
	case run == nil:
		j.log.Info("Bỏ chỉ dẫn cho run không chạy trên máy", "run", m.RunID, "steer", m.SteerID)
	case m.Attempt != 0 && m.Attempt != run.attempt:
		j.log.Info("Bỏ chỉ dẫn của lần thử khác", "run", m.RunID, "attempt", m.Attempt, "running", run.attempt, "steer", m.SteerID)
	default:
		select {
		case run.steers <- runner.Steer{ID: m.SteerID, Input: m.Input}:
			j.log.Info("Đã nhận chỉ dẫn cho run đang chạy", "run", m.RunID, "steer", m.SteerID)
		default:
			j.log.Warn("Bỏ chỉ dẫn vì run còn nhiều chỉ dẫn chưa xử lý", "run", m.RunID, "steer", m.SteerID)
		}
	}
}

func (j *jobs) drain() {
	j.mu.Lock()
	j.draining = true
	j.mu.Unlock()
	j.checkIdle()
}

func (j *jobs) expireOffers() {
	now := j.now()
	j.mu.Lock()
	for id, o := range j.offers {
		if now.After(o.expires) {
			delete(j.offers, id)
			j.log.Warn("Bỏ đề nghị job vì không nhận được lease", "run", id)
		}
	}
	j.mu.Unlock()
	j.checkIdle()
}

// checkIdle: đang drain mà hết việc thì chờ hub ack gói cuối (tối đa flushWait) rồi báo Run thoát.
func (j *jobs) checkIdle() {
	j.mu.Lock()
	idle := j.draining && !j.flushing && len(j.active) == 0 && len(j.offers) == 0
	if idle {
		j.flushing = true
	}
	j.mu.Unlock()
	if !idle {
		return
	}
	go func() {
		deadline := j.now().Add(flushWait)
		for len(pendingMessages(j.pending)) > 0 && j.now().Before(deadline) && j.ctx.Err() == nil {
			time.Sleep(50 * time.Millisecond)
		}
		close(j.done)
	}()
}

func (j *jobs) finished() bool {
	select {
	case <-j.done:
		return true
	default:
		return false
	}
}

// wait chờ các run đang chạy dừng hẳn (CLI thoát, worktree được gỡ, kết quả ghi xuống đĩa) khi worker tắt.
func (j *jobs) wait(timeout time.Duration) {
	ch := make(chan struct{})
	go func() { j.wg.Wait(); close(ch) }()
	select {
	case <-ch:
	case <-time.After(timeout):
		j.log.Warn("Run chưa dừng hẳn khi worker thoát; lần khởi động sau sẽ báo hub run đã hỏng")
	}
}

// ---- Gói của run trên đĩa ------------------------------------------------------------------------------------------

// durableSink đổi sự kiện của runner thành gói giao thức. Mỗi gói được ghi xuống đĩa trước khi gửi và chỉ xoá khi hub
// ack, nên mất kết nối hay worker chết không làm mất log hay kết quả.
type durableSink struct {
	mu     sync.Mutex
	dir    string
	marker string
	run    runMarker
	send   func(any) error
	log    *slog.Logger
	result bool
}

func (j *jobs) newSink(run *activeRun) (*durableSink, error) {
	if err := os.MkdirAll(j.markers, 0700); err != nil {
		return nil, err
	}
	s := &durableSink{dir: j.pending, marker: markerPath(j.markers, run.runID), run: runMarker{RunID: run.runID, Attempt: run.attempt, LeaseID: run.leaseID}, send: j.write, log: j.log}
	return s, writeMarker(s.marker, s.run)
}

func (s *durableSink) hasResult() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.result
}

func (s *durableSink) Emit(e runner.Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.run.Seq++
	seq := s.run.Seq
	var msg any
	switch e.Type {
	case "log":
		msg = LogChunk{Type: "log_chunk", V: protocolVersion, ID: newID(), RunID: e.RunID, Attempt: e.Attempt, Seq: seq, Offset: e.Offset, Bytes: e.Data}
	case "result":
		s.result = true
		msg = resultMessage(e.RunID, e.Attempt, seq, e.Result)
	case "cost":
		data, _ := json.Marshal(e.Cost)
		msg = RunEvent{Type: "run_event", V: protocolVersion, ID: newID(), RunID: e.RunID, Attempt: e.Attempt, Seq: seq, Event: e.Type, Data: data}
	case "steer_result":
		data, _ := json.Marshal(e.Steer)
		msg = RunEvent{Type: "run_event", V: protocolVersion, ID: newID(), RunID: e.RunID, Attempt: e.Attempt, Seq: seq, Event: e.Type, Data: data}
	default:
		data, _ := json.Marshal(map[string]any{"phase": e.Phase, "event": e.Type})
		msg = RunEvent{Type: "run_event", V: protocolVersion, ID: newID(), RunID: e.RunID, Attempt: e.Attempt, Seq: seq, Event: e.Type, Data: data}
	}
	if err := writePending(s.dir, e.RunID, e.Attempt, seq, msg); err != nil {
		return err
	}
	if err := writeMarker(s.marker, s.run); err != nil {
		return err
	}
	// Lỗi mạng không làm hỏng run: gói đã nằm trên đĩa và được gửi lại khi nối lại.
	if err := s.send(msg); err != nil && !errors.Is(err, errOffline) {
		s.log.Debug("Chưa gửi được gói, sẽ gửi lại khi nối lại", "run", e.RunID, "seq", seq, "error", err)
	}
	return nil
}

func resultMessage(runID string, attempt int, seq int64, r *runner.Result) RunResult {
	report, _ := json.Marshal(r)
	var sha *string
	exit := 1
	var stats *runner.DiffStats
	if r != nil {
		stats = r.DiffStats
		if r.HeadSHA != "" {
			v := r.HeadSHA
			sha = &v
		}
		if r.Status == "succeeded" || r.Status == "no_changes" {
			exit = 0
		}
	}
	return RunResult{Type: "run_result", V: protocolVersion, ID: newID(), RunID: runID, Attempt: attempt, Seq: seq, Exit: exit, HeadSHA: sha, Report: report, DiffStats: stats}
}

func safeID(s string) string { return strings.NewReplacer("/", "_", "\\", "_", ":", "_").Replace(s) }

func pendingName(runID string, attempt int, seq int64) string {
	return fmt.Sprintf("%s-%d-%020d.json", safeID(runID), attempt, seq)
}

func writePending(dir, runID string, attempt int, seq int64, msg any) error {
	b, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, pendingName(runID, attempt, seq)), b, 0600)
}

func markerPath(dir, runID string) string { return filepath.Join(dir, safeID(runID)+".json") }

// writeMarker ghi qua file tạm rồi đổi tên, để worker chết giữa lúc ghi không để lại marker hỏng.
func writeMarker(path string, m runMarker) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

type pendingHead struct {
	Type    string `json:"type"`
	RunID   string `json:"runId"`
	Attempt int    `json:"attempt"`
	Seq     int64  `json:"seq"`
}

type pendingItem struct {
	path string
	head pendingHead
	raw  []byte
}

func readPending(dir string) []pendingItem {
	// Glob trả tên đã sắp xếp: theo run, attempt rồi seq (seq có độ dài cố định).
	files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	out := make([]pendingItem, 0, len(files))
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		var h pendingHead
		if json.Unmarshal(b, &h) != nil || h.RunID == "" {
			continue
		}
		out = append(out, pendingItem{f, h, b})
	}
	return out
}

func pendingMessages(dir string) []json.RawMessage {
	items := readPending(dir)
	out := make([]json.RawMessage, 0, len(items))
	for _, it := range items {
		out = append(out, it.raw)
	}
	return out
}

func queuedRunIDs(dir string) []string {
	set := map[string]bool{}
	out := []string{}
	for _, it := range readPending(dir) {
		if !set[it.head.RunID] {
			set[it.head.RunID] = true
			out = append(out, it.head.RunID)
		}
	}
	return out
}

// ackPending xoá gói của run có seq tới uptoSeq. Ack không mang attempt: gói của attempt cũ hub đã bỏ (fencing) nên
// xoá cùng không sao.
func ackPending(dir, runID string, upto int64) {
	for _, it := range readPending(dir) {
		if it.head.RunID == runID && it.head.Seq <= upto {
			_ = os.Remove(it.path)
		}
	}
}

// recoverInterrupted chạy lúc worker khởi động: run còn marker là run đang chạy khi worker chết. Tiến trình CLI đã
// chết theo, nên ghi sẵn kết quả lỗi vào hàng đợi để hub kết thúc run ngay thay vì chờ hết lease.
func recoverInterrupted(dataDir string, log *slog.Logger) error {
	pending := filepath.Join(dataDir, "pending")
	markers, err := filepath.Glob(filepath.Join(dataDir, "active", "*.json"))
	if err != nil {
		return err
	}
	items := readPending(pending)
	for _, f := range markers {
		var m runMarker
		b, err := os.ReadFile(f)
		if err == nil {
			err = json.Unmarshal(b, &m)
		}
		if err != nil || m.RunID == "" {
			_ = os.Remove(f)
			continue
		}
		done := false
		for _, it := range items {
			if it.head.RunID == m.RunID && it.head.Attempt == m.Attempt && it.head.Type == "run_result" {
				done = true
				break
			}
		}
		if !done {
			msg := resultMessage(m.RunID, m.Attempt, m.Seq+1, &runner.Result{Status: "failed", Error: restartReason})
			if err := writePending(pending, m.RunID, m.Attempt, m.Seq+1, msg); err != nil {
				return err
			}
			log.Warn("Run bị ngắt vì worker khởi động lại; báo hub run hỏng", "run", m.RunID, "attempt", m.Attempt)
		}
		if err := os.Remove(f); err != nil {
			return err
		}
	}
	return nil
}

func specCLI(raw json.RawMessage) string {
	var s struct {
		CLI string `json:"cli"`
	}
	_ = json.Unmarshal(raw, &s)
	return s.CLI
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func newID() string {
	id, err := messageID()
	if err != nil {
		// crypto/rand không lỗi trên các hệ điều hành worker hỗ trợ; id chỉ để log và loại trùng.
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return id
}
