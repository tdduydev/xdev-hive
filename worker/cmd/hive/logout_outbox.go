package main

import (
	"bufio"
	"errors"
	"fmt"
	"strings"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/version"
)

// Đăng xuất khi hộp thư đi còn mục (specs/027 T025): token sắp bị xoá thì mục chờ gửi không đi được nữa, nên hỏi
// người dùng gửi trước bằng token còn đó, giữ lại cho lần đăng nhập sau, hay bỏ.

const logoutUsage = "Cách dùng: hive logout [--outbox send|keep|drop]."

// logoutSendWaitMs là thời gian chờ hub nhận các mục khi chọn Gửi trước; quá hạn thì mục còn lại được giữ.
const logoutSendWaitMs = 30000

type logoutCounts struct {
	Pending int `json:"pending"`
	Held    int `json:"held"`
	Dropped int `json:"dropped"`
}

func validLogoutChoice(s string) bool { return s == "" || s == "send" || s == "keep" || s == "drop" }

// logoutOutbox chạy trước khi xoá token. Worker không chạy (hay bản cũ chưa có op) thì không hỏi: mục nằm trên đĩa và
// worker giữ lại khi thấy máy chưa đăng nhập, không mất gì.
func (a *app) logoutOutbox(hub, choice string) int {
	path, err := a.socket()
	if err != nil {
		return exitOK
	}
	c, _, err := localipc.Dial(path, "hive/"+version.Version)
	if errors.Is(err, localipc.ErrNotRunning) {
		return exitOK
	}
	if err != nil {
		return a.fail(err)
	}
	defer c.Close()
	var n logoutCounts
	if err := c.Call(map[string]any{"op": "outbox.logout", "hubUrl": hub, "action": "count"}, &n); err != nil {
		var re *localipc.RemoteError
		if errors.As(err, &re) && re.Code == localipc.CodeUnsupported {
			return exitOK
		}
		return a.fail(err)
	}
	if n.Pending+n.Held == 0 {
		return exitOK
	}
	if choice == "" {
		if !a.console.IsTerminal() {
			// App và script không trả lời được câu hỏi: giữ lại là lựa chọn không làm mất gì.
			fmt.Fprintf(a.stderr, "hive: hộp thư đi còn %d mục chưa tới hub; giữ lại tới khi đăng nhập lại (chọn bằng --outbox send|keep|drop).\n", n.Pending+n.Held)
			choice = "keep"
		} else {
			var code int
			if choice, code = a.askLogoutChoice(hub, n); code != exitOK {
				return code
			}
		}
	}
	var out logoutCounts
	if err := c.Call(map[string]any{"op": "outbox.logout", "hubUrl": hub, "action": choice, "waitMs": logoutSendWaitMs}, &out); err != nil {
		var re *localipc.RemoteError
		if errors.As(err, &re) && re.Code == "UNKNOWN_IDENTITY" {
			return a.errorf(exitFailed, "%s Chưa đăng xuất; chạy lại với --outbox keep.", re.Message)
		}
		return a.fail(err)
	}
	switch {
	case choice == "drop":
		fmt.Fprintf(a.stdout, "Đã bỏ %d mục trong hộp thư đi.\n", out.Dropped)
	case choice == "send" && out.Held == 0:
		fmt.Fprintln(a.stdout, "Hub đã nhận hết các mục trong hộp thư đi.")
	default:
		fmt.Fprintf(a.stdout, "Giữ %d mục trên máy; gửi khi bạn đăng nhập lại %s.\n", out.Held, hub)
	}
	return exitOK
}

func (a *app) askLogoutChoice(hub string, n logoutCounts) (string, int) {
	fmt.Fprintf(a.stdout, "Hộp thư đi còn %d mục chưa tới %s (chờ gửi %d, đang giữ %d).\n", n.Pending+n.Held, hub, n.Pending, n.Held)
	fmt.Fprintln(a.stdout, "  1. Gửi trước: gửi ngay bằng token hiện tại rồi đăng xuất")
	fmt.Fprintln(a.stdout, "  2. Giữ lại: để trên máy, gửi khi bạn đăng nhập lại")
	fmt.Fprintln(a.stdout, "  3. Bỏ: xoá các mục này")
	fmt.Fprint(a.stdout, "Chọn [1/2/3, mặc định 2]: ")
	line, _ := bufio.NewReader(a.stdin).ReadString('\n')
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "1", "g", "gửi", "gui", "send":
		return "send", exitOK
	case "", "2", "k", "giữ", "giu", "keep":
		return "keep", exitOK
	case "3", "b", "bỏ", "bo", "drop":
		return "drop", exitOK
	}
	return "", a.errorf(exitUsage, "Không rõ lựa chọn; chưa đăng xuất.")
}
