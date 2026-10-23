package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/zalando/go-keyring"

	"github.com/tdduydev/xdev-hive/worker/internal/outbox"
)

// memKeyring là keychain giả; broken giả máy không có keychain (Linux không có Secret Service).
type memKeyring struct {
	mu     sync.Mutex
	m      map[string]string
	broken bool
}

func (k *memKeyring) Get(s, u string) (string, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if v, ok := k.m[s+"|"+u]; ok {
		return v, nil
	}
	return "", keyring.ErrNotFound
}

func (k *memKeyring) Set(s, u, p string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.broken {
		return errors.New("không có Secret Service")
	}
	if k.m == nil {
		k.m = map[string]string{}
	}
	k.m[s+"|"+u] = p
	return nil
}

func (k *memKeyring) Delete(s, u string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	if _, ok := k.m[s+"|"+u]; !ok {
		return keyring.ErrNotFound
	}
	delete(k.m, s+"|"+u)
	return nil
}

const (
	testOrg   = "11111111-2222-4333-8444-555555555555"
	testToken = "hive_pat_" + testOrg + "_abcdefghijABCDEFGHIJabcdefghijABCDEFGHIJ012"
)

// fakeHub giả các route REST mà hive gọi; kiểm token và tổ chức như hub thật.
type fakeHub struct {
	*httptest.Server
	mu        sync.Mutex
	challenge string
	revoked   bool
	exchanges int
}

func newFakeHub(t *testing.T) *fakeHub {
	t.Helper()
	h := &fakeHub{}
	h.Server = httptest.NewServer(http.HandlerFunc(h.serve))
	t.Cleanup(h.Close)
	return h
}

func (h *fakeHub) serve(w http.ResponseWriter, r *http.Request) {
	reply := func(status int, v any) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(v)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if r.URL.Path == "/api/v1/desktop/connect/exchange" {
		var in struct{ Code, Verifier string }
		_ = json.NewDecoder(r.Body).Decode(&in)
		h.exchanges++
		if in.Code != "hdc_ok" || pkceChallenge(in.Verifier) != h.challenge {
			reply(401, map[string]string{"message": "Mã đăng nhập không hợp lệ, đã hết hạn hoặc đã dùng."})
			return
		}
		reply(200, map[string]string{"purpose": "cli", "hubUrl": h.URL, "machine": "may-test", "personalToken": testToken,
			"personalTokenExpiresAt": "2027-01-01T00:00:00.000Z"})
		return
	}
	if r.Header.Get("authorization") != "Bearer "+testToken || r.Header.Get("x-hive-org") != testOrg || h.revoked {
		reply(401, map[string]string{"message": "Chưa đăng nhập."})
		return
	}
	switch r.URL.Path {
	case "/api/v1/me":
		reply(200, map[string]any{"id": "u1", "name": "Lan", "email": "lan@example.com", "image": nil})
	case "/api/v1/projects":
		reply(200, []map[string]string{{"id": "p-other", "key": "OPS", "name": "Vận hành"}, {"id": "p-pay", "key": "PAY", "name": "Thanh toán"}})
	case "/api/v1/tasks":
		if r.URL.Query().Get("projectId") != "p-pay" {
			reply(200, []any{})
			return
		}
		reply(200, []map[string]string{{"id": "t-12", "projectId": "p-pay", "key": "PAY-12", "title": "Sửa lỗi đăng nhập"}})
	case "/api/v1/remote/sessions":
		reply(200, []map[string]any{{"id": "s-1", "machineName": "mac-lan", "cli": "claude", "cwdLabel": "xdev/app", "taskKey": "PAY-12",
			"projectKey": "PAY", "state": "running", "controller": "local", "createdAt": "2026-10-14T08:00:00.000Z"}})
	default:
		reply(404, map[string]string{"message": "không có"})
	}
}

