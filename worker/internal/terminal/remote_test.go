package terminal

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/remoteauth"
)

func newRemote(t *testing.T) *Remote {
	t.Helper()
	dir := t.TempDir()
	return &Remote{
		Store:    remoteauth.NewStore(dir),
		Pairings: &remoteauth.Pairings{},
		TOTP:     remoteauth.NewTOTPStore(dir),
		Audit:    &Audit{Path: filepath.Join(dir, "remote-audit.log")},
		HubURL:   "https://hive.example.vn",
		Machine:  "mac-lan",
		CLIs:     []string{"claude", "codex"},
	}
}

// pipe nối Handle qua socket giả trong bộ nhớ (chạy cả trên Windows, không cần socket nội bộ thật).
func pipe(t *testing.T, r *Remote) *localipc.Conn {
	t.Helper()
	a, b := net.Pipe()
	client, server := localipc.NewConn(a), localipc.NewConn(b)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			req, err := server.ReadRequest()
			if err != nil {
				return
			}
			if err := r.Handle(ctx, server, req); err != nil {
				_ = b.Close()
				return
			}
		}
	}()
	t.Cleanup(func() {
		cancel()
		_ = a.Close()
		<-done
	})
	return client
}

type statusReply struct {
	Status RemoteStatus    `json:"status"`
	Root   remoteauth.Root `json:"root"`
	Pair   PairInfo        `json:"pair"`
}

func call(t *testing.T, r *Remote, req map[string]any) (statusReply, error) {
	t.Helper()
	var out statusReply
	err := pipe(t, r).Call(req, &out)
	return out, err
}

func mustCall(t *testing.T, r *Remote, req map[string]any) statusReply {
	t.Helper()
	out, err := call(t, r, req)
	if err != nil {
		t.Fatalf("%v: %v", req["op"], err)
	}
	return out
}

func failCode(t *testing.T, err error) string {
	t.Helper()
	re, ok := err.(*localipc.RemoteError)
	if !ok {
		t.Fatalf("lỗi = %v (%T), cần RemoteError", err, err)
	}
	return re.Code
}

