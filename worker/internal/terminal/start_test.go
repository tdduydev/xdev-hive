//go:build !windows

package terminal

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/remoteauth"
)

// startEnv là newCtlEnv (đã có một phiên tại máy) cộng một thư mục được phép `repo` có `apps/web`.
func startEnv(t *testing.T, tune func(*Controller), conf func(*remoteauth.Config)) *ctlEnv {
	t.Helper()
	e := newCtlEnv(t, tune)
	root := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(filepath.Join(root, "apps", "web"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := e.rem.Store.Update(func(c *remoteauth.Config) error {
		c.Roots = []remoteauth.Root{{ID: "r1", Label: "repo", Path: root}}
		if conf != nil {
			conf(c)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return e
}

// startReq là term_start ký bằng mã TOTP của bước kế tiếp (như ctlEnv.request).
func (e *ctlEnv) startReq(id string, edit func(*StartRequest)) StartRequest {
	e.t.Helper()
	e.mu.Lock()
	e.now = e.now.Add(remoteauth.TOTPPeriod * time.Second)
	now := e.now
	e.mu.Unlock()
	priv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		e.t.Fatal(err)
	}
	n := make([]byte, 16)
	_, _ = rand.Read(n)
	req := StartRequest{RequestID: id, UserID: "u1", DeviceID: "totp", CLI: "claude", RootID: "r1", Subdir: "apps/web",
		Model: "opus", Permissions: PermWorkspace, Prompt: "-sửa lỗi", Cols: 90, Rows: 30,
		Auth: Auth{Kind: remoteauth.KindTOTP, Code: remoteauth.TOTPCode(ctlSecret, now.Unix()/remoteauth.TOTPPeriod),
			EphPub: base64.RawURLEncoding.EncodeToString(priv.PublicKey().Bytes()), TS: now.Unix(),
			Nonce: base64.RawURLEncoding.EncodeToString(n)}}
	if edit != nil {
		edit(&req)
	}
	return req
}

func (e *ctlEnv) waitOpened(requestID string) Opened {
	e.t.Helper()
	var got Opened
	waitRec(e.t, "term_opened cho "+requestID, func() bool {
		ok := false
		e.link.snapshot(func(f *fakeLink) {
			for _, o := range f.opened {
				if o.RequestID == requestID {
					got, ok = o, true
				}
			}
		})
		return ok
	})
	return got
}

func (e *ctlEnv) waitDenied(requestID, code string) {
	e.t.Helper()
	waitRec(e.t, "term_denied "+code+" cho "+requestID, func() bool {
		ok := false
		e.link.snapshot(func(f *fakeLink) {
			for _, d := range f.denied {
				if d.RequestID == requestID {
					if d.Code != code || d.Reason == "" {
						e.t.Errorf("denied = %+v, muốn mã %s", d, code)
					}
					ok = true
				}
			}
		})
		return ok
	})
}

func (e *ctlEnv) openedCount() int {
	n := 0
	e.link.snapshot(func(f *fakeLink) { n = len(f.opened) })
	return n
}

func (e *ctlEnv) auditLog() string {
	b, _ := os.ReadFile(e.rem.Audit.Path)
	return string(b)
}

// US3 kịch bản 1 (T050): term_start hợp lệ mở CLI trong thư mục con, đối số do máy dựng, term_opened kèm requestId.
func TestStartOpensRemoteSession(t *testing.T) {
	e := startEnv(t, nil, nil)
	e.ctl.Start(e.startReq("req-1", nil))
	o := e.waitOpened("req-1")
	if o.Origin != OriginRemote || o.CLI != "claude" || o.CwdLabel != "repo/apps/web" || o.Permissions != PermWorkspace ||
		o.Remote == nil || !*o.Remote {
		t.Fatalf("opened = %+v", o)
	}
	waitRec(t, "đối số của CLI", func() bool {
		return strings.Contains(e.link.joined(o.SessionID), "READY --model opus --permission-mode acceptEdits -- -sửa lỗi")
	})
	var cwd string
	for _, s := range e.ctl.Local.List() {
		if s.HubID == o.SessionID {
			cwd = s.Cwd
		}
	}
	if !strings.HasSuffix(filepath.ToSlash(cwd), "repo/apps/web") {
		t.Fatalf("cwd = %q", cwd)
	}
	if log := e.auditLog(); !strings.Contains(log, `"action":"start"`) || !strings.Contains(log, `"requestId":"req-1"`) {
		t.Fatalf("audit = %s", log)
	}
}

// FR-020: hub đòi toàn quyền mà chủ máy chưa bật tại máy thì hạ về workspace; bật rồi mới chạy toàn quyền.
func TestStartFullAccessNeedsMachineOptIn(t *testing.T) {
	e := startEnv(t, nil, nil)
	full := func(r *StartRequest) {
		r.Permissions, r.Model, r.Prompt = PermFull, "--dangerously-skip-permissions", ""
	}
	e.ctl.Start(e.startReq("req-ha", full))
	o := e.waitOpened("req-ha")
	if o.Permissions != PermWorkspace {
		t.Fatalf("permissions = %q, muốn workspace", o.Permissions)
	}
	waitRec(t, "đối số workspace, bỏ model lạ", func() bool {
		out := e.link.joined(o.SessionID)
		return strings.Contains(out, "READY --permission-mode acceptEdits") && !strings.Contains(out, "dangerously")
	})

	if _, err := e.rem.Store.Update(func(c *remoteauth.Config) error { c.AllowFullAccess = true; return nil }); err != nil {
		t.Fatal(err)
	}
	e.ctl.Start(e.startReq("req-full", full))
	o = e.waitOpened("req-full")
	if o.Permissions != PermFull {
		t.Fatalf("permissions = %q, muốn full", o.Permissions)
	}
	waitRec(t, "đối số toàn quyền", func() bool {
		return strings.Contains(e.link.joined(o.SessionID), "READY --permission-mode bypassPermissions")
	})
}

func TestStartDenied(t *testing.T) {
	cases := []struct {
		name string
		conf func(*remoteauth.Config)
		edit func(*StartRequest)
		code string
	}{
		{"chữ ký sai", nil, func(r *StartRequest) { r.Auth.Code = "000000" }, remoteauth.CodeTOTPInvalid},
		{"CLI máy không có", nil, func(r *StartRequest) { r.CLI = "gemini" }, codeCLIMissing},
		{"CLI lạ", nil, func(r *StartRequest) { r.CLI = "bash" }, codeCLIMissing},
		{"root lạ", nil, func(r *StartRequest) { r.RootID = "r9" }, codeRootMissing},
		{"đi ngược ra ngoài", nil, func(r *StartRequest) { r.Subdir = "../.ssh" }, codeRootEscape},
		{"đường tuyệt đối", nil, func(r *StartRequest) { r.Subdir = "/etc" }, codeRootEscape},
		{"thư mục con không có", nil, func(r *StartRequest) { r.Subdir = "khong-co" }, codeRootMissing},
		{"tắt từ xa", func(c *remoteauth.Config) { c.Enabled = false }, nil, codeRemoteDisabled},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := startEnv(t, nil, c.conf)
			before := e.openedCount()
			e.ctl.Start(e.startReq("req-x", c.edit))
			e.waitDenied("req-x", c.code)
			if e.openedCount() != before {
				t.Fatal("bị từ chối thì không được mở phiên")
			}
			if c.conf == nil && !strings.Contains(e.auditLog(), `"action":"start_denied"`) {
				t.Fatalf("audit thiếu start_denied: %s", e.auditLog())
			}
		})
	}
}

func TestStartBusy(t *testing.T) {
	e := startEnv(t, func(c *Controller) { c.Local.MaxSessions = 1 }, nil)
	e.ctl.Start(e.startReq("req-busy", nil))
	e.waitDenied("req-busy", codeBusy)
}

// FR-018: bật "Hỏi tại máy" thì phiên chỉ mở khi người ở máy bấm Cho phép; từ chối hay hết giờ trả mã riêng.
func TestStartConfirmOnMachine(t *testing.T) {
	e := startEnv(t, func(c *Controller) { c.Remote.ConfirmWait = 300 * time.Millisecond },
		func(c *remoteauth.Config) { c.ConfirmOnMachine = true })
	pending := func(id string) watchEvent {
		var ev watchEvent
		waitRec(t, "start_request "+id, func() bool {
			e.rem.mu.Lock()
			defer e.rem.mu.Unlock()
			d, ok := e.rem.decisions[id]
			if ok {
				ev = d.ev
			}
			return ok
		})
		return ev
	}

	e.ctl.Start(e.startReq("req-ok", nil))
	ev := pending("req-ok")
	if ev.Event != eventStartRequest || ev.CLI != "claude" || ev.Cwd != "repo/apps/web" || ev.UserID != "u1" {
		t.Fatalf("start_request = %+v", ev)
	}
	if e.rem.decide("req-ok", eventPairRequest, true) {
		t.Fatal("remote.pair.decide không được trả lời yêu cầu mở phiên")
	}
	if !e.rem.decide("req-ok", eventStartRequest, true) {
		t.Fatal("decide phải nhận yêu cầu đang chờ")
	}
	e.waitOpened("req-ok")

	e.ctl.Start(e.startReq("req-no", nil))
	pending("req-no")
	e.rem.decide("req-no", eventStartRequest, false)
	e.waitDenied("req-no", codeConfirmDenied)

	e.ctl.Start(e.startReq("req-late", nil))
	e.waitDenied("req-late", codeConfirmTimeout)
}