// browser giả trình duyệt: đọc địa chỉ đăng nhập, ghi challenge cho hub giả rồi gọi về cổng loopback.
func (h *fakeHub) browser(t *testing.T, reply func(port, state string) []string) func(string) error {
	return func(link string) error {
		u, err := url.Parse(link)
		if err != nil {
			return err
		}
		q := u.Query()
		if u.Path != "/desktop/connect" || q.Get("purpose") != "cli" || q.Get("machine") == "" {
			t.Errorf("địa chỉ đăng nhập = %s", link)
		}
		h.mu.Lock()
		h.challenge = q.Get("challenge")
		h.mu.Unlock()
		go func() {
			for _, path := range reply(q.Get("port"), q.Get("state")) {
				res, err := http.Get("http://127.0.0.1:" + q.Get("port") + path)
				if err == nil {
					res.Body.Close()
				}
			}
		}()
		return nil
	}
}

func loginApp(t *testing.T) *testApp {
	t.Helper()
	return newTestApp(filepath.Join(t.TempDir(), "hive.sock"), nil)
}

func TestLoginBrowserFlow(t *testing.T) {
	hub := newFakeHub(t)
	a := loginApp(t)
	// Request lạ (state khác) không được làm hỏng lượt đăng nhập; trình duyệt trả đúng state thì xong.
	a.openURL = hub.browser(t, func(_, state string) []string {
		return []string{"/favicon.ico", "/callback?code=hdc_ok&state=khac", "/callback?code=hdc_ok&state=" + state}
	})
	if code := a.run([]string{"login", "--hub", hub.URL + "/"}); code != exitOK {
		t.Fatalf("login: %d %s", code, a.err.String())
	}
	if !strings.Contains(a.out.String(), "Đã đăng nhập "+hub.URL+": Lan (lan@example.com)") {
		t.Fatalf("stdout = %q", a.out.String())
	}
	if got, _ := a.keyring.Get(keyringService, hub.URL); got != testToken {
		t.Fatalf("keychain = %q", got)
	}
	cfg, _, err := a.loadCLIConfig()
	if err != nil || cfg.HubURL != hub.URL || cfg.Token != "" {
		t.Fatalf("hive.json = %+v %v (token chỉ nằm trong keychain)", cfg, err)
	}
	if cfg.UserID != "u1" || cfg.OrgID != testOrg || cfg.Email != "lan@example.com" {
		t.Fatalf("hive.json thiếu danh tính: %+v", cfg)
	}
	// Hộp thư đi của hive-worker đọc cùng file và keychain.
	cfgPath, _ := a.cliConfig()
	creds := &outbox.Credentials{Path: cfgPath, Keyring: a.keyring}
	if id, err := creds.Current(context.Background()); err != nil || id.UserID != "u1" || id.OrgID != testOrg {
		t.Fatalf("outbox đọc danh tính %+v %v", id, err)
	}
	// `hive auth store` cùng token giữ danh tính; token khác có thể là người khác nên bỏ.
	if _, err := a.saveToken(hub.URL, testToken); err != nil {
		t.Fatal(err)
	}
	if cfg, _, _ := a.loadCLIConfig(); cfg.UserID != "u1" || cfg.TokenSHA256 != outbox.TokenFingerprint(testToken) {
		t.Fatalf("cùng token mất danh tính hay dấu vân tay: %+v", cfg)
	}
	otherToken := "hive_pat_" + testOrg + "_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
	// Keychain bị ghi thẳng token khác (không qua hive): outbox không tin danh tính cũ, và auth store đúng token đang nằm
	// trong keychain cũng không được giữ danh tính đó.
	if err := a.keyring.Set(keyringService, hub.URL, otherToken); err != nil {
		t.Fatal(err)
	}
	var oe *outbox.Error
	if _, err := creds.Current(context.Background()); !errors.As(err, &oe) || oe.Code != "NOT_SIGNED_IN" {
		t.Fatalf("token đổi ngoài hive mà outbox vẫn tin danh tính cũ: %v", err)
	}
	if _, err := a.saveToken(hub.URL, otherToken); err != nil {
		t.Fatal(err)
	}
	if cfg, _, _ := a.loadCLIConfig(); cfg.UserID != "" {
		t.Fatalf("token khác còn danh tính cũ: %+v", cfg)
	}
	if _, err := a.saveToken(hub.URL, testToken); err != nil {
		t.Fatal(err)
	}

	who := loginApp(t)
	who.keyring, who.cliConfig = a.keyring, a.cliConfig
	if code := who.run([]string{"whoami"}); code != exitOK || !strings.Contains(who.out.String(), "Lan (lan@example.com) trên "+hub.URL) {
		t.Fatalf("whoami: %d %q %q", code, who.out.String(), who.err.String())
	}

	out := loginApp(t)
	out.keyring, out.cliConfig = a.keyring, a.cliConfig
	if code := out.run([]string{"logout"}); code != exitOK {
		t.Fatalf("logout: %d %s", code, out.err.String())
	}
	if _, err := a.keyring.Get(keyringService, hub.URL); !errors.Is(err, keyring.ErrNotFound) {
		t.Fatal("logout phải xoá token trong keychain")
	}
	again := loginApp(t)
	again.keyring, again.cliConfig = a.keyring, a.cliConfig
	if code := again.run([]string{"whoami"}); code != exitUsage || !strings.Contains(again.err.String(), "Chưa đăng nhập") {
		t.Fatalf("sau logout: %d %q", code, again.err.String())
	}
}

