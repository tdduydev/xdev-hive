package runner

import (
	"bytes"
	"sync"
	"time"
)

// costInterval: hub ghi mỗi sự kiện cost vào run_events, nên gửi tối đa một lần mỗi 5 giây.
const costInterval = 5 * time.Second

// maxLine: dòng stdout dài hơn (kết quả tool đọc file lớn) không chứa usage; bỏ để không giữ bộ nhớ vô hạn.
const maxLine = 8 << 20

// meter là io.Writer nhận stdout của CLI: tách dòng, đưa vào parser, gửi usage luỹ kế khi đổi (tối đa một lần mỗi
// interval) và gọi onExceed một lần khi usage vượt trần. Ghi thẳng như một writer để vẫn dùng được khi stdout của
// CLI được nối vào writer khác (io.MultiWriter) thay vì đọc qua pipe.
type meter struct {
	parser   UsageParser
	budget   Budget
	interval time.Duration
	now      func() time.Time
	emit     func(Usage) error
	onExceed func(reason string)

	mu       sync.Mutex
	partial  []byte
	skipping bool
	dirty    bool
	sentAt   time.Time
	reason   string
	rtk      *RTKUsage
}

func newMeter(cli string, budget Budget, emit func(Usage) error, onExceed func(string)) *meter {
	return &meter{parser: NewUsageParser(cli), budget: budget, interval: costInterval, now: time.Now, emit: emit, onExceed: onExceed}
}

func (m *meter) Write(p []byte) (int, error) {
	if m.parser == nil {
		return len(p), nil
	}
	m.mu.Lock()
	changed := false
	rest := p
	for len(rest) > 0 {
		i := bytes.IndexByte(rest, '\n')
		if i < 0 {
			if !m.skipping {
				m.partial = append(m.partial, rest...)
				if len(m.partial) > maxLine {
					m.partial, m.skipping = nil, true
				}
			}
			break
		}
		if !m.skipping {
			line := append(m.partial, rest[:i]...)
			changed = m.parser.Line(bytes.TrimSpace(line)) || changed
		}
		m.partial, m.skipping = m.partial[:0], false
		rest = rest[i+1:]
	}
	var exceeded string
	if changed {
		m.dirty = true
		if m.reason == "" {
			m.reason = m.budget.Exceeded(m.parser.Usage())
			exceeded = m.reason
		}
	}
	m.mu.Unlock()
	if exceeded != "" && m.onExceed != nil {
		m.onExceed(exceeded)
	}
	// Vượt trần thì gửi ngay để hub thấy con số khiến run dừng.
	return len(p), m.flush(exceeded != "")
}

// flush gửi usage nếu đã đổi từ lần gửi trước và đã qua interval (hoặc force).
func (m *meter) flush(force bool) error {
	if m.parser == nil {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.dirty || !force && m.now().Sub(m.sentAt) < m.interval {
		return nil
	}
	m.dirty = false
	m.sentAt = m.now()
	u := m.parser.Usage()
	u.RTK = m.rtk
	return m.emit(u)
}

// setRTK gắn số RTK của lần thử vào usage, gửi ở lần flush kế tiếp (usage cuối).
func (m *meter) setRTK(r *RTKUsage) {
	if m.parser == nil {
		return
	}
	m.mu.Lock()
	m.rtk = r
	m.dirty = true
	m.mu.Unlock()
}

// finish đọc nốt dòng cuối không có '\n' rồi gửi usage cuối cùng.
func (m *meter) finish() error {
	if m.parser == nil {
		return nil
	}
	m.mu.Lock()
	if len(m.partial) > 0 && !m.skipping && m.parser.Line(bytes.TrimSpace(m.partial)) {
		m.dirty = true
		if m.reason == "" {
			m.reason = m.budget.Exceeded(m.parser.Usage())
		}
	}
	m.partial = nil
	m.mu.Unlock()
	return m.flush(true)
}

// exceeded trả lý do vượt trần, rỗng khi chưa vượt.
func (m *meter) exceeded() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.reason
}

// stopper là parser đọc được việc CLI tự dừng vì chạm giới hạn (--max-turns, --max-budget-usd).
type stopper interface{ StopSubtype() string }

// stopSubtype trả loại giới hạn CLI tự dừng vì nó; rỗng khi parser không báo hay CLI chưa dừng vì giới hạn.
func (m *meter) stopSubtype() string {
	if m.parser == nil {
		return ""
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.parser.(stopper); ok {
		return s.StopSubtype()
	}
	return ""
}
