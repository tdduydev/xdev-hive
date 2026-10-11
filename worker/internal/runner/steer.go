package runner

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"sync"
	"time"
)

// InputStreamJSON là Command.Input của CLI đọc prompt và các tin user tiếp theo từ stdin, mỗi dòng một JSON
// (`claude -p --input-format stream-json --replay-user-messages`). Chỉ CLI này mới nhận được chỉ dẫn giữa chừng.
const InputStreamJSON = "stream-json"

// Steer là chỉ dẫn thêm cho run đang chạy (gói steer của hub). ID rỗng khi hub cũ gửi: vẫn đưa vào agent nhưng không
// báo lại, vì hub cũ đóng kết nối khi gặp loại sự kiện nó không biết.
type Steer struct {
	ID    string
	Input string
}

// SteerResult báo chỉ dẫn đã vào phiên của agent hay chưa; gửi lên hub thành run_event "steer_result".
type SteerResult struct {
	SteerID string `json:"steerId"`
	Applied bool   `json:"applied"`
	Reason  string `json:"reason,omitempty"`
}

const (
	// steerFeed: số tin chờ ghi vào stdin. Chỉ dẫn hiếm khi tới dồn dập; đầy thì báo chưa áp dụng thay vì chặn.
	steerFeed = 16
	// steerPrefix đứng trước chỉ dẫn gửi cho agent, cùng câu hub dùng khi đưa chỉ dẫn vào prompt của lần thử sau.
	steerPrefix = "Chỉ dẫn thêm từ người review:\n"
)

// replayWait: CLI đã xong lượt mà chưa nhận lại (replay) chỉ dẫn gửi kèm thì chờ chừng này rồi đóng stdin, để run không
// treo nếu CLI bỏ qua tin. Biến để test rút ngắn.
var replayWait = 30 * time.Second

// steering nhận chỉ dẫn cho một run và trả kết quả qua report.
//
// Với CLI stream-json, nó giữ stdin mở: Claude không tự thoát khi stdin còn mở, kể cả đã xong lượt. Tin gửi giữa lượt
// được Claude đưa vào ngay lượt đó (sau lời gọi tool kế tiếp); tin gửi sau `result` mở lượt mới. Claude phát lại tin
// đã nhận (`isReplay`, cùng `uuid`) nên biết chắc chỉ dẫn nào đã vào. stdin chỉ đóng khi có `result` mà không còn chỉ
// dẫn chờ phát lại, nên CLI thoát sau lượt cuối.
type steering struct {
	cli    string
	report func(SteerResult)

	mu       sync.Mutex
	wg       sync.WaitGroup
	feed     chan []byte // nil: CLI không đọc tin từ stdin
	closed   bool        // đã yêu cầu đóng stdin
	exited   bool        // CLI đã thoát
	pending  map[string]Steer
	results  int
	replays  int
	timer    *time.Timer
	partial  []byte
	skipping bool

	stop     chan struct{}
	done     chan struct{}
	stopOnce sync.Once
}

func newSteering(cli string, report func(SteerResult)) *steering {
	return &steering{cli: cli, report: report, pending: map[string]Steer{}, stop: make(chan struct{})}
}

// attach nhận stdin của CLI vừa chạy và gửi prompt làm tin đầu tiên. Một goroutine ghi tuần tự để không giữ khoá
// trong lúc ghi: CLI chưa đọc stdin thì lệnh ghi chặn, còn stdout của nó vẫn phải được đọc.
func (s *steering) attach(stdin io.WriteCloser, prompt string) {
	feed := make(chan []byte, steerFeed+1)
	feed <- userMessage(newUUID(), prompt)
	go func() {
		failed := false
		for b := range feed {
			// CLI đã thoát thì ghi lỗi; vẫn đọc hết kênh để người gửi không chặn.
			if !failed {
				_, err := stdin.Write(b)
				failed = err != nil
			}
		}
		_ = stdin.Close()
	}()
	s.mu.Lock()
	s.feed = feed
	s.mu.Unlock()
}

// listen nhận chỉ dẫn từ kênh tới khi shutdown.
func (s *steering) listen(in <-chan Steer) {
	s.done = make(chan struct{})
	go func() {
		defer close(s.done)
		for {
			select {
			case st := <-in:
				s.send(st)
			case <-s.stop:
				return
			}
		}
	}()
}

func (s *steering) send(st Steer) {
	s.mu.Lock()
	reason := ""
	switch {
	case s.exited:
		reason = "Agent đã chạy xong, chỉ dẫn sẽ dùng ở lần chạy sau"
	case s.feed == nil:
		reason = fmt.Sprintf("CLI %s chưa nhận chỉ dẫn giữa chừng, chỉ dẫn sẽ dùng ở lần chạy sau", s.cli)
	case s.closed:
		reason = "Agent đã xong lượt cuối, chỉ dẫn sẽ dùng ở lần chạy sau"
	default:
		id := newUUID()
		select {
		case s.feed <- userMessage(id, steerPrefix+st.Input):
			s.pending[id] = st
			s.mu.Unlock()
			return
		default:
			reason = "Quá nhiều chỉ dẫn đang chờ agent đọc"
		}
	}
	s.wg.Add(1)
	s.mu.Unlock()
	defer s.wg.Done()
	s.report(SteerResult{SteerID: st.ID, Reason: reason})
}

