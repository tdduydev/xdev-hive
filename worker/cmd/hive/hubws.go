package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Xem phiên trên máy khác qua /ws/terminal của hub (US6): CLI chưa phải thiết bị đã ghép nên không bao giờ xin quyền
// điều khiển, phím gõ bị bỏ tại máy này thay vì gửi lên rồi để hub từ chối.

// Mã đóng của hub (contracts TERMINAL_WS_CLOSE).
const (
	wsUnauthorized websocket.StatusCode = 4401
	wsForbidden    websocket.StatusCode = 4403
	wsNotFound     websocket.StatusCode = 4404
	wsRateLimited  websocket.StatusCode = 4429
)

const msgViewOnly = "Chỉ xem: phiên ở máy khác"

// viewOnlyEvery: gõ liên tục chỉ nhắc một lần trong khoảng này, để dòng nhắc không lấp màn hình agent.
var viewOnlyEvery = 3 * time.Second

func activeRemote(state string) bool { return state == "opening" || state == "running" }

// wsURL đổi địa chỉ hub sang ws(s) và trả Origin hub chấp nhận (cùng scheme và host với địa chỉ công khai).
func wsURL(base, ticket string) (string, string, error) {
	u, err := url.Parse(base)
	if err != nil {
		return "", "", err
	}
	origin := u.Scheme + "://" + u.Host
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/ws/terminal"
	u.RawQuery = url.Values{"ticket": {ticket}}.Encode()
	return u.String(), origin, nil
}

type remoteFrame struct {
	T       string         `json:"t"`
	Seq     int64          `json:"seq"`
	Data    string         `json:"data"`
	After   int64          `json:"after"`
	Session *remoteSession `json:"session"`
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Reason  string         `json:"reason"`
}

func (a *app) attachRemote(c *hubClient, s remoteSession, esc byte) int {
	if !activeRemote(s.State) {
		return a.errorf(exitFailed, "Phiên %s đã đóng; xem bản ghi trên web.", s.ID)
	}
	if strings.HasPrefix(c.base, "http://") {
		fmt.Fprintln(a.stderr, "hive: Hub chạy HTTP: nội dung phiên và phím gõ không được mã hoá trên đường truyền.")
	}
	fmt.Fprintf(a.stderr, "hive: đang xem phiên %s trên máy %s (chỉ xem). %s\n", s.ID, s.MachineName, escHint(esc, true))
	restore := func() {}
	if a.console.IsTerminal() {
		r, err := a.console.MakeRaw()
		if err != nil {
			return a.errorf(exitFailed, "Không đặt được terminal ở chế độ raw: %v.", err)
		}
		restore = r
	}
	ctx, cancel := context.WithCancel(context.Background())
	v := &remoteView{a: a, c: c, id: s.ID, after: -1}
	done := make(chan outcome, 2)
	go func() {
		if o, ok := v.keys(esc); ok {
			done <- o
		}
	}()
	go func() { done <- v.watch(ctx) }()
	_, quit, stop := a.signals()
	var o outcome
	select {
	case o = <-done:
	case <-quit:
		o = outcome{exitOK, ""}
	}
	stop()
	cancel()
	restore()
	if o.msg != "" {
		fmt.Fprintf(a.stderr, "\nhive: %s\n", o.msg)
	}
	return o.code
}

type remoteView struct {
	a  *app
	c  *hubClient
	id string
	// after: seq cuối đã in; nối lại thì xin hub phát tiếp từ đây để không in lặp.
	after int64
	mu    sync.Mutex
}

func (v *remoteView) write(p []byte) {
	v.mu.Lock()
	_, _ = v.a.stdout.Write(p)
	v.mu.Unlock()
}

func (v *remoteView) note(msg string) {
	v.mu.Lock()
	// Terminal đang raw: \r\n để dòng báo không lệch cột.
	fmt.Fprintf(v.a.stderr, "\r\n[hive] %s\r\n", msg)
	v.mu.Unlock()
}