func auditActions(t *testing.T, r *Remote) []string {
	t.Helper()
	data, err := os.ReadFile(r.Audit.Path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	sc := bufio.NewScanner(strings.NewReader(string(data)))
	for sc.Scan() {
		var e AuditEntry
		if err := json.Unmarshal(sc.Bytes(), &e); err != nil {
			t.Fatalf("dòng audit hỏng %q: %v", sc.Text(), err)
		}
		out = append(out, e.Action+"/"+e.By)
	}
	return out
}

func TestRemoteEnableDisable(t *testing.T) {
	r := newRemote(t)
	changes := 0
	r.OnChange(func() { changes++ })
	if st := mustCall(t, r, map[string]any{"op": "remote.status"}).Status; st.Enabled || st.IdleMinutes != 15 || st.MaxHours != 12 {
		t.Fatalf("mặc định = %+v", st)
	}
	if st := mustCall(t, r, map[string]any{"op": "remote.enable"}).Status; !st.Enabled {
		t.Fatal("phải bật")
	}
	mustCall(t, r, map[string]any{"op": "remote.enable"})
	if st := mustCall(t, r, map[string]any{"op": "remote.disable"}).Status; st.Enabled {
		t.Fatal("phải tắt")
	}
	if got := strings.Join(auditActions(t, r), ","); got != "remote_enable/machine,remote_disable/machine" {
		t.Fatalf("audit = %s", got)
	}
	if changes != 2 {
		t.Fatalf("bật lại khi đã bật không được tính là đổi: %d", changes)
	}
}

// Máy dùng chung không bật được; đang bật mà hub báo máy dùng chung thì tắt ngay.
func TestRemoteSharedMachine(t *testing.T) {
	r := newRemote(t)
	mustCall(t, r, map[string]any{"op": "remote.enable"})
	r.OnWelcome(WelcomeInfo{Terminal: true, Owner: &WelcomeOwner{UserID: "u1", Shared: true}})
	st := mustCall(t, r, map[string]any{"op": "remote.status"}).Status
	if st.Enabled || !st.Shared {
		t.Fatalf("máy dùng chung = %+v", st)
	}
	if _, err := call(t, r, map[string]any{"op": "remote.enable"}); failCode(t, err) != localipc.CodeDenied {
		t.Fatalf("bật trên máy dùng chung: %v", err)
	}
	if _, err := call(t, r, map[string]any{"op": "remote.pair.begin"}); failCode(t, err) != localipc.CodeDenied {
		t.Fatalf("ghép trên máy dùng chung: %v", err)
	}
	if got := auditActions(t, r); got[len(got)-1] != "remote_disable/hub" {
		t.Fatalf("audit = %v", got)
	}
}

func TestRemoteRoots(t *testing.T) {
	r := newRemote(t)
	proj := filepath.Join(t.TempDir(), "xdev-app")
	if err := os.MkdirAll(proj, 0o700); err != nil {
		t.Fatal(err)
	}
	real, _ := filepath.EvalSymlinks(proj)
	out := mustCall(t, r, map[string]any{"op": "remote.roots.add", "path": proj})
	if out.Root.Label != "xdev-app" || out.Root.Path != real || !strings.HasPrefix(out.Root.ID, "root-") || len(out.Status.Roots) != 1 {
		t.Fatalf("thêm = %+v", out)
	}
	labelled := filepath.Join(t.TempDir(), "khac")
	_ = os.MkdirAll(labelled, 0o700)
	mustCall(t, r, map[string]any{"op": "remote.roots.add", "path": labelled, "label": "  Dự án\x1b[31m khác "})
	file := filepath.Join(t.TempDir(), "tep.txt")
	_ = os.WriteFile(file, []byte("x"), 0o600)
	for _, tt := range []struct {
		path, code string
	}{
		{proj, localipc.CodeBadRequest},
		{proj + string(filepath.Separator) + ".", localipc.CodeBadRequest},
		{"tuong-doi", localipc.CodeBadRequest},
		{filepath.Join(t.TempDir(), "khong-co"), localipc.CodeNotFound},
		{file, localipc.CodeBadRequest},
		{filepath.VolumeName(proj) + string(filepath.Separator), localipc.CodeBadRequest},
	} {
		if _, err := call(t, r, map[string]any{"op": "remote.roots.add", "path": tt.path}); failCode(t, err) != tt.code {
			t.Errorf("%q: %v", tt.path, err)
		}
	}
	if runtime.GOOS != "windows" {
		link := filepath.Join(t.TempDir(), "lien-ket")
		if err := os.Symlink(proj, link); err != nil {
			t.Fatal(err)
		}
		if _, err := call(t, r, map[string]any{"op": "remote.roots.add", "path": link}); failCode(t, err) != localipc.CodeBadRequest {
			t.Errorf("symlink tới root đã có phải bị coi là trùng: %v", err)
		}
	}

	st := r.State()
	if len(st.Roots) != 2 || st.Roots[1].Label != "Dự án[31m khác" {
		t.Fatalf("term_state.roots = %+v", st.Roots)
	}
	b, _ := json.Marshal(st)
	if strings.Contains(string(b), real) {
		t.Fatalf("term_state không được có đường dẫn: %s", b)
	}
	if _, err := call(t, r, map[string]any{"op": "remote.roots.remove", "id": "root-khongco"}); failCode(t, err) != localipc.CodeNotFound {
		t.Fatalf("xoá root không có: %v", err)
	}
	if st := mustCall(t, r, map[string]any{"op": "remote.roots.remove", "id": out.Root.ID}).Status; len(st.Roots) != 1 {
		t.Fatalf("sau khi xoá = %+v", st.Roots)
	}
	if got := strings.Join(auditActions(t, r), ","); got != "root_add/machine,root_add/machine,root_remove/machine" {
		t.Fatalf("audit = %s", got)
	}
}

func TestRemoteSettings(t *testing.T) {
	r := newRemote(t)
	st := mustCall(t, r, map[string]any{"op": "remote.settings", "confirmOnMachine": true, "idleMinutes": 30, "maxHours": 4}).Status
	if !st.ConfirmOnMachine || st.IdleMinutes != 30 || st.MaxHours != 4 || st.DetachedHours != 2 {
		t.Fatalf("cài đặt = %+v", st)
	}
	if !r.State().ConfirmOnMachine {
		t.Fatal("term_state.confirmOnMachine")
	}
	for _, bad := range []map[string]any{{"idleMinutes": 0}, {"maxHours": 73}, {"detachedHours": -1}} {
		bad["op"] = "remote.settings"
		if _, err := call(t, r, bad); failCode(t, err) != localipc.CodeBadRequest {
			t.Errorf("%v: %v", bad, err)
		}
	}
}

// Gói từ hub chỉ tắt và gỡ: không gói nào bật được hay thêm thiết bị khi chưa ai bấm tại máy (FR-012).
func TestRemoteHubOnlyDisables(t *testing.T) {
	r := newRemote(t)
	r.HubDisable(DisableRequest{By: "u1"})
	if r.State().Enabled {
		t.Fatal("tắt khi đang tắt vẫn phải là tắt")
	}
	mustCall(t, r, map[string]any{"op": "remote.enable"})
	r.HubDisable(DisableRequest{By: "u1"})
	if r.State().Enabled {
		t.Fatal("term_disable phải tắt")
	}
	if got := auditActions(t, r); got[len(got)-1] != "remote_disable/hub:u1" {
		t.Fatalf("audit = %v", got)
	}
}

func TestRemoteUnknownOp(t *testing.T) {
	r := newRemote(t)
	if _, err := call(t, r, map[string]any{"op": "remote.lamgi"}); failCode(t, err) != localipc.CodeUnsupported {
		t.Fatalf("op lạ: %v", err)
	}
}

func TestAuditRotates(t *testing.T) {
	dir := t.TempDir()
	a := &Audit{Path: filepath.Join(dir, "remote-audit.log"), MaxBytes: 200, Keep: 2}
	for i := range 20 {
		if err := a.Write("root_add", byMachine, map[string]any{"i": i}); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"remote-audit.log", "remote-audit.log.1", "remote-audit.log.2"} {
		st, err := os.Stat(filepath.Join(dir, name))
		if err != nil || st.Size() > 200 {
			t.Fatalf("%s: %v %v", name, st, err)
		}
		if runtime.GOOS != "windows" && st.Mode().Perm() != 0o600 {
			t.Fatalf("%s quyền %v", name, st.Mode().Perm())
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "remote-audit.log.3")); !os.IsNotExist(err) {
		t.Fatal("chỉ giữ Keep bản cũ")
	}
}

// Recorder gửi term_state có phần của Remote ngay khi người ở máy đổi gì đó.
func TestRecorderSendsRemoteState(t *testing.T) {
	r := newRemote(t)
	rec := &Recorder{Dir: filepath.Join(t.TempDir(), "terminal"), Remote: r}
	link := newFakeLink()
	rec.OnWelcome(personal(), link)
	mustCall(t, r, map[string]any{"op": "remote.enable"})
	waitRec(t, "term_state bật", func() bool {
		ok := false
		link.snapshot(func(f *fakeLink) { ok = len(f.states) > 0 && f.states[len(f.states)-1].Enabled })
		return ok
	})
	link.snapshot(func(f *fakeLink) {
		st := f.states[len(f.states)-1]
		if fmt.Sprint(st.CLIs) != "[claude codex]" {
			t.Fatalf("state = %+v", st)
		}
	})
}
