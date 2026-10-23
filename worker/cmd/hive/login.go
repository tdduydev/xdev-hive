package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/zalando/go-keyring"

	"github.com/tdduydev/xdev-hive/worker/internal/config"
	"github.com/tdduydev/xdev-hive/worker/internal/hubtls"
)

// Đăng nhập hub cho `hive` (specs/010 D12): luồng loopback PKCE của app desktop với `purpose: cli` (hub chỉ cấp token
// cá nhân), hoặc dán token bằng --with-token. Token nằm trong keychain cùng mục với app desktop (dev.xdev.hive, địa chỉ
// hub) để đăng nhập ở đâu thì nơi kia dùng được; máy không có keychain thì vào file 0600.

const (
	keyringService = "dev.xdev.hive"
	loginWait      = 5 * time.Minute
	// CLIConfigEnv ghi đè đường dẫn hive.json (test, nhiều hub trên một máy).
	cliConfigEnv = "HIVE_CLI_CONFIG"
)

// secretStore là keychain; test thay bằng bản giả.
type secretStore interface {
	Get(service, user string) (string, error)
	Set(service, user, secret string) error
	Delete(service, user string) error
}

type osKeyring struct{}

func (osKeyring) Get(s, u string) (string, error) { return keyring.Get(s, u) }
func (osKeyring) Set(s, u, p string) error        { return keyring.Set(s, u, p) }
func (osKeyring) Delete(s, u string) error        { return keyring.Delete(s, u) }

// cliConfig là hive.json cạnh worker.json. Token chỉ có ở đây khi keychain không dùng được. Danh tính (`userId`, `orgId`,
// `email`) để hộp thư đi của hive-worker biết mục là của ai mà không cần hỏi hub (spec 027 FR-018); đọc ở
// `outbox.CLILogin`.
type cliConfig struct {
	HubURL string `json:"hubUrl,omitempty"`
	Token  string `json:"token,omitempty"`
	UserID string `json:"userId,omitempty"`
	OrgID  string `json:"orgId,omitempty"`
	Email  string `json:"email,omitempty"`
}

func defaultCLIConfigPath() (string, error) {
	if p := os.Getenv(cliConfigEnv); p != "" {
		return p, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("không tìm được thư mục cấu hình: %w", err)
	}
	return filepath.Join(dir, "xdev-hive", "hive.json"), nil
}

func (a *app) loadCLIConfig() (cliConfig, string, error) {
	var c cliConfig
	path, err := a.cliConfig()
	if err != nil {
		return c, "", err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return c, path, nil
	}
	if err != nil {
		return c, path, err
	}
	if err := json.Unmarshal(data, &c); err != nil {
		return c, path, fmt.Errorf("file %s hỏng: %w", path, err)
	}
	return c, path, nil
}

// saveCLIConfig ghi file tạm 0600 rồi đổi tên, vì file có thể chứa token.
func saveCLIConfig(path string, c cliConfig) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".hive-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// credentials trả hub và token đang dùng; token rỗng là chưa đăng nhập.
func (a *app) credentials() (hub, token string, err error) {
	c, _, err := a.loadCLIConfig()
	if err != nil || c.HubURL == "" {
		return "", "", err
	}
	hub, err = normalizeHub(c.HubURL)
	if err != nil {
		return "", "", errors.New("địa chỉ hub trong cấu hình không hợp lệ")
	}
	token, _, err = a.readToken(hub)
	return hub, token, err
}

func (a *app) readToken(hub string) (token, source string, err error) {
	if t, kerr := a.keyring.Get(keyringService, hub); kerr == nil && t != "" {
		return t, "keychain", nil
	} else if kerr != nil && !errors.Is(kerr, keyring.ErrNotFound) {
		err = errors.New("không đọc được keychain")
	}
	c, _, cerr := a.loadCLIConfig()
	if cerr != nil {
		return "", "", errors.New("không đọc được cấu hình đăng nhập")
	}
	if c.HubURL != "" {
		storedHub, nerr := normalizeHub(c.HubURL)
		if nerr == nil && storedHub == hub && c.Token != "" {
			return c.Token, "file", nil
		}
	}
	return "", "", err
}

// hubFor dựng client cho lệnh cần đăng nhập; chưa đăng nhập thì đã in lỗi và trả mã thoát.
func (a *app) hubFor() (*hubClient, int) {
	hub, token, err := a.credentials()
	if err != nil {
		return nil, a.errorf(exitFailed, "%v", err)
	}
	if token == "" {
		return nil, a.errorf(exitUsage, "Chưa đăng nhập hub. Chạy hive login.")
	}
	return &hubClient{http: a.httpClient(), base: hub, token: token}, exitOK
}