func TestLoginDeniedAndTimeout(t *testing.T) {
	hub := newFakeHub(t)
	a := loginApp(t)
	a.openURL = hub.browser(t, func(_, state string) []string { return []string{"/callback?error=access_denied&state=" + state} })
	if code := a.run([]string{"login", "--hub", hub.URL}); code != exitFailed || !strings.Contains(a.err.String(), "từ chối") {
		t.Fatalf("từ chối: %d %q", code, a.err.String())
	}

	slow := loginApp(t)
	slow.loginWait = 50 * time.Millisecond
	slow.openURL = func(string) error { return errors.New("không có trình duyệt") }
	if code := slow.run([]string{"login", "--hub", hub.URL}); code != exitFailed || !strings.Contains(slow.err.String(), "chưa đăng nhập xong") {
		t.Fatalf("hết giờ: %d %q", code, slow.err.String())
	}
	if !strings.Contains(slow.err.String(), "/desktop/connect?") || !strings.Contains(slow.err.String(), "Không tự mở được trình duyệt") {
		t.Fatalf("phải in địa chỉ để chép tay: %q", slow.err.String())
	}
	// Mã đổi sai (verifier không khớp): lỗi tiếng Việt của hub in nguyên.
	bad := loginApp(t)
	bad.openURL = hub.browser(t, func(_, state string) []string { return []string{"/callback?code=hdc_sai&state=" + state} })
	if code := bad.run([]string{"login", "--hub", hub.URL}); code != exitFailed || !strings.Contains(bad.err.String(), "Mã đăng nhập không hợp lệ") {
		t.Fatalf("mã sai: %d %q", code, bad.err.String())
	}
}

func TestLoginWithoutKeychainPointsToHiveToken(t *testing.T) {
	hub := newFakeHub(t)
	a := newTestApp(filepath.Join(t.TempDir(), "hive.sock"), strings.NewReader(testToken+"\n"))
	a.keyring = &memKeyring{broken: true}
	if code := a.run([]string{"login", "--with-token", "--hub", hub.URL}); code != exitFailed {
		t.Fatalf("login: %d %s", code, a.err.String())
	}
	if !strings.Contains(a.err.String(), "HIVE_TOKEN") || strings.Contains(a.err.String(), testToken) {
		t.Fatalf("phải hướng dẫn HIVE_TOKEN, không lộ token: %q", a.err.String())
	}
	if cfg, _, err := a.loadCLIConfig(); err != nil || cfg.Token != "" {
		t.Fatalf("hive.json = %+v %v (token không được ghi ra file)", cfg, err)
	}
	// Keychain không đọc được: báo trước khi mở trình duyệt, để hub khỏi cấp token cá nhân bỏ phí.
	b := loginApp(t)
	b.keyring = failingAuthKeyring{}
	b.openURL = func(string) error {
		t.Error("không được mở trình duyệt khi không lưu được token")
		return nil
	}
	if code := b.run([]string{"login", "--hub", hub.URL}); code != exitFailed || !strings.Contains(b.err.String(), "HIVE_TOKEN") {
		t.Fatalf("keychain hỏng: %d %q", code, b.err.String())
	}
	a.getenv = func(k string) string { return map[string]string{"HIVE_TOKEN": testToken, "HIVE_HUB_URL": hub.URL}[k] }
	if code := a.run([]string{"whoami"}); code != exitOK {
		t.Fatalf("whoami bằng HIVE_TOKEN: %d %s", code, a.err.String())
	}

	for _, in := range []string{"", "khong-phai-token\n"} {
		b := newTestApp(filepath.Join(t.TempDir(), "hive.sock"), strings.NewReader(in))
		if code := b.run([]string{"login", "--with-token", "--hub", hub.URL}); code != exitUsage {
			t.Errorf("token %q: %d %s", in, code, b.err.String())
		}
	}
}

