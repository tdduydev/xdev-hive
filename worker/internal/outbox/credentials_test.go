package outbox

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zalando/go-keyring"

	"github.com/tdduydev/xdev-hive/worker/internal/hubclient"
)

const (
	credHub   = "https://hive.example.test"
	credOrg   = "11111111-2222-4333-8444-555555555555"
	credUser  = "u-an"
	credToken = "hive_pat_" + credOrg + "_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
)

// credFP là dấu vân tay `hive login` ghi cạnh danh tính của credToken.
var credFP = TokenFingerprint(credToken)

type fakeKeyring map[string]string

func (k fakeKeyring) Get(service, user string) (string, error) {
	if v, ok := k[service+"|"+user]; ok {
		return v, nil
	}
	return "", keyring.ErrNotFound
}

func writeLogin(t *testing.T, l CLILogin) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "hive.json")
	b, err := json.Marshal(l)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func signedIn(t *testing.T, l CLILogin) *Credentials {
	t.Helper()
	return &Credentials{Path: writeLogin(t, l), Keyring: fakeKeyring{KeyringService + "|" + credHub: credToken}}
}

func holdReason(err error) string {
	var h *HoldError
	if errors.As(err, &h) {
		return h.Reason
	}
	return ""
}

func TestCurrentIdentity(t *testing.T) {
	ctx := context.Background()
	missing := &Credentials{Path: filepath.Join(t.TempDir(), "hive.json"), Keyring: fakeKeyring{}}
	var oe *Error
	if _, err := missing.Current(ctx); !errors.As(err, &oe) || oe.Code != "NOT_SIGNED_IN" {
		t.Fatalf("chưa có hive.json: %v", err)
	}
	loggedOut := &Credentials{Path: writeLogin(t, CLILogin{HubURL: credHub, UserID: credUser}), Keyring: fakeKeyring{}}
	if _, err := loggedOut.Current(ctx); !errors.As(err, &oe) || oe.Code != "NOT_SIGNED_IN" {
		t.Fatalf("đã đăng xuất: %v", err)
	}
	c := signedIn(t, CLILogin{HubURL: credHub + "/", UserID: credUser, Email: "an@example.test", TokenSHA256: credFP})
	id, err := c.Current(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want := Identity{HubURL: credHub, OrgID: credOrg, UserID: credUser, Email: "an@example.test"}
	if id != want {
		t.Fatalf("danh tính %+v, muốn %+v", id, want)
	}
}

func TestTokenChecksIdentity(t *testing.T) {
	ctx := context.Background()
	c := signedIn(t, CLILogin{HubURL: credHub, UserID: credUser, Email: "an@example.test", TokenSHA256: credFP})
	me := Identity{HubURL: credHub, OrgID: credOrg, UserID: credUser}
	if tok, err := c.Token(ctx, me); err != nil || tok != credToken {
		t.Fatalf("đúng người: %q, %v", tok, err)
	}
	other := Identity{HubURL: credHub, OrgID: credOrg, UserID: "u-binh", Email: "binh@example.test"}
	_, err := c.Token(ctx, other)
	if holdReason(err) != HeldIdentityMismatch || !strings.Contains(err.Error(), "binh@example.test") {
		t.Fatalf("khác người: %v", err)
	}
	otherOrg := me
	otherOrg.OrgID = "99999999-2222-4333-8444-555555555555"
	if _, err := c.Token(ctx, otherOrg); holdReason(err) != HeldIdentityMismatch {
		t.Fatalf("khác tổ chức: %v", err)
	}
	otherHub := me
	otherHub.HubURL = "https://other.example.test"
	if _, err := c.Token(ctx, otherHub); holdReason(err) != HeldLoginRequired {
		t.Fatalf("khác hub: %v", err)
	}
	loggedOut := &Credentials{Path: writeLogin(t, CLILogin{HubURL: credHub, UserID: credUser}), Keyring: fakeKeyring{}}
	if _, err := loggedOut.Token(ctx, me); holdReason(err) != HeldLoginRequired {
		t.Fatalf("đã đăng xuất: %v", err)
	}
	// Máy không có keychain: token nằm trong hive.json.
	file := &Credentials{Path: writeLogin(t, CLILogin{HubURL: credHub, UserID: credUser, Token: credToken, TokenSHA256: credFP}), Keyring: fakeKeyring{}}
	if tok, err := file.Token(ctx, me); err != nil || tok != credToken {
		t.Fatalf("token trong file: %q, %v", tok, err)
	}
}

func TestResolveWhenLoginHasNoUser(t *testing.T) {
	ctx := context.Background()
	calls := 0
	c := signedIn(t, CLILogin{HubURL: credHub})
	c.Resolve = func(_ context.Context, hub, token string) (Me, error) {
		calls++
		if hub != credHub || token != credToken {
			t.Errorf("hỏi hub %s bằng %q", hub, token)
		}
		return Me{ID: credUser, Email: "an@example.test"}, nil
	}
	id, err := c.Current(ctx)
	if err != nil || id.UserID != credUser || id.Email != "an@example.test" {
		t.Fatalf("danh tính %+v, %v", id, err)
	}
	if _, err := c.Token(ctx, id); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Token(ctx, Identity{HubURL: credHub, UserID: "u-binh"}); holdReason(err) != HeldIdentityMismatch {
		t.Fatalf("khác người: %v", err)
	}
	if calls != 1 {
		t.Fatalf("hỏi hub %d lần, muốn 1", calls)
	}
	offline := signedIn(t, CLILogin{HubURL: credHub})
	offline.Resolve = func(context.Context, string, string) (Me, error) { return Me{}, errors.New("dial tcp: refused") }
	if _, err := offline.Token(ctx, id); err == nil || holdReason(err) != "" {
		t.Fatalf("hub vắng phải thử lại, không giữ: %v", err)
	}
	none := signedIn(t, CLILogin{HubURL: credHub})
	var oe *Error
	if _, err := none.Current(ctx); !errors.As(err, &oe) || oe.Code != "NOT_SIGNED_IN" {
		t.Fatalf("không có Resolve: %v", err)
	}
}

func TestStoredIdentityNeedsMatchingToken(t *testing.T) {
	ctx := context.Background()
	an := Identity{HubURL: credHub, OrgID: credOrg, UserID: credUser, Email: "an@example.test"}
	for name, fp := range map[string]string{"token khác": TokenFingerprint("hive_pat_cu"), "bản cũ không có dấu vân tay": ""} {
		t.Run(name, func(t *testing.T) {
			// hive.json ghi An, nhưng keychain đã bị ghi thẳng token của Bình: phải hỏi hub, không tin tên đã lưu.
			c := signedIn(t, CLILogin{HubURL: credHub, UserID: credUser, Email: "an@example.test", TokenSHA256: fp})
			c.Resolve = func(context.Context, string, string) (Me, error) {
				return Me{ID: "u-binh", Email: "binh@example.test"}, nil
			}
			if id, err := c.Current(ctx); err != nil || id.UserID != "u-binh" {
				t.Fatalf("mục mới phải ghi tên người của token: %+v, %v", id, err)
			}
			if _, err := c.Token(ctx, an); holdReason(err) != HeldIdentityMismatch {
				t.Fatalf("mục của An không được gửi bằng token của Bình: %v", err)
			}
		})
	}
	// Hub vắng: vẫn xếp hàng dưới tên đã lưu, nhưng chỉ gửi khi hỏi được hub token là của ai.
	offline := signedIn(t, CLILogin{HubURL: credHub, UserID: credUser, Email: "an@example.test", TokenSHA256: TokenFingerprint("hive_pat_cu")})
	offline.Resolve = func(context.Context, string, string) (Me, error) { return Me{}, errors.New("dial tcp: refused") }
	if id, err := offline.Current(ctx); err != nil || id != an {
		t.Fatalf("hub vắng phải xếp hàng dưới tên đã lưu: %+v, %v", id, err)
	}
	if tok, err := offline.Token(ctx, an); err == nil || tok != "" || holdReason(err) != "" {
		t.Fatalf("hub vắng thì thử lại sau, không gửi: %q, %v", tok, err)
	}
}

func TestMeResolver(t *testing.T) {
	status := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/me" || r.Header.Get("Authorization") != "Bearer "+credToken || r.Header.Get("X-Hive-Org") != credOrg {
			t.Errorf("yêu cầu %s, header %v", r.URL.Path, r.Header)
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"id":"` + credUser + `","name":"An","email":"an@example.test"}`))
	}))
	defer srv.Close()
	resolve := MeResolver(srv.Client())
	ctx := context.Background()
	me, err := resolve(ctx, srv.URL+"/", credToken)
	if err != nil || me.ID != credUser || me.Email != "an@example.test" {
		t.Fatalf("me %+v, %v", me, err)
	}
	status = http.StatusUnauthorized
	if _, err := resolve(ctx, srv.URL, credToken); holdReason(err) != HeldLoginRequired {
		t.Fatalf("401: %v", err)
	}
	status = http.StatusBadRequest
	var se *hubclient.StatusError
	if _, err := resolve(ctx, srv.URL, credToken); !errors.As(err, &se) || permanent(se.Status) {
		t.Fatalf("400 của /me phải thử lại: %v", err)
	}
}