func (a *app) httpClient() *http.Client {
	if a.http != nil {
		return a.http
	}
	return hubtls.NewClient(hubTimeout)
}

// hubFail đổi lỗi gọi hub ra mã thoát; token hết hiệu lực là thiếu điều kiện (đăng nhập lại), không phải lỗi phiên.
func (a *app) hubFail(err error) int {
	var he *hubError
	switch {
	case errors.Is(err, errUnauthorized):
		return a.errorf(exitUsage, "Token hết hạn hoặc đã bị thu hồi. Chạy hive login.")
	case errors.As(err, &he) && he.Status == http.StatusForbidden:
		return a.errorf(exitDenied, "%s", he.Error())
	}
	return a.errorf(exitFailed, "%v", err)
}

// defaultHub: HIVE_HUB_URL, hub của lần đăng nhập trước, rồi hub mà hive-worker trên máy đã đăng ký.
func (a *app) defaultHub() string {
	if v := a.getenv("HIVE_HUB_URL"); v != "" {
		return v
	}
	if c, _, err := a.loadCLIConfig(); err == nil && c.HubURL != "" {
		return c.HubURL
	}
	if p, err := config.DefaultPath(); err == nil {
		if c, err := config.Load(p); err == nil {
			return c.HubURL
		}
	}
	return ""
}

func (a *app) login(args []string) int {
	fs := newFlagSet("login", a.stderr)
	hubFlag := fs.String("hub", "", "địa chỉ hub (mặc định: hub của hive-worker trên máy)")
	withToken := fs.Bool("with-token", false, "đọc token cá nhân (hive_pat_…) từ stdin thay vì mở trình duyệt")
	noBrowser := fs.Bool("no-browser", false, "chỉ in địa chỉ đăng nhập, không tự mở trình duyệt")
	pos, err := parseInterspersed(fs, args)
	if err != nil {
		return exitUsage
	}
	if len(pos) > 0 {
		return a.errorf(exitUsage, "Thừa đối số %q.", pos[0])
	}
	raw := *hubFlag
	if raw == "" {
		raw = a.defaultHub()
	}
	if raw == "" {
		return a.errorf(exitUsage, "Chưa biết hub nào. Chạy hive login --hub https://<địa chỉ hub>.")
	}
	hub, err := normalizeHub(raw)
	if err != nil {
		return a.errorf(exitUsage, "%v", err)
	}
	var token string
	if *withToken {
		line, err := bufio.NewReader(a.stdin).ReadString('\n')
		if err != nil && line == "" {
			return a.errorf(exitUsage, "Không đọc được token từ stdin: echo $TOKEN | hive login --with-token.")
		}
		token = strings.TrimSpace(line)
		if !validPAT(token) {
			return a.errorf(exitUsage, "Token không đúng dạng hive_pat_…; tạo token cá nhân trong Cài đặt → Token trên web.")
		}
	} else {
		token, err = a.browserLogin(hub, !*noBrowser)
		if err != nil {
			return a.hubFail(err)
		}
	}
	c := &hubClient{http: a.httpClient(), base: hub, token: token}
	who, err := c.me()
	if err != nil {
		return a.hubFail(err)
	}
	if code := a.storeToken(hub, token, &who); code != exitOK {
		return code
	}
	fmt.Fprintf(a.stdout, "Đã đăng nhập %s: %s (%s).\n", hub, who.Name, who.Email)
	return exitOK
}

func (a *app) storeToken(hub, token string, who *me) int {
	source, err := a.saveLogin(hub, token, who)
	if err != nil {
		return a.errorf(exitFailed, "%v", err)
	}
	if source == "file" {
		fmt.Fprintln(a.stderr, "hive: Không dùng được keychain; token lưu trong file cấu hình, chỉ tài khoản của bạn đọc được.")
	}
	return exitOK
}

func (a *app) saveToken(hub, token string) (string, error) { return a.saveLogin(hub, token, nil) }

