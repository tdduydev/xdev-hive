//go:build !windows

package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/remoteauth"
	"github.com/tdduydev/xdev-hive/worker/internal/terminal"
)

// startRemote chạy socket nội bộ với phần từ xa thật của worker (thư mục tạm), máy riêng của u1.
func startRemote(t *testing.T) (string, *terminal.Remote) {
	t.Helper()
	return startRemoteWith(t, nil)
}

// startRemoteWith cho sửa Remote trước khi socket nhận kết nối, để test không ghi trường đang được goroutine khác đọc.
func startRemoteWith(t *testing.T, edit func(*terminal.Remote)) (string, *terminal.Remote) {
	t.Helper()
	dir := shortTemp(t)
	r := &terminal.Remote{
		Store:       remoteauth.NewStore(dir),
		Pairings:    &remoteauth.Pairings{},
		TOTP:        remoteauth.NewTOTPStore(dir),
		Audit:       &terminal.Audit{Path: filepath.Join(dir, "remote-audit.log")},
		HubURL:      "https://hive.example.vn",
		Machine:     "mac-lan",
		CLIs:        []string{"claude"},
		ConfirmWait: 5 * time.Second,
	}
	r.OnWelcome(terminal.WelcomeInfo{Terminal: true, Owner: &terminal.WelcomeOwner{UserID: "u1"}})
	if edit != nil {
		edit(r)
	}
	path := filepath.Join(dir, "run", "hive.sock")
	ln, err := localipc.Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		_ = (&localipc.Server{Worker: "9.9.9-test", Handler: r.Handle}).Serve(ctx, ln)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return path, r
}

func runRemote(t *testing.T, path string, stdin string, tty bool, args ...string) (*testApp, int) {
	t.Helper()
	a := newTestApp(path, strings.NewReader(stdin))
	a.con.tty = tty
	return a, a.run(append([]string{"remote"}, args...))
}

func mustRemote(t *testing.T, path string, args ...string) *testApp {
	t.Helper()
	a, code := runRemote(t, path, "", false, args...)
	if code != exitOK {
		t.Fatalf("%v: mã %d, stderr %q", args, code, a.err.String())
	}
	return a
}

func TestRemoteOnOffStatus(t *testing.T) {
	path, r := startRemote(t)
	if out := mustRemote(t, path, "status").out.String(); !strings.Contains(out, "Điều khiển từ xa: Tắt") ||
		!strings.Contains(out, "Thư mục được mở từ xa: chưa có") || !strings.Contains(out, "Ngắt khi không dùng: 15 phút") {
		t.Fatalf("status = %q", out)
	}
	// Không có terminal thì không tự coi là đồng ý; trả lời không cũng không bật.
	if a, code := runRemote(t, path, "", false, "on"); code != exitUsage || !strings.Contains(a.err.String(), "--yes") {
		t.Fatalf("không tty: %d %q", code, a.err.String())
	}
	if a, code := runRemote(t, path, "n\n", true, "on"); code != exitFailed || !strings.Contains(a.out.String(), "Agent có thể chạy lệnh") {
		t.Fatalf("trả lời không: %d %q", code, a.out.String())
	}
	if r.State().Enabled {
		t.Fatal("chưa xác nhận mà đã bật")
	}
	if a, code := runRemote(t, path, "có\n", true, "on"); code != exitOK || !strings.Contains(a.out.String(), "hive remote pair") {
		t.Fatalf("bật: %d %q %q", code, a.out.String(), a.err.String())
	}
	if !r.State().Enabled {
		t.Fatal("phải bật")
	}

	var st struct {
		Status struct {
			Enabled bool `json:"enabled"`
		} `json:"status"`
		OK *bool `json:"ok"`
	}
	if err := json.Unmarshal([]byte(mustRemote(t, path, "off", "--json").out.String()), &st); err != nil || st.Status.Enabled || st.OK != nil {
		t.Fatalf("off --json = %+v %v", st, err)
	}
	if out := mustRemote(t, path, "on", "--yes").out.String(); !strings.Contains(out, "Đã bật") {
		t.Fatalf("on --yes = %q", out)
	}
	if out := mustRemote(t, path, "off").out.String(); !strings.Contains(out, "Đã tắt") || r.State().Enabled {
		t.Fatalf("off = %q", out)
	}
}

