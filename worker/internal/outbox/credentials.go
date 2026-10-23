package outbox

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync"

	"github.com/zalando/go-keyring"

	"github.com/tdduydev/xdev-hive/worker/internal/hubclient"
)

// Đăng nhập của người dùng là của `hive login` (specs/010 D12): hive.json ghi hub và danh tính, token nằm trong keychain
// mục `dev.xdev.hive` tên là địa chỉ hub, máy không có keychain thì nằm trong hive.json. Hộp thư đi chỉ đọc, không ghi:
// đăng nhập và đăng xuất vẫn là việc của `hive`.

const (
	KeyringService = "dev.xdev.hive"
	// CLIConfigEnv ghi đè đường dẫn hive.json, cùng biến với `hive`.
	CLIConfigEnv = "HIVE_CLI_CONFIG"
)

// patOrg lấy tổ chức trong token cá nhân (`hive_pat_<org>_<bí mật>`), như `hive`.
var patOrg = regexp.MustCompile(`^hive_pat_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_[A-Za-z0-9_-]{43}$`)

// Keyring là phần keychain hộp thư đi cần; test thay bằng bản giả.
type Keyring interface {
	Get(service, user string) (string, error)
}

type osKeyring struct{}

func (osKeyring) Get(s, u string) (string, error) { return keyring.Get(s, u) }

// CLILogin là phần hive.json hộp thư đi đọc. Tên trường trùng `cliConfig` của `hive`.
type CLILogin struct {
	HubURL string `json:"hubUrl,omitempty"`
	Token  string `json:"token,omitempty"`
	UserID string `json:"userId,omitempty"`
	OrgID  string `json:"orgId,omitempty"`
	Email  string `json:"email,omitempty"`
}

// Me là danh tính hub trả cho token (`GET /api/v1/me`).
type Me struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

// Credentials đọc người đang đăng nhập trên máy. Resolve hỏi hub khi hive.json chưa có `userId` (token lưu bằng `hive
// auth store` của app desktop, hay đăng nhập từ bản cũ); kết quả nhớ theo token nên mỗi token chỉ hỏi một lần.
type Credentials struct {
	Path    string
	Keyring Keyring
	Resolve func(ctx context.Context, hub, token string) (Me, error)

	mu       sync.Mutex
	resolved map[string]Me
}

// DefaultCLIConfigPath là hive.json cạnh worker.json, hoặc CLIConfigEnv.
func DefaultCLIConfigPath() (string, error) {
	if p := os.Getenv(CLIConfigEnv); p != "" {
		return p, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("không tìm được thư mục cấu hình: %w", err)
	}
	return filepath.Join(dir, "xdev-hive", "hive.json"), nil
}

func (c *Credentials) load() (CLILogin, error) {
	var l CLILogin
	path := c.Path
	if path == "" {
		p, err := DefaultCLIConfigPath()
		if err != nil {
			return l, err
		}
		path = p
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return l, nil
	}
	if err != nil {
		return l, fmt.Errorf("không đọc được cấu hình đăng nhập: %w", err)
	}
	if err := json.Unmarshal(data, &l); err != nil {
		return l, fmt.Errorf("file %s hỏng: %w", path, err)
	}
	l.HubURL = normalizeHub(l.HubURL)
	return l, nil
}

// token đọc keychain trước, như `hive`; file chỉ dùng khi keychain không có.
func (c *Credentials) token(l CLILogin) string {
	kr := c.Keyring
	if kr == nil {
		kr = osKeyring{}
	}
	if t, err := kr.Get(KeyringService, l.HubURL); err == nil && t != "" {
		return t
	}
	return l.Token
}

// identity ghép danh tính của lần đăng nhập. Lỗi mạng khi hỏi hub được trả nguyên để bên gọi coi là hub vắng.
func (c *Credentials) identity(ctx context.Context, l CLILogin, token string) (Identity, error) {
	id := Identity{HubURL: l.HubURL, OrgID: l.OrgID, UserID: l.UserID, Email: l.Email}
	if m := patOrg.FindStringSubmatch(token); m != nil {
		id.OrgID = m[1]
	}
	if id.UserID != "" {
		return id, nil
	}
	if c.Resolve == nil {
		return Identity{}, ErrLoginRequired
	}
	sum := sha256.Sum256([]byte(token))
	fp := hex.EncodeToString(sum[:])
	c.mu.Lock()
	me, ok := c.resolved[fp]
	c.mu.Unlock()
	if !ok {
		var err error
		if me, err = c.Resolve(ctx, l.HubURL, token); err != nil {
			return Identity{}, err
		}
		if me.ID == "" {
			return Identity{}, ErrLoginRequired
		}
		c.mu.Lock()
		if c.resolved == nil {
			c.resolved = map[string]Me{}
		}
		c.resolved[fp] = me
		c.mu.Unlock()
	}
	id.UserID, id.Email = me.ID, me.Email
	return id, nil
}

