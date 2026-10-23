package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Xem run qua SSE /api/v1/runs/:id/stream có sẵn (FR-006): hub đã kiểm quyền xem như với web, CLI chỉ nối lại theo
// Last-Event-ID khi mất mạng để không in lặp hay mất đoạn log.

// reconnectWait là chờ giữa hai lần nối lại; biến để test rút ngắn.
var reconnectWait = func(try int) time.Duration {
	return min(time.Duration(1<<min(try, 4))*time.Second, 10*time.Second)
}

type sseEvent struct {
	id, event, data string
}

// readSSE gọi fn cho từng sự kiện. Dòng chú thích (": ping" của hub) chỉ để giữ kết nối nên bỏ qua.
func readSSE(r io.Reader, fn func(sseEvent) error) error {
	sc := bufio.NewScanner(r)
	// Một sự kiện log là một đoạn base64; để dư so với khung lớn nhất hub gửi.
	sc.Buffer(make([]byte, 64<<10), 8<<20)
	var ev sseEvent
	var data []string
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			if data != nil {
				ev.data = strings.Join(data, "\n")
				if err := fn(ev); err != nil {
					return err
				}
			}
			ev, data = sseEvent{}, nil
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, value, _ := strings.Cut(line, ":")
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "id":
			ev.id = value
		case "event":
			ev.event = value
		case "data":
			data = append(data, value)
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	return io.ErrUnexpectedEOF
}

// openStream mở luồng SSE. Client riêng không đặt Timeout: Timeout của http.Client tính cả lúc đọc body nên sẽ cắt
// luồng sau 30 giây dù hub vẫn gửi.
func (c *hubClient) openStream(ctx context.Context, path, lastID string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/api"+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("accept", "text/event-stream")
	req.Header.Set("authorization", "Bearer "+c.token)
	if m := patOrg.FindStringSubmatch(c.token); m != nil {
		req.Header.Set("x-hive-org", m[1])
	}
	if lastID != "" {
		req.Header.Set("last-event-id", lastID)
	}
	streaming := *c.http
	streaming.Timeout = 0
	res, err := streaming.Do(req)
	if err != nil {
		return nil, fmt.Errorf("không gọi được hub %s: %w", c.base, err)
	}
	if res.StatusCode/100 == 2 {
		return res.Body, nil
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized {
		return nil, errUnauthorized
	}
	var e struct {
		Message string `json:"message"`
	}
	_ = json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&e)
	return nil, &hubError{Status: res.StatusCode, Message: e.Message}
}

// errRunEnded: hub gửi `end`; thoát vòng nối lại.
var errRunEnded = errors.New("run đã kết thúc")

// runWatch giữ trạng thái giữa các lần nối lại.
type runWatch struct {
	a      *app
	lastID string
	final  string
	// steers nhớ nội dung chỉ dẫn theo id sự kiện `steer` để dòng kết quả nói rõ chỉ dẫn nào.
	steers map[string]string
	mu     sync.Mutex
}

func (w *runWatch) handle(ev sseEvent) error {
	if ev.id != "" {
		w.lastID = ev.id
	}
	switch ev.event {
	case "log":
		var chunk struct {
			Bytes string `json:"bytes"`
		}
		if json.Unmarshal([]byte(ev.data), &chunk) != nil {
			return nil
		}
		if b, err := base64.StdEncoding.DecodeString(chunk.Bytes); err == nil {
			w.mu.Lock()
			_, _ = w.a.stdout.Write(b)
			w.mu.Unlock()
		}
	case "run_event":
		var e runEvent
		if json.Unmarshal([]byte(ev.data), &e) == nil {
			w.event(e)
		}
	case "end":
		var end struct {
			State *string `json:"state"`
		}
		_ = json.Unmarshal([]byte(ev.data), &end)
		w.final = deref(end.State, "không rõ")
		return errRunEnded
	}
	return nil
}