func TestRemoteRootsAndDevices(t *testing.T) {
	path, _ := startRemote(t)
	base := t.TempDir()
	if err := os.MkdirAll(filepath.Join(base, "xdev-app"), 0o700); err != nil {
		t.Fatal(err)
	}
	// Thư mục tương đối hiểu theo nơi gõ lệnh.
	a := newTestApp(path, nil)
	a.getwd = func() (string, error) { return base, nil }
	if code := a.run([]string{"remote", "roots", "add", "xdev-app", "--label", "Ứng dụng"}); code != exitOK {
		t.Fatalf("add: %d %q", code, a.err.String())
	}
	m := regexp.MustCompile(`Đã thêm thư mục Ứng dụng \((root-[\w-]+)\)`).FindStringSubmatch(a.out.String())
	if m == nil {
		t.Fatalf("add = %q", a.out.String())
	}
	if out := mustRemote(t, path, "roots").out.String(); !strings.Contains(out, m[1]) || !strings.Contains(out, "xdev-app") {
		t.Fatalf("roots = %q", out)
	}
	var roots []remoteRoot
	if err := json.Unmarshal([]byte(mustRemote(t, path, "roots", "--json").out.String()), &roots); err != nil || len(roots) != 1 {
		t.Fatalf("roots --json = %+v %v", roots, err)
	}
	for _, tt := range []struct {
		args []string
		code int
		msg  string
	}{
		{[]string{"roots", "add", filepath.Join(base, "khong-co")}, exitFailed, "Không có thư mục"},
		{[]string{"roots", "rm", "root-khongco"}, exitFailed, "root-khongco"},
		{[]string{"roots", "add"}, exitUsage, "Cách dùng: hive remote roots"},
		{[]string{"devices", "rm", "dev-khongco"}, exitFailed, "dev-khongco"},
		{[]string{"devices", "xoa"}, exitUsage, "Cách dùng: hive remote devices"},
	} {
		if a, code := runRemote(t, path, "", false, tt.args...); code != tt.code || !strings.Contains(a.err.String(), tt.msg) {
			t.Errorf("%v: %d %q", tt.args, code, a.err.String())
		}
	}
	if out := mustRemote(t, path, "roots", "rm", m[1]).out.String(); !strings.Contains(out, "Đã gỡ thư mục") {
		t.Fatalf("rm = %q", out)
	}
	if out := mustRemote(t, path, "devices").out.String(); !strings.Contains(out, "chưa có") {
		t.Fatalf("devices = %q", out)
	}
	if out := mustRemote(t, path, "devices", "--json").out.String(); strings.TrimSpace(out) != "[]" {
		t.Fatalf("devices --json = %q", out)
	}
}

func TestRemoteSet(t *testing.T) {
	path, r := startRemote(t)
	if out := mustRemote(t, path, "set", "idle-minutes", "30").out.String(); !strings.Contains(out, "Ngắt khi không dùng: 30 phút") {
		t.Fatalf("set = %q", out)
	}
	mustRemote(t, path, "set", "confirm-on-machine", "on", "--json")
	if !r.State().ConfirmOnMachine {
		t.Fatal("confirm-on-machine")
	}
	for _, tt := range []struct {
		args []string
		code int
		msg  string
	}{
		{[]string{"set", "idle-minutes", "0"}, exitUsage, "idleMinutes phải từ 1"},
		{[]string{"set", "allow-full-access", "on"}, exitUsage, "--yes"},
	} {
		if a, code := runRemote(t, path, "", false, tt.args...); code != tt.code || !strings.Contains(a.err.String(), tt.msg) {
			t.Errorf("%v: %d %q", tt.args, code, a.err.String())
		}
	}
	if st, _ := r.Status(); st.AllowFullAccess {
		t.Fatal("toàn quyền chưa xác nhận mà đã bật")
	}
	mustRemote(t, path, "set", "allow-full-access", "on", "--yes")
	if st, _ := r.Status(); !st.AllowFullAccess {
		t.Fatal("allow-full-access")
	}
}