// Current là danh tính ghi vào mục mới. Chưa đăng nhập thì trả lỗi NOT_SIGNED_IN như Submit.
func (c *Credentials) Current(ctx context.Context) (Identity, error) {
	l, err := c.load()
	if err != nil {
		return Identity{}, err
	}
	token := ""
	if l.HubURL != "" {
		token = c.token(l)
	}
	if token == "" {
		return Identity{}, &Error{Code: "NOT_SIGNED_IN", Message: "Chưa đăng nhập hub; chạy `hive login` trước."}
	}
	id, err := c.identity(ctx, l, token)
	var hold *HoldError
	if errors.As(err, &hold) {
		return Identity{}, &Error{Code: "NOT_SIGNED_IN", Message: hold.Message}
	}
	return id, err
}

// Token là UserSender.Token: chỉ trả token khi người đang đăng nhập đúng là người tạo mục (spec 027 FR-018). Đổi người
// thì giữ mục (`identity_mismatch`) chứ không gửi thay, vì ghi của A dưới tên B là sai dấu vết; A đăng nhập lại thì gửi.
func (c *Credentials) Token(ctx context.Context, want Identity) (string, error) {
	l, err := c.load()
	if err != nil {
		return "", &HoldError{Reason: HeldLoginRequired, Message: err.Error()}
	}
	hub := normalizeHub(want.HubURL)
	if l.HubURL != hub {
		return "", &HoldError{Reason: HeldLoginRequired, Message: fmt.Sprintf("Máy chưa đăng nhập hub %s; chạy `hive login --hub %s`.", hub, hub)}
	}
	token := c.token(l)
	if token == "" {
		return "", ErrLoginRequired
	}
	got, err := c.identity(ctx, l, token)
	if err != nil {
		return "", err
	}
	if got.UserID != want.UserID || (want.OrgID != "" && got.OrgID != want.OrgID) {
		return "", &HoldError{Reason: HeldIdentityMismatch, Message: mismatchMessage(want, got)}
	}
	return token, nil
}

func mismatchMessage(want, got Identity) string {
	who := func(id Identity) string {
		if id.Email != "" {
			return id.Email
		}
		return "người khác"
	}
	if want.UserID == got.UserID {
		return "Mục tạo ở tổ chức khác với token đang đăng nhập; đăng nhập lại đúng tổ chức hoặc bỏ mục."
	}
	return fmt.Sprintf("Mục của %s, máy đang đăng nhập %s; đăng nhập lại đúng người hoặc bỏ mục.", who(want), who(got))
}

// MeResolver hỏi `GET /api/v1/me` bằng token. 401 là token hết hiệu lực nên giữ mục; lỗi khác thì thử lại.
func MeResolver(hc *http.Client) func(ctx context.Context, hub, token string) (Me, error) {
	if hc == nil {
		hc = http.DefaultClient
	}
	return func(ctx context.Context, hub, token string) (Me, error) {
		var me Me
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, normalizeHub(hub)+"/api/v1/me", nil)
		if err != nil {
			return me, err
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Authorization", "Bearer "+token)
		if m := patOrg.FindStringSubmatch(token); m != nil {
			req.Header.Set("X-Hive-Org", m[1])
		}
		res, err := hc.Do(req)
		if err != nil {
			return me, fmt.Errorf("không gọi được hub %s: %w", normalizeHub(hub), err)
		}
		defer res.Body.Close()
		body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
		if err != nil {
			return me, fmt.Errorf("không đọc được trả lời của hub: %w", err)
		}
		if res.StatusCode == http.StatusUnauthorized {
			return me, &HoldError{Reason: HeldLoginRequired, Message: "Token hết hạn hoặc đã bị thu hồi; chạy `hive login`."}
		}
		if res.StatusCode/100 != 2 {
			// Mã 4xx của /me không nói gì về mục; báo 502 để mục được thử lại chứ không bị từ chối.
			return me, &hubclient.StatusError{Status: http.StatusBadGateway, Message: fmt.Sprintf("hub trả %d cho /api/v1/me: %s", res.StatusCode, clip(body))}
		}
		if err := json.Unmarshal(body, &me); err != nil {
			return me, &hubclient.StatusError{Status: http.StatusBadGateway, Message: "trả lời /me của hub không đọc được"}
		}
		return me, nil
	}
}