// keys đọc phím chỉ để bắt lệnh tách; mọi phím khác bị bỏ. Hết stdin (chạy trong pipe) không phải là muốn thôi xem nên
// trả ok=false để chờ phiên kết thúc.
func (v *remoteView) keys(esc byte) (outcome, bool) {
	left := outcome{exitOK, fmt.Sprintf("Đã thôi xem phiên %s; phiên vẫn chạy trên máy kia.", v.id)}
	e := escaper{key: esc}
	buf := make([]byte, 1024)
	var noted time.Time
	for {
		n, err := v.a.stdin.Read(buf)
		if n > 0 {
			out, acts := e.feed(buf[:n])
			if len(acts) > 0 && acts[0] == actDetach {
				return left, true
			}
			// Terminal raw không tự đổi Ctrl-C thành tín hiệu; không gõ được vào phiên thì Ctrl-C nên là thoát.
			if bytes.IndexByte(out, 0x03) >= 0 {
				return left, true
			}
			if (len(out) > 0 || len(acts) > 0) && time.Since(noted) >= viewOnlyEvery {
				noted = time.Now()
				v.note(msgViewOnly)
			}
		}
		if err != nil {
			return outcome{}, false
		}
	}
}

// watch nối WebSocket, nối lại bằng vé mới khi mất mạng hay vé hết hạn, tới khi phiên kết thúc.
func (v *remoteView) watch(ctx context.Context) outcome {
	for try := 0; ; try++ {
		o, retry := v.once(ctx, &try)
		if !retry {
			return o
		}
		if ctx.Err() != nil {
			return outcome{exitOK, ""}
		}
		v.note("Mất kết nối tới hub, đang nối lại…")
		select {
		case <-time.After(reconnectWait(try)):
		case <-ctx.Done():
			return outcome{exitOK, ""}
		}
	}
}

func (v *remoteView) once(ctx context.Context, try *int) (outcome, bool) {
	var t struct {
		Ticket string `json:"ticket"`
	}
	if err := v.c.do(http.MethodPost, "/v1/remote/sessions/"+v.id+"/ticket", strings.NewReader("{}"), &t); err != nil {
		var he *hubError
		switch {
		case hidden(err):
			return outcome{exitFailed, msgNotFound}, false
		case errors.Is(err, errUnauthorized):
			return outcome{exitUsage, "Token hết hạn hoặc đã bị thu hồi. Chạy hive login."}, false
		case errors.As(err, &he) && he.Status/100 == 4 && he.Status != http.StatusTooManyRequests:
			return outcome{exitFailed, he.Error()}, false
		}
		return outcome{}, true
	}
	u, origin, err := wsURL(v.c.base, t.Ticket)
	if err != nil {
		return outcome{exitFailed, err.Error()}, false
	}
	ws, _, err := websocket.Dial(ctx, u, &websocket.DialOptions{
		HTTPClient: v.c.http,
		HTTPHeader: http.Header{"Origin": {origin}},
	})
	if err != nil {
		return outcome{}, true
	}
	defer ws.CloseNow()
	ws.SetReadLimit(4 << 20)
	resume, _ := json.Marshal(map[string]any{"t": "resume", "after": v.after})
	if err := ws.Write(ctx, websocket.MessageText, resume); err != nil {
		return outcome{}, true
	}
	for {
		_, data, err := ws.Read(ctx)
		if err != nil {
			return v.closed(err)
		}
		*try = 0
		var f remoteFrame
		if json.Unmarshal(data, &f) != nil {
			continue
		}
		switch f.T {
		case "out":
			if f.Seq <= v.after {
				continue
			}
			if b, err := base64.StdEncoding.DecodeString(f.Data); err == nil {
				v.write(b)
				v.after = f.Seq
			}
		case "sync":
			// Hub sắp phát lại từ `after`: xoá màn hình để không vẽ chồng lên đoạn cũ.
			v.write([]byte("\x1b[H\x1b[2J"))
			v.after = f.After
		case "state", "hello":
			if f.Session != nil && !activeRemote(f.Session.State) {
				return outcome{exitOK, "Phiên đã kết thúc."}, false
			}
		case "error":
			v.note(f.Message)
		}
	}
}

// closed đổi mã đóng của hub thành kết quả; vé hết hạn, hub khởi động lại hay mất mạng thì nối lại.
func (v *remoteView) closed(err error) (outcome, bool) {
	switch websocket.CloseStatus(err) {
	case wsNotFound:
		return outcome{exitOK, "Phiên đã kết thúc."}, false
	case wsForbidden:
		return outcome{exitDenied, "Hub không cho xem phiên này nữa."}, false
	case wsRateLimited:
		return outcome{exitFailed, "Phiên đã đủ người xem; thử lại sau."}, false
	case wsUnauthorized:
		return outcome{}, true
	}
	return outcome{}, true
}
