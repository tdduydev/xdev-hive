//go:build !windows

package main

import (
	"encoding/base32"
	"encoding/json"
	"io"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/remoteauth"
	"github.com/tdduydev/xdev-hive/worker/internal/terminal"
)

// totpNow tính mã hiện tại từ URI otpauth:// như app Authenticator làm sau khi quét.
func totpNow(t *testing.T, uri string) string {
	t.Helper()
	u, err := url.Parse(uri)
	if err != nil {
		t.Fatal(err)
	}
	secret, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(u.Query().Get("secret"))
	if err != nil {
		t.Fatalf("secret trong %q: %v", uri, err)
	}
	return remoteauth.TOTPCode(secret, time.Now().Unix()/remoteauth.TOTPPeriod)
}

// wrongCode đổi chữ số đầu để chắc chắn khác mã đúng.
func wrongCode(code string) string {
	return string('0'+(code[0]-'0'+1)%10) + code[1:]
}

var otpauthRE = regexp.MustCompile(`Không quét được thì nhập khoá: ([A-Z2-7 ]+)\n`)

func TestRemoteTOTPEnroll(t *testing.T) {
	path, _ := startRemote(t)
	if out := mustRemote(t, path, "totp").out.String(); !strings.Contains(out, "Mã Authenticator: tắt") {
		t.Fatalf("status = %q", out)
	}

	stdinR, stdinW := io.Pipe()
	a := newTestApp(path, stdinR)
	got := make(chan int, 1)
	go func() { got <- a.run([]string{"remote", "totp", "enroll"}) }()
	waitFor(t, "câu hỏi mã", func() bool { return strings.Contains(a.out.String(), "Mã 6 số trên app: ") })
	out := a.out.String()
	m := otpauthRE.FindStringSubmatch(out)
	if m == nil || !strings.Contains(out, "█") || !strings.Contains(out, "totp-on-https on") || a.err.String() != "" {
		t.Fatalf("enroll = %q, err %q", out, a.err.String())
	}
	uri := "otpauth://totp/Hive:mac-lan?secret=" + strings.ReplaceAll(m[1], " ", "")
	code := totpNow(t, uri)

	_, _ = io.WriteString(stdinW, wrongCode(code)+"\n")
	waitFor(t, "báo sai mã", func() bool { return strings.Contains(a.err.String(), "Mã không đúng") })
	_, _ = io.WriteString(stdinW, code+"\n")
	if c := <-got; c != exitOK || !strings.Contains(a.out.String(), "Đã bật mã Authenticator") {
		t.Fatalf("mã %d, out %q, err %q", c, a.out.String(), a.err.String())
	}
	_ = stdinW.Close()

	var st struct {
		Status remoteStatus `json:"status"`
	}
	if err := json.Unmarshal([]byte(mustRemote(t, path, "totp", "status", "--json").out.String()), &st); err != nil || !st.Status.TOTP.Enabled {
		t.Fatalf("status --json = %+v %v", st, err)
	}
	if out := mustRemote(t, path, "totp", "unlock").out.String(); !strings.Contains(out, "Đã mở khoá") {
		t.Fatalf("unlock = %q", out)
	}

	// Tắt là thu quyền nên phải xác nhận như bật.
	if a, c := runRemote(t, path, "", false, "totp", "disable"); c != exitUsage || !strings.Contains(a.err.String(), "--yes") {
		t.Fatalf("disable không tty: %d %q", c, a.err.String())
	}
	if _, c := runRemote(t, path, "n\n", true, "totp", "disable"); c != exitFailed {
		t.Fatalf("disable trả lời không: %d", c)
	}
	if out := mustRemote(t, path, "totp", "disable", "--yes").out.String(); !strings.Contains(out, "Đã tắt mã Authenticator") {
		t.Fatalf("disable = %q", out)
	}
	if out := mustRemote(t, path, "totp", "status").out.String(); !strings.Contains(out, "Mã Authenticator: tắt") {
		t.Fatalf("status sau khi tắt = %q", out)
	}
}

func TestRemoteTOTPEnrollJSON(t *testing.T) {
	path, _ := startRemote(t)
	var begin struct {
		TOTP totpEnroll `json:"totp"`
	}
	if err := json.Unmarshal([]byte(mustRemote(t, path, "totp", "enroll", "--json").out.String()), &begin); err != nil ||
		!strings.HasPrefix(begin.TOTP.URI, "otpauth://totp/Hive:mac-lan?") || begin.TOTP.HubURL != "https://hive.example.vn" {
		t.Fatalf("enroll --json = %+v %v", begin, err)
	}
	code := totpNow(t, begin.TOTP.URI)
	if a, c := runRemote(t, path, "", false, "totp", "confirm", wrongCode(code), "--json"); c != exitUsage || !strings.Contains(a.err.String(), "Mã không đúng") {
		t.Fatalf("confirm sai: %d %q", c, a.err.String())
	}
	var st struct {
		Status remoteStatus `json:"status"`
	}
	if err := json.Unmarshal([]byte(mustRemote(t, path, "totp", "confirm", code, "--json").out.String()), &st); err != nil || !st.Status.TOTP.Enabled {
		t.Fatalf("confirm --json = %+v %v", st, err)
	}
	// Khoá đã lưu thì không còn khoá chờ: xác nhận lại là lỗi, không âm thầm thành công.
	if _, c := runRemote(t, path, "", false, "totp", "confirm", code); c != exitFailed {
		t.Fatalf("confirm lần hai: %d", c)
	}
}

func TestRemoteTOTPEnrollHTTPWarnsAndEOF(t *testing.T) {
	path, _ := startRemoteWith(t, func(r *terminal.Remote) { r.HubURL = "http://192.168.1.20:8080" })
	a, c := runRemote(t, path, "", false, "totp", "enroll")
	if c != exitFailed || !strings.Contains(a.err.String(), "chạy HTTP") || !strings.Contains(a.err.String(), "Chưa nhập mã") {
		t.Fatalf("mã %d, err %q", c, a.err.String())
	}
	if strings.Contains(a.out.String(), "\x1b[") {
		t.Fatal("không phải terminal thì không in màu")
	}
	if out := mustRemote(t, path, "totp", "status").out.String(); !strings.Contains(out, "Mã Authenticator: tắt") {
		t.Fatalf("chưa xác nhận mà đã bật: %q", out)
	}
}

func TestRemoteTOTPSharedMachine(t *testing.T) {
	path, r := startRemote(t)
	r.OnWelcome(terminal.WelcomeInfo{Terminal: true, Owner: &terminal.WelcomeOwner{Shared: true}})
	if a, c := runRemote(t, path, "", false, "totp", "enroll"); c != exitDenied || !strings.Contains(a.err.String(), "Máy dùng chung") {
		t.Fatalf("máy dùng chung: %d %q", c, a.err.String())
	}
}

func TestGroupBy4(t *testing.T) {
	if got := groupBy4("ABCDEFGHIJ"); got != "ABCD EFGH IJ" {
		t.Fatalf("groupBy4 = %q", got)
	}
}