func TestWhoamiRevokedToken(t *testing.T) {
	hub := newFakeHub(t)
	a := newTestApp(filepath.Join(t.TempDir(), "hive.sock"), strings.NewReader(testToken))
	if code := a.run([]string{"login", "--with-token", "--hub", hub.URL}); code != exitOK {
		t.Fatalf("login: %d %s", code, a.err.String())
	}
	hub.mu.Lock()
	hub.revoked = true
	hub.mu.Unlock()
	if code := a.run([]string{"whoami"}); code != exitUsage || !strings.Contains(a.err.String(), "Chạy hive login") {
		t.Fatalf("token bị thu hồi: %d %q", code, a.err.String())
	}
}

func TestLsAll(t *testing.T) {
	hub := newFakeHub(t)
	a := newTestApp(filepath.Join(t.TempDir(), "hive.sock"), strings.NewReader(testToken))
	if code := a.run([]string{"login", "--with-token", "--hub", hub.URL}); code != exitOK {
		t.Fatalf("login: %d %s", code, a.err.String())
	}
	if code := a.run([]string{"ls", "--all"}); code != exitOK {
		t.Fatalf("ls --all: %d %s", code, a.err.String())
	}
	for _, want := range []string{"MÁY", "mac-lan", "PAY-12", "tại máy", "xdev/app"} {
		if !strings.Contains(a.out.String(), want) {
			t.Fatalf("thiếu %q: %q", want, a.out.String())
		}
	}
}

func TestResolveLink(t *testing.T) {
	hub := newFakeHub(t)
	a := newTestApp(filepath.Join(t.TempDir(), "hive.sock"), strings.NewReader(testToken))
	if code := a.run([]string{"login", "--with-token", "--hub", hub.URL}); code != exitOK {
		t.Fatalf("login: %d %s", code, a.err.String())
	}
	for _, tt := range []struct {
		o             chatOptions
		project, task string
		code          int
	}{
		{chatOptions{task: "pay-12"}, "p-pay", "t-12", exitOK},
		{chatOptions{project: "PAY"}, "p-pay", "", exitOK},
		{chatOptions{task: "PAY-99"}, "", "", exitUsage},
		{chatOptions{task: "KHONG-1"}, "", "", exitUsage},
		{chatOptions{task: "PAY"}, "", "", exitUsage},
		{chatOptions{project: "XYZ"}, "", "", exitUsage},
		{chatOptions{}, "", "", exitOK},
	} {
		p, task, code := a.resolveLink(tt.o)
		if p != tt.project || task != tt.task || code != tt.code {
			t.Errorf("%+v: %q %q %d", tt.o, p, task, code)
		}
	}
}

func TestMachineName(t *testing.T) {
	t.Setenv("HIVE_WORKER_CONFIG", filepath.Join(t.TempDir(), "khong-co.json"))
	for in, want := range map[string]string{"Lan's MacBook Pro.local": "lan-s-macbook-pro", "---": "worker", "DESKTOP-AB12": "desktop-ab12"} {
		if got := machineName(in); got != want {
			t.Errorf("machineName(%q) = %q, cần %q", in, got, want)
		}
	}
}
