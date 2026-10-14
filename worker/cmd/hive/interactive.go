package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
)

const (
	modeControl = "control"
	modeView    = "view"
)

// escKey là Ctrl-]: như telnet, ít CLI dùng nên làm phím tiền tố cho lệnh của hive mà không chặn phím của agent.
const escKey = 0x1d

// noEscape: --escape none, mọi phím tới phiên; tách bằng cách đóng terminal.
const noEscape = 0

// parseEscape đọc --escape: ctrl-<phím>, ^<phím> hoặc none. Chỉ nhận phím Ctrl vì phím thường làm tiền tố thì gõ chữ đó
// cũng thành lệnh của hive.
func parseEscape(v string) (byte, error) {
	s := strings.ToLower(strings.TrimSpace(v))
	if s == "none" {
		return noEscape, nil
	}
	k, ok := strings.CutPrefix(s, "ctrl-")
	if !ok {
		k, ok = strings.CutPrefix(s, "ctrl+")
	}
	if !ok {
		k, ok = strings.CutPrefix(s, "^")
	}
	if !ok || len(k) != 1 {
		return 0, fmt.Errorf("--escape %q không hợp lệ; dùng dạng ctrl-], ctrl-a hoặc none", v)
	}
	c := k[0]
	if c >= 'a' && c <= 'z' {
		c -= 'a' - 'A'
	}
	if c < '@' || c > '_' {
		return 0, fmt.Errorf("--escape %q không hợp lệ; dùng dạng ctrl-], ctrl-a hoặc none", v)
	}
	switch c {
	// Esc (Ctrl-[) mở đầu phím mũi tên và Alt; Tab, Enter, Backspace là phím gõ thường ngày.
	case '[', 'I', 'J', 'M', 'H':
		return 0, fmt.Errorf("--escape %s trùng phím Esc/Tab/Enter/Backspace mà agent cần; chọn phím Ctrl khác", v)
	}
	return c - '@', nil
}

// escName là tên phím để in hướng dẫn, như "Ctrl-]".
func escName(key byte) string { return "Ctrl-" + string(rune(key+'@')) }

// escHint là dòng hướng dẫn các lệnh trong phiên theo phím tiền tố đang dùng.
func escHint(key byte, take bool) string {
	if key == noEscape {
		return "Đóng terminal để tách."
	}
	if take {
		return fmt.Sprintf("%[1]s t để giành quyền, %[1]s d để tách.", escName(key))
	}
	return escName(key) + " d để tách."
}

const (
	actDetach = 'd'
	actTake   = 't'
)

// escaper tách lệnh <phím tiền tố> <phím> khỏi luồng phím; giữ trạng thái giữa hai lần đọc vì hai phím có thể tới
// riêng. key noEscape là không tách gì.
type escaper struct {
	key     byte
	pending bool
}

// feed trả phím gửi cho phiên và lệnh của hive. Sau lệnh tách thì bỏ phần còn lại.
func (e *escaper) feed(p []byte) (out []byte, acts []byte) {
	if e.key == noEscape {
		return p, nil
	}
	for _, b := range p {
		if !e.pending {
			if b == e.key {
				e.pending = true
				continue
			}
			out = append(out, b)
			continue
		}
		e.pending = false
		switch b {
		case 'd', 'D':
			return out, append(acts, actDetach)
		case 't', 'T':
			acts = append(acts, actTake)
		case e.key:
			out = append(out, e.key)
		default:
			// Không phải lệnh: gửi cả hai phím như người dùng gõ.
			out = append(out, e.key, b)
		}
	}
	return out, acts
}

type outcome struct {
	code int
	msg  string
}

// interact nối terminal của người dùng với phiên tới khi tách, phiên kết thúc hay mất kết nối. Terminal luôn được trả
// về chế độ cũ trước khi in thông báo cuối.
func (a *app) interact(c *localipc.Conn, id, mode string, esc byte) int {
	restore := func() {}
	if a.console.IsTerminal() {
		r, err := a.console.MakeRaw()
		if err != nil {
			return a.errorf(exitFailed, "Không đặt được terminal ở chế độ raw: %v. Phiên %s vẫn chạy.", err, id)
		}
		restore = r
	}
	code, msg := a.pump(c, id, mode, esc)
	restore()
	if msg != "" {
		fmt.Fprintf(a.stderr, "\nhive: %s\n", msg)
	}
	return code
}

