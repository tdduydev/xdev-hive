package main

import (
	"encoding/json"
	"net"
	"strings"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
)

// Worker đóng kết nối ngay khi nhận lệnh tách. Tách do chính client yêu cầu không được báo thành mất kết nối, dù
// goroutine đọc thấy kết nối đóng trước khi goroutine gõ kịp báo kết quả.
func TestPumpDetachIgnoresCloseItCaused(t *testing.T) {
	for i := 0; i < 500; i++ {
		clientEnd, serverEnd := net.Pipe()
		go func() {
			srv := localipc.NewConn(serverEnd)
			defer srv.Close()
			for {
				typ, data, err := srv.ReadFrame()
				if err != nil {
					return
				}
				var ctl localipc.Ctl
				if typ == localipc.FrameCtl && json.Unmarshal(data, &ctl) == nil && ctl.Type == localipc.CtlDetach {
					return
				}
			}
		}()

		a := newTestApp("", strings.NewReader("")) // hết stdin ngay: tách
		code, msg := a.pump(localipc.NewConn(clientEnd), "abcd", modeControl, escKey)
		_ = clientEnd.Close()
		if code != exitOK || strings.Contains(msg, "Mất kết nối") {
			t.Fatalf("lần %d: tách phải thoát %d, được %d %q", i, exitOK, code, msg)
		}
	}
}