// Write nhận stdout của CLI (nối qua io.MultiWriter), tách dòng như meter.
func (s *steering) Write(p []byte) (int, error) {
	rest := p
	for len(rest) > 0 {
		i := bytes.IndexByte(rest, '\n')
		if i < 0 {
			if !s.skipping {
				s.partial = append(s.partial, rest...)
				if len(s.partial) > maxLine {
					s.partial, s.skipping = nil, true
				}
			}
			break
		}
		if !s.skipping {
			s.line(append(s.partial, rest[:i]...))
		}
		s.partial, s.skipping = s.partial[:0], false
		rest = rest[i+1:]
	}
	return len(p), nil
}

type streamLine struct {
	Type     string `json:"type"`
	UUID     string `json:"uuid"`
	IsReplay bool   `json:"isReplay"`
	IsError  bool   `json:"is_error"`
}

func (s *steering) line(b []byte) {
	var l streamLine
	if json.Unmarshal(bytes.TrimSpace(b), &l) != nil || l.Type != "user" && l.Type != "result" {
		return
	}
	var applied, dropped []Steer
	s.mu.Lock()
	if s.exited {
		s.mu.Unlock()
		return
	}
	switch {
	case l.Type == "user" && l.IsReplay:
		s.replays++
		if st, ok := s.pending[l.UUID]; ok {
			delete(s.pending, l.UUID)
			applied = append(applied, st)
		}
	case l.Type == "result":
		s.results++
		switch {
		case l.IsError:
			// Lượt lỗi (vượt --max-budget-usd, lỗi API): không mở lượt mới cho chỉ dẫn còn chờ.
			dropped = s.closeLocked()
		case len(s.pending) == 0:
			s.closeLocked()
		default:
			s.armLocked()
		}
	}
	s.wg.Add(1)
	s.mu.Unlock()
	defer s.wg.Done()
	for _, st := range applied {
		s.report(SteerResult{SteerID: st.ID, Applied: true})
	}
	for _, st := range dropped {
		s.report(SteerResult{SteerID: st.ID, Reason: "Agent dừng vì lỗi trước khi đọc chỉ dẫn"})
	}
}

// armLocked hẹn đóng stdin nếu sau lượt vừa xong CLI không phát lại chỉ dẫn nào và cũng không xong thêm lượt nào.
func (s *steering) armLocked() {
	if s.timer != nil {
		s.timer.Stop()
	}
	results, replays := s.results, s.replays
	s.timer = time.AfterFunc(replayWait, func() {
		s.mu.Lock()
		if s.closed || s.exited || s.results != results || s.replays != replays {
			s.mu.Unlock()
			return
		}
		dropped := s.closeLocked()
		s.wg.Add(1)
		s.mu.Unlock()
		defer s.wg.Done()
		for _, st := range dropped {
			s.report(SteerResult{SteerID: st.ID, Reason: "Agent không nhận chỉ dẫn sau lượt cuối"})
		}
	})
}

// closeLocked đóng stdin để CLI thoát; trả các chỉ dẫn còn chờ (sẽ không bao giờ được đọc).
func (s *steering) closeLocked() []Steer {
	if s.timer != nil {
		s.timer.Stop()
	}
	if s.feed != nil && !s.closed {
		close(s.feed)
	}
	s.closed = true
	out := make([]Steer, 0, len(s.pending))
	for id, st := range s.pending {
		out = append(out, st)
		delete(s.pending, id)
	}
	return out
}

// finish chạy khi CLI đã thoát: chỉ dẫn còn chờ là chưa vào agent. Chờ mọi báo cáo đang gửi xong, để không có sự kiện
// nào đi sau run_result (hub bỏ chúng).
func (s *steering) finish() {
	s.mu.Lock()
	dropped := s.closeLocked()
	s.exited = true
	s.mu.Unlock()
	for _, st := range dropped {
		s.report(SteerResult{SteerID: st.ID, Reason: "Agent đã kết thúc trước khi đọc chỉ dẫn"})
	}
	s.wg.Wait()
}

// shutdown ngừng nhận chỉ dẫn; gọi trước khi gửi kết quả của run.
func (s *steering) shutdown() {
	s.stopOnce.Do(func() { close(s.stop) })
	if s.done != nil {
		<-s.done
	}
	s.wg.Wait()
}

func userMessage(id, text string) []byte {
	b, _ := json.Marshal(map[string]any{
		"type":               "user",
		"uuid":               id,
		"session_id":         "",
		"parent_tool_use_id": nil,
		"message":            map[string]any{"role": "user", "content": text},
	})
	return append(b, '\n')
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