func (w *runWatch) event(e runEvent) {
	switch e.Type {
	case "steer":
		var d struct {
			Input string `json:"input"`
		}
		if json.Unmarshal(e.Data, &d) == nil {
			w.steers[e.ID.String()] = d.Input
		}
	case "steer_result":
		var d struct {
			SteerID string `json:"steerId"`
			Applied bool   `json:"applied"`
			Reason  string `json:"reason"`
		}
		if json.Unmarshal(e.Data, &d) != nil {
			return
		}
		input := clipLine(w.steers[d.SteerID], 60)
		if d.Applied {
			w.notef("Đã gửi chỉ dẫn (đã nhận): %s", input)
			return
		}
		reason := d.Reason
		if reason == "" {
			reason = "không rõ lý do"
		}
		w.notef("Chỉ dẫn chưa vào agent: %s (%s)", reason, input)
	}
}

// notef in dòng báo của hive xen giữa log; xuống dòng trước vì log của agent có thể đang dở dòng.
func (w *runWatch) notef(format string, args ...any) {
	w.mu.Lock()
	defer w.mu.Unlock()
	fmt.Fprintf(w.a.stderr, "\n[hive] "+format+"\n", args...)
}

func clipLine(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n-1]) + "…"
}

func (a *app) attachRun(c *hubClient, r hubRun, view bool) int {
	where := ""
	if r.MachineName != nil && *r.MachineName != "" {
		where = ", máy " + *r.MachineName
	}
	hint := "Gõ chỉ dẫn rồi Enter để gửi cho agent; Ctrl-C để thôi xem."
	if view {
		hint = "Chỉ xem; Ctrl-C để thôi xem."
	}
	fmt.Fprintf(a.stderr, "hive: đang xem run %s (%s%s). %s\n", r.ID, r.State, where, hint)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w := &runWatch{a: a, steers: map[string]string{}}
	if !view {
		go a.steerLoop(ctx, c, r.ID, w)
	}
	done := make(chan int, 1)
	go func() { done <- a.watchRun(ctx, c, r.ID, w) }()
	_, quit, stop := a.signals()
	defer stop()
	select {
	case code := <-done:
		return code
	case <-quit:
		cancel()
		return exitOK
	}
}

// watchRun đọc luồng tới khi có `end`; mất mạng thì nối lại từ sự kiện cuối đã in.
func (a *app) watchRun(ctx context.Context, c *hubClient, id string, w *runWatch) int {
	for try := 0; ; try++ {
		body, err := c.openStream(ctx, "/v1/runs/"+id+"/stream", w.lastID)
		if err == nil {
			try = 0
			err = readSSE(body, w.handle)
			_ = body.Close()
		}
		if errors.Is(err, errRunEnded) {
			fmt.Fprintf(a.stderr, "\nhive: run kết thúc: %s.\n", w.final)
			return exitOK
		}
		if ctx.Err() != nil {
			return exitOK
		}
		switch {
		case hidden(err):
			return a.errorf(exitFailed, msgNotFound)
		case errors.Is(err, errUnauthorized):
			return a.hubFail(err)
		}
		w.notef("Mất kết nối tới hub, đang nối lại…")
		select {
		case <-time.After(reconnectWait(try)):
		case <-ctx.Done():
			return exitOK
		}
	}
}

// steerLoop gửi mỗi dòng gõ vào thành một chỉ dẫn (runs.steer, như ô Steer trên web). Hết stdin thì chỉ thôi gửi, vẫn
// xem tiếp.
func (a *app) steerLoop(ctx context.Context, c *hubClient, id string, w *runWatch) {
	sc := bufio.NewScanner(a.stdin)
	for sc.Scan() {
		if ctx.Err() != nil {
			return
		}
		input := strings.TrimSpace(sc.Text())
		if input == "" {
			continue
		}
		body, _ := json.Marshal(map[string]string{"input": input})
		var res struct {
			Status string `json:"status"`
		}
		if err := c.do(http.MethodPost, "/v1/runs/"+id+"/steer", bytes.NewReader(body), &res); err != nil {
			w.notef("Không gửi được chỉ dẫn: %v", err)
			continue
		}
		switch res.Status {
		case "sent":
			w.notef("Đã gửi chỉ dẫn tới máy, chờ agent nhận.")
		case "pending":
			w.notef("Run chưa tới máy; chỉ dẫn sẽ vào lời nhắc khi giao.")
		case "closing":
			w.notef("Run đang kiểm kết quả hoặc đã xong, không nhận chỉ dẫn nữa.")
		default:
			w.notef("Hub nhận chỉ dẫn (%s).", res.Status)
		}
	}
}