// saveLogin ghi token và danh tính. Không biết danh tính (`hive auth store` của app desktop) thì chỉ giữ danh tính cũ khi
// token không đổi: token khác có thể là người khác, và mục ghi dưới tên người cũ thì không được gửi bằng token mới.
func (a *app) saveLogin(hub, token string, who *me) (string, error) {
	prev, path, err := a.loadCLIConfig()
	if err != nil && path == "" {
		return "", errors.New("không tìm được cấu hình đăng nhập")
	}
	cfg := cliConfig{HubURL: hub}
	if who != nil {
		cfg.UserID, cfg.Email = who.ID, who.Email
		if m := patOrg.FindStringSubmatch(token); m != nil {
			cfg.OrgID = m[1]
		}
	} else if prevHub, _ := normalizeHub(prev.HubURL); prevHub == hub && prev.UserID != "" {
		if old, _, _ := a.readToken(hub); old == token {
			cfg.UserID, cfg.OrgID, cfg.Email = prev.UserID, prev.OrgID, prev.Email
		}
	}
	source := "keychain"
	if kerr := a.keyring.Set(keyringService, hub, token); kerr != nil {
		// Token cũ còn đọc được sẽ che token mới trong file vì thứ tự ưu tiên keychain.
		if previous, err := a.keyring.Get(keyringService, hub); err == nil && previous != "" {
			if previous != token {
				return "", errors.New("không cập nhật được token trong keychain")
			}
		} else {
			cfg.Token = token
			source = "file"
		}
	}
	if err := saveCLIConfig(path, cfg); err != nil {
		return "", errors.New("không ghi được cấu hình đăng nhập")
	}
	return source, nil
}

func (a *app) deleteToken(hub string) error {
	c, path, err := a.loadCLIConfig()
	if err != nil {
		return errors.New("không đọc được cấu hình đăng nhập")
	}
	var keyringErr error
	if err := a.keyring.Delete(keyringService, hub); err != nil && !errors.Is(err, keyring.ErrNotFound) {
		keyringErr = errors.New("không xoá được token trong keychain")
	}
	storedHub, _ := normalizeHub(c.HubURL)
	if storedHub == hub {
		// Giữ hub để lần đăng nhập sau khỏi nhập lại; không đụng token của hub khác.
		c.Token = ""
		if err := saveCLIConfig(path, c); err != nil {
			return errors.New("không ghi được cấu hình đăng nhập")
		}
	}
	return keyringErr
}

func (a *app) logout(args []string) int {
	fs := newFlagSet("logout", a.stderr)
	choice := fs.String("outbox", "", "mục chưa tới hub: send (gửi trước), keep (giữ lại), drop (bỏ)")
	pos, err := parseInterspersed(fs, args)
	if err != nil || len(pos) > 0 || !validLogoutChoice(*choice) {
		return a.errorf(exitUsage, "%s", logoutUsage)
	}
	c, _, err := a.loadCLIConfig()
	if err != nil {
		return a.errorf(exitFailed, "%v", err)
	}
	if c.HubURL == "" {
		fmt.Fprintln(a.stdout, "Chưa đăng nhập hub nào.")
		return exitOK
	}
	if code := a.logoutOutbox(c.HubURL, *choice); code != exitOK {
		return code
	}
	if err := a.deleteToken(c.HubURL); err != nil {
		return a.errorf(exitFailed, "%v", err)
	}
	// Token cá nhân không tự thu hồi được chính nó trên hub (chặn ở hub), nên chỉ xoá trên máy.
	fmt.Fprintf(a.stdout, "Đã đăng xuất %s trên máy này (cả app xDev Hive dùng chung token). Thu hồi token trên web nếu bị lộ.\n", c.HubURL)
	return exitOK
}

func (a *app) whoami(args []string) int {
	if len(args) > 0 {
		return a.errorf(exitUsage, "Cách dùng: hive whoami.")
	}
	c, code := a.hubFor()
	if code != exitOK {
		return code
	}
	who, err := c.me()
	if err != nil {
		return a.hubFail(err)
	}
	fmt.Fprintf(a.stdout, "%s (%s) trên %s\n", who.Name, who.Email, c.base)
	return exitOK
}

// ---- Luồng trình duyệt (RFC 8252 + PKCE), như app desktop (browser_login.rs) ----

func randomB64(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// machineName giống tên worker đăng ký để trang đồng ý hiện đúng máy; chỉ để người dùng nhận ra, hub không kiểm.
func machineName(hostname string) string {
	if p, err := config.DefaultPath(); err == nil {
		if c, err := config.Load(p); err == nil && c.MachineID != "" {
			return c.MachineID
		}
	}
	name := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(hostname), ".local"))
	var b strings.Builder
	dash := false
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			dash = false
		} else if !dash {
			b.WriteByte('-')
			dash = true
		}
	}
	out := strings.Trim(b.String(), "-")
	if len(out) > 63 {
		out = strings.TrimRight(out[:63], "-")
	}
	if out == "" {
		return "worker"
	}
	return out
}