// phoneFromURL đóng vai điện thoại quét QR: đọc bí mật trong fragment, tạo passkey và ký tag.
func phoneFromURL(t *testing.T, link, userID string) terminal.PairRequest {
	t.Helper()
	u, err := url.Parse(link)
	if err != nil {
		t.Fatal(err)
	}
	secret, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(u.Fragment, "s="))
	if err != nil {
		t.Fatal(err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
	spki := base64.RawURLEncoding.EncodeToString(der)
	pairID := u.Query().Get("p")
	payload, err := remoteauth.PairTagPayload(pairID, userID, "cred-1", spki)
	if err != nil {
		t.Fatal(err)
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(payload)
	return terminal.PairRequest{PairID: pairID, UserID: userID, Label: "iPhone của Lan", CredentialID: "cred-1", SPKI: spki,
		Tag: base64.RawURLEncoding.EncodeToString(mac.Sum(nil))}
}

var linkRE = regexp.MustCompile(`mở link này trên điện thoại: (\S+)`)

func TestRemotePair(t *testing.T) {
	for _, tt := range []struct {
		name   string
		answer string // "" là đóng stdin không trả lời
		code   int
		ok     bool
		msg    string
	}{
		{"cho phép", "y\n", exitOK, true, "Đã ghép thiết bị dev-"},
		{"từ chối", "n\n", exitFailed, false, "Đã từ chối ghép"},
		{"không ai trả lời", "", exitFailed, false, "Đã từ chối ghép"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			path, r := startRemote(t)
			if a, code := runRemote(t, path, "", false, "pair"); code != exitUsage || !strings.Contains(a.err.String(), "hive remote on") {
				t.Fatalf("ghép khi đang tắt: %d %q", code, a.err.String())
			}
			mustRemote(t, path, "on", "--yes")

			stdinR, stdinW := io.Pipe()
			a := newTestApp(path, stdinR)
			got := make(chan int, 1)
			go func() { got <- a.run([]string{"remote", "pair"}) }()
			waitFor(t, "mã QR", func() bool { return strings.Contains(a.out.String(), "Mã dùng được một lần") })
			out := a.out.String()
			m := linkRE.FindStringSubmatch(out)
			if m == nil || !strings.Contains(out, "█") || !strings.Contains(out, "đăng nhập hive.example.vn") {
				t.Fatalf("pair = %q", out)
			}
			if tt.answer == "" {
				_ = stdinW.Close()
			}

			res := make(chan terminal.PairResult, 1)
			go func() { res <- r.HandlePair(phoneFromURL(t, m[1], "u1")) }()
			if tt.answer != "" {
				waitFor(t, "câu hỏi", func() bool { return strings.Contains(a.out.String(), `Ghép "iPhone của Lan" (người dùng u1)`) })
				_, _ = io.WriteString(stdinW, tt.answer)
			}
			if p := <-res; p.OK != tt.ok {
				t.Fatalf("kết quả ghép = %+v", p)
			}
			if code := <-got; code != tt.code || !strings.Contains(a.out.String()+a.err.String(), tt.msg) {
				t.Fatalf("mã %d, out %q, err %q", code, a.out.String(), a.err.String())
			}
			_ = stdinW.Close()
		})
	}
}

func TestRemotePairExpires(t *testing.T) {
	path, _ := startRemote(t)
	mustRemote(t, path, "on", "--yes")
	a := newTestApp(path, nil)
	w, code := a.openWatch()
	if code != exitOK {
		t.Fatal(a.err.String())
	}
	defer w.Close()
	if code := a.followEvents(w, "pair-x", time.Now().Add(50*time.Millisecond)); code != exitFailed || !strings.Contains(a.err.String(), "hết hạn") {
		t.Fatalf("hết hạn: %d %q", code, a.err.String())
	}
}

// watch --json là cầu của app: in nguyên từng dòng, chuyển yêu cầu JSON từ stdin, đóng stdin là thôi.
func TestRemoteWatchJSON(t *testing.T) {
	path, r := startRemote(t)
	stdinR, stdinW := io.Pipe()
	a := newTestApp(path, stdinR)
	got := make(chan int, 1)
	go func() { got <- a.run([]string{"remote", "watch", "--json"}) }()
	waitFor(t, "trạng thái đầu", func() bool { return strings.Contains(a.out.String(), `"status"`) })

	mustRemote(t, path, "on", "--yes")
	waitFor(t, "sự kiện state", func() bool { return strings.Contains(a.out.String(), `"event":"state"`) })
	pair := mustRemote(t, path, "pair", "--json").out.String()
	var p struct {
		Pair struct {
			PairID string `json:"pairId"`
			URL    string `json:"url"`
		} `json:"pair"`
	}
	if err := json.Unmarshal([]byte(pair), &p); err != nil || p.Pair.URL == "" {
		t.Fatalf("pair --json = %q %v", pair, err)
	}
	res := make(chan terminal.PairResult, 1)
	go func() { res <- r.HandlePair(phoneFromURL(t, p.Pair.URL, "u1")) }()
	waitFor(t, "pair_request", func() bool { return strings.Contains(a.out.String(), `"event":"pair_request"`) })
	_, _ = io.WriteString(stdinW, "khong-phai-json\n")
	_, _ = io.WriteString(stdinW, `{"op":"remote.pair.decide","pairId":"`+p.Pair.PairID+`","allow":true}`+"\n")
	if pr := <-res; !pr.OK {
		t.Fatalf("ghép = %+v", pr)
	}
	waitFor(t, "pair_done", func() bool { return strings.Contains(a.out.String(), `"event":"pair_done"`) })
	_ = stdinW.Close()
	if code := <-got; code != exitOK || !strings.Contains(a.err.String(), "không phải JSON") {
		t.Fatalf("mã %d, err %q", code, a.err.String())
	}
}

// watch không --json: hỏi tại terminal như hive remote pair, nhưng chạy tiếp sau mỗi kết quả.
func TestRemoteWatchAsks(t *testing.T) {
	path, r := startRemote(t)
	mustRemote(t, path, "on", "--yes")
	stdinR, stdinW := io.Pipe()
	defer stdinW.Close()
	a := newTestApp(path, stdinR)
	go func() { _ = a.run([]string{"remote", "watch"}) }()
	waitFor(t, "watch", func() bool { return strings.Contains(a.err.String(), "đang theo dõi") })
	for i, answer := range []string{"n\n", "y\n"} {
		info := mustRemote(t, path, "pair", "--json").out.String()
		var p struct {
			Pair struct {
				URL string `json:"url"`
			} `json:"pair"`
		}
		_ = json.Unmarshal([]byte(info), &p)
		res := make(chan terminal.PairResult, 1)
		go func() { res <- r.HandlePair(phoneFromURL(t, p.Pair.URL, "u1")) }()
		waitFor(t, "câu hỏi", func() bool { return strings.Count(a.out.String(), "Cho phép? [y/N]") == i+1 })
		_, _ = io.WriteString(stdinW, answer)
		if pr := <-res; pr.OK != (i == 1) {
			t.Fatalf("lần %d: %+v", i+1, pr)
		}
	}
	waitFor(t, "kết quả", func() bool { return strings.Contains(a.out.String(), "Đã ghép thiết bị") })
	if !strings.Contains(a.err.String(), "Đã từ chối ghép") {
		t.Fatalf("err = %q", a.err.String())
	}
}
