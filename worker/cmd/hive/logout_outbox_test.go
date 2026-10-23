package main

import (
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/zalando/go-keyring"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
)

const logoutHub = "https://hive.example.vn"

// logoutApp là hive đã đăng nhập logoutHub, nối tới hive-worker giả ở path.
func logoutApp(t *testing.T, path, stdin string, tty bool) *testApp {
	t.Helper()
	a := newTestApp(path, strings.NewReader(stdin))
	a.con.tty = tty
	if _, err := a.saveToken(logoutHub, testToken); err != nil {
		t.Fatal(err)
	}
	return a
}

func (a *testApp) loggedOut(t *testing.T) bool {
	t.Helper()
	_, err := a.keyring.Get(keyringService, logoutHub)
	return errors.Is(err, keyring.ErrNotFound)
}

func TestLogoutAsksAboutOutbox(t *testing.T) {
	path, f := startOutbox(t)
	// actions ghi ở goroutine của worker giả, đọc sau khi lệnh trả lời: khoá để -race không báo.
	var mu sync.Mutex
	var actions []string
	f.setLogout(func(action string) (map[string]any, string) {
		mu.Lock()
		defer mu.Unlock()
		actions = append(actions, action)
		switch action {
		case "count":
			return map[string]any{"pending": 2, "held": 1}, ""
		case "send":
			return map[string]any{"pending": 0, "held": 1}, ""
		case "drop":
			return map[string]any{"pending": 0, "held": 0, "dropped": 3}, ""
		}
		return map[string]any{"pending": 0, "held": 3}, ""
	})
	// take trả các action từ lần gọi trước và xoá danh sách.
	take := func() []string {
		mu.Lock()
		defer mu.Unlock()
		got := actions
		actions = nil
		return got
	}
	for _, tt := range []struct {
		stdin, want, action string
	}{
		{"1\n", "Giữ 1 mục trên máy", "send"},
		{"\n", "Giữ 3 mục trên máy; gửi khi bạn đăng nhập lại " + logoutHub, "keep"},
		{"bỏ\n", "Đã bỏ 3 mục", "drop"},
	} {
		a := logoutApp(t, path, tt.stdin, true)
		if code := a.run([]string{"logout"}); code != exitOK {
			t.Fatalf("%q: mã %d, %q", tt.stdin, code, a.err.String())
		}
		out := a.out.String()
		if !strings.Contains(out, "Hộp thư đi còn 3 mục chưa tới "+logoutHub+" (chờ gửi 2, đang giữ 1)") || !strings.Contains(out, tt.want) {
			t.Fatalf("%q: %s", tt.stdin, out)
		}
		if actions := take(); len(actions) != 2 || actions[1] != tt.action || !a.loggedOut(t) {
			t.Fatalf("%q: action %v, đã đăng xuất %v", tt.stdin, actions, a.loggedOut(t))
		}
		if req := f.last(); req["hubUrl"] != logoutHub || req["waitMs"] != float64(logoutSendWaitMs) {
			t.Fatalf("yêu cầu %v", req)
		}
	}

	// Trả lời lạ thì không đăng xuất.
	a := logoutApp(t, path, "x\n", true)
	if code := a.run([]string{"logout"}); code != exitUsage || a.loggedOut(t) {
		t.Fatalf("trả lời lạ: mã %d, %q", code, a.err.String())
	}
	take()

	// Không có terminal: không hỏi, giữ lại.
	a = logoutApp(t, path, "", false)
	code := a.run([]string{"logout"})
	if actions := take(); code != exitOK || !a.loggedOut(t) || len(actions) != 2 || actions[1] != "keep" {
		t.Fatalf("không terminal: mã %d, %v, %q", code, actions, a.err.String())
	}
	if !strings.Contains(a.err.String(), "--outbox send|keep|drop") {
		t.Fatalf("stderr %q", a.err.String())
	}

	// --outbox chọn sẵn: không hỏi.
	a = logoutApp(t, path, "", true)
	code = a.run([]string{"logout", "--outbox", "drop"})
	if actions := take(); code != exitOK || strings.Contains(a.out.String(), "Chọn [") || len(actions) != 2 || actions[1] != "drop" {
		t.Fatalf("--outbox drop: mã %d, %v, %s", code, actions, a.out.String())
	}
	if code := logoutApp(t, path, "", true).run([]string{"logout", "--outbox", "xoa"}); code != exitUsage {
		t.Fatalf("--outbox lạ: mã %d", code)
	}
}

func TestLogoutOutboxEmptyOrWorkerMissing(t *testing.T) {
	path, f := startOutbox(t)
	a := logoutApp(t, path, "", true)
	if code := a.run([]string{"logout"}); code != exitOK || !a.loggedOut(t) || strings.Contains(a.out.String(), "Hộp thư đi") {
		t.Fatalf("hộp thư trống: mã %d, %s", code, a.out.String())
	}
	if f.last()["action"] != "count" {
		t.Fatalf("yêu cầu %v", f.last())
	}

	// Worker không chạy: vẫn đăng xuất, mục trên đĩa được worker giữ khi chạy lại.
	a = logoutApp(t, filepath.Join(t.TempDir(), "khong-co.sock"), "", true)
	if code := a.run([]string{"logout"}); code != exitOK || !a.loggedOut(t) {
		t.Fatalf("không có worker: mã %d, %q", code, a.err.String())
	}

	// Worker không biết ai đang đăng nhập: không xoá token, chỉ cách giữ lại.
	f.setLogout(func(action string) (map[string]any, string) {
		if action == "count" {
			return map[string]any{"pending": 1, "held": 0}, ""
		}
		return map[string]any{"error": "Không xác định được người đang đăng nhập hub; chọn Giữ lại."}, "UNKNOWN_IDENTITY"
	})
	a = logoutApp(t, path, "", true)
	if code := a.run([]string{"logout", "--outbox", "drop"}); code != exitFailed || a.loggedOut(t) || !strings.Contains(a.err.String(), "--outbox keep") {
		t.Fatalf("không rõ người: mã %d, %q", code, a.err.String())
	}
	f.setLogout(func(string) (map[string]any, string) {
		return map[string]any{"error": "hive-worker này chưa có op outbox.logout"}, localipc.CodeUnsupported
	})
	a = logoutApp(t, path, "", true)
	if code := a.run([]string{"logout"}); code != exitOK || !a.loggedOut(t) {
		t.Fatalf("worker cũ: mã %d, %q", code, a.err.String())
	}
}