func connectURL(hub string, port int, state, challenge, machine string) string {
	q := url.Values{}
	q.Set("port", fmt.Sprint(port))
	q.Set("state", state)
	q.Set("challenge", challenge)
	q.Set("machine", machine)
	q.Set("purpose", "cli")
	return hub + "/desktop/connect?" + q.Encode()
}

const (
	pageOK     = "Đã đăng nhập lệnh hive. Bạn có thể đóng tab này và quay lại terminal."
	pageDenied = "Đã từ chối. Lệnh hive không được đăng nhập."
	pageError  = "Không đăng nhập được. Quay lại terminal để thử lại."
)

type callback struct {
	code string
	err  error
}

func (a *app) browserLogin(hub string, open bool) (string, error) {
	// Chỉ 127.0.0.1, không bao giờ 0.0.0.0, để máy khác trong mạng không gọi vào được.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", fmt.Errorf("không mở được cổng tạm để đăng nhập: %w", err)
	}
	defer ln.Close()
	verifier, state := randomB64(32), randomB64(24)
	host, _ := os.Hostname()
	link := connectURL(hub, ln.Addr().(*net.TCPAddr).Port, state, pkceChallenge(verifier), machineName(host))

	got := make(chan callback, 1)
	srv := &http.Server{ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/callback" {
			http.NotFound(w, r)
			return
		}
		q := r.URL.Query()
		if q.Get("state") != state {
			// State khác là request lạ (trang khác gọi vào cổng này), không phải câu trả lời của hub: chờ tiếp.
			respondPage(w, http.StatusBadRequest, pageError+" (phản hồi không khớp phiên đăng nhập này)")
			return
		}
		var cb callback
		switch {
		case q.Get("error") != "":
			cb.err = errors.New("bạn đã từ chối đăng nhập trên trình duyệt")
			respondPage(w, http.StatusOK, pageDenied)
		case q.Get("code") == "":
			cb.err = errors.New("hub không trả mã đăng nhập")
			respondPage(w, http.StatusBadRequest, pageError)
		default:
			cb.code = q.Get("code")
			respondPage(w, http.StatusOK, pageOK)
		}
		select {
		case got <- cb:
		default:
		}
	})}
	go func() { _ = srv.Serve(ln) }()
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()

	fmt.Fprintf(a.stderr, "Mở địa chỉ sau trên trình duyệt để đăng nhập (chờ %d phút):\n  %s\n", int(loginWait.Minutes()), link)
	if open {
		if err := a.openURL(link); err != nil {
			fmt.Fprintf(a.stderr, "hive: Không tự mở được trình duyệt (%v); chép địa chỉ trên vào trình duyệt.\n", err)
		}
	}
	var cb callback
	select {
	case cb = <-got:
	case <-time.After(a.loginTimeout()):
		return "", fmt.Errorf("quá %d phút chưa đăng nhập xong trên trình duyệt; chạy lại hive login", int(loginWait.Minutes()))
	}
	if cb.err != nil {
		return "", cb.err
	}
	return a.exchange(hub, cb.code, verifier)
}

func (a *app) loginTimeout() time.Duration {
	if a.loginWait > 0 {
		return a.loginWait
	}
	return loginWait
}

func respondPage(w http.ResponseWriter, status int, text string) {
	w.Header().Set("content-type", "text/html; charset=utf-8")
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(status)
	fmt.Fprintf(w, `<!doctype html><meta charset=utf-8><title>xDev Hive</title><body style="font:16px system-ui;margin:20vh auto;max-width:28em;text-align:center">%s</body>`, html.EscapeString(text))
}

// exchange đổi mã một lần (kèm verifier) lấy token cá nhân; token không bao giờ đi qua URL hay trình duyệt.
func (a *app) exchange(hub, code, verifier string) (string, error) {
	body, _ := json.Marshal(map[string]string{"code": code, "verifier": verifier})
	var out struct {
		Purpose       string `json:"purpose"`
		PersonalToken string `json:"personalToken"`
	}
	c := &hubClient{http: a.httpClient(), base: hub}
	if err := c.do(http.MethodPost, "/v1/desktop/connect/exchange", strings.NewReader(string(body)), &out); err != nil {
		return "", err
	}
	if !validPAT(out.PersonalToken) {
		return "", errors.New("hub trả token không đúng dạng; hub có thể là bản cũ chưa hỗ trợ hive login")
	}
	return out.PersonalToken, nil
}

// Không qua procattr: lệnh mở trình duyệt không có cửa sổ console, còn HideWindow có thể làm trình duyệt mở ẩn.
func openBrowser(link string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", link).Start() // procattr:allow
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", link).Start() // procattr:allow
	}
	return exec.Command("xdg-open", link).Start() // procattr:allow
}