func (a *app) pump(c *localipc.Conn, id, mode string, esc byte) (int, string) {
	resize, quit, stopSignals := a.signals()
	defer stopSignals()
	var control atomic.Bool
	control.Store(mode == modeControl)
	done := make(chan outcome, 3)
	detached := outcome{exitOK, fmt.Sprintf("Đã tách khỏi phiên %s; phiên vẫn chạy. Gắn lại: hive attach %s", id, id)}
	// Worker đóng kết nối ngay khi nhận lệnh tách, nên goroutine đọc có thể thấy lỗi trước khi goroutine gõ kịp báo
	// "đã tách". Đặt cờ trước khi gửi lệnh để lỗi do chính ta gây ra không bị coi là mất kết nối.
	var detaching atomic.Bool
	detach := func() {
		detaching.Store(true)
		_ = c.WriteCtl(localipc.Ctl{Type: localipc.CtlDetach})
		done <- detached
	}

	go func() {
		for {
			typ, data, err := c.ReadFrame()
			if err != nil {
				if !detaching.Load() {
					done <- outcome{exitFailed, "Mất kết nối tới hive-worker; phiên có thể vẫn chạy (hive ls)."}
				}
				return
			}
			switch typ {
			case localipc.FrameOut:
				_, _ = a.stdout.Write(data)
			case localipc.FrameCtl:
				var ctl localipc.Ctl
				if json.Unmarshal(data, &ctl) != nil {
					continue
				}
				switch ctl.Type {
				case localipc.CtlControl:
					control.Store(true)
				case localipc.CtlTaken:
					control.Store(false)
					// Terminal đang raw: \r\n để dòng báo không lệch cột.
					fmt.Fprintf(a.stderr, "\r\n[hive] %s %s\r\n", ctl.Message, escHint(esc, true))
				case localipc.CtlExit:
					done <- exitOutcome(ctl)
					return
				}
			}
		}
	}()

	go func() {
		e := escaper{key: esc}
		buf := make([]byte, 4096)
		for {
			n, err := a.stdin.Read(buf)
			if n > 0 {
				out, acts := e.feed(buf[:n])
				if len(out) > 0 && control.Load() {
					if c.WriteFrame(localipc.FrameIn, out) != nil {
						return
					}
				}
				for _, act := range acts {
					switch act {
					case actDetach:
						detach()
						return
					case actTake:
						_ = c.WriteCtl(localipc.Ctl{Type: localipc.CtlTake})
					}
				}
			}
			if err != nil {
				// Hết stdin (đóng pipe, terminal mất): tách, phiên chạy tiếp.
				detach()
				return
			}
		}
	}()

	a.sendSize(c)
	for {
		select {
		case <-resize:
			a.sendSize(c)
		case <-quit:
			_ = c.WriteCtl(localipc.Ctl{Type: localipc.CtlDetach})
			return detached.code, detached.msg
		case o := <-done:
			return o.code, o.msg
		}
	}
}

func (a *app) sendSize(c *localipc.Conn) {
	cols, rows, ok := a.console.Size()
	if !ok {
		return
	}
	b, _ := json.Marshal(localipc.Size{Cols: cols, Rows: rows})
	_ = c.WriteFrame(localipc.FrameResize, b)
}

func exitOutcome(ctl localipc.Ctl) outcome {
	switch ctl.Reason {
	case "exit":
		if ctl.Code != nil && *ctl.Code != 0 {
			return outcome{exitFailed, fmt.Sprintf("Agent thoát với mã %d.", *ctl.Code)}
		}
		return outcome{exitOK, ""}
	case "killed":
		return outcome{exitFailed, "Phiên đã bị ngắt."}
	}
	msg := ctl.Message
	if msg == "" {
		msg = "Phiên đã đóng."
	}
	return outcome{exitFailed, msg}
}
