package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/config"
	"github.com/tdduydev/xdev-hive/worker/internal/machinekey"
)

// noKeyring giả máy không có keychain, để test không ghi vào keychain thật và khoá luôn nằm trong file tạm.
type noKeyring struct{}

var errNoKeyring = errors.New("không có keychain")

func (noKeyring) Get(string, string) (string, error) { return "", errNoKeyring }
func (noKeyring) Set(string, string, string) error   { return errNoKeyring }
func (noKeyring) Delete(string, string) error        { return errNoKeyring }

func TestMain(m *testing.M) {
	newKeyStore = func(configPath string) *machinekey.Store {
		s := machinekey.NewStore(configPath)
		s.Keyring = noKeyring{}
		return s
	}
	os.Exit(m.Run())
}

const testMachineUUID = "00000000-0000-4000-8000-000000000001"

// keyHub là hub giả có đủ route khoá máy: kiểm chữ ký bằng khoá công khai nhận lúc đăng ký hay lúc gửi khoá.
type keyHub struct {
	t         *testing.T
	srv       *httptest.Server
	publicKey string
	register  map[string]any
	keyBearer string
	tokens    int
}

func newKeyHub(t *testing.T) *keyHub {
	h := &keyHub{t: t}
	h.srv = httptest.NewServer(http.HandlerFunc(h.serve))
	t.Cleanup(h.srv.Close)
	return h
}

func (h *keyHub) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/api/v1/worker/register":
		_ = json.NewDecoder(r.Body).Decode(&h.register)
		h.publicKey, _ = h.register["publicKey"].(string)
		_, _ = w.Write([]byte(`{"id":"` + testMachineUUID + `","orgId":"00000000-0000-4000-8000-000000000002","teamId":"00000000-0000-4000-8000-000000000003","machineId":"may-test","machineToken":"hwm_secret"}`))
	case "/api/v1/worker/key":
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		h.keyBearer, h.publicKey = r.Header.Get("Authorization"), body["publicKey"]
		_, _ = w.Write([]byte(`{"machineId":"` + testMachineUUID + `","registeredAt":"2026-10-23T00:00:00Z"}`))
	case "/api/v1/worker/challenge":
		_, _ = w.Write([]byte(`{"nonce":"n-1","expiresAt":"2026-10-23T00:01:00Z"}`))
	case "/api/v1/worker/token":
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		pub, _ := base64.RawURLEncoding.DecodeString(h.publicKey)
		sig, _ := base64.RawURLEncoding.DecodeString(body["signature"])
		if len(pub) != ed25519.PublicKeySize || body["machineId"] != testMachineUUID || !ed25519.Verify(pub, []byte(machinekey.Message(h.srv.URL, testMachineUUID, body["nonce"])), sig) {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"message":"Máy không xác thực được."}`))
			return
		}
		h.tokens++
		_, _ = w.Write([]byte(`{"accessToken":"hwa_test","expiresAt":"` + time.Now().Add(15*time.Minute).UTC().Format(time.RFC3339Nano) + `"}`))
	default:
		http.NotFound(w, r)
	}
}

func TestRegisterWithKeyKeepsNoMachineToken(t *testing.T) {
	h := newKeyHub(t)
	path := filepath.Join(t.TempDir(), "worker.json")
	var stdout, stderr bytes.Buffer
	if code := register([]string{"--hub", h.srv.URL, "--token", "hwr_abc", "--machine", "may-test", "--config", path}, &stdout, &stderr); code != 0 {
		t.Fatalf("mã thoát %d, stderr: %s", code, stderr.String())
	}
	if len(h.publicKey) != 43 || h.register["keyStorage"] != machinekey.StorageFile {
		t.Fatalf("body đăng ký = %v", h.register)
	}
	if h.tokens != 1 {
		t.Fatalf("đổi token %d lần, cần 1", h.tokens)
	}
	data, _ := os.ReadFile(path)
	if strings.Contains(string(data), "hwm_") {
		t.Fatalf("worker.json còn machine token: %s", data)
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ID != testMachineUUID || cfg.KeyStorage != machinekey.StorageFile || !cfg.Registered() {
		t.Fatalf("cấu hình = %+v", cfg)
	}
	token, err := hubBearer(context.Background(), &cfg)
	if err != nil || token != "hwa_test" {
		t.Fatalf("hubBearer = %q, %v", token, err)
	}
}

func TestRegisterReusesKey(t *testing.T) {
	h := newKeyHub(t)
	path := filepath.Join(t.TempDir(), "worker.json")
	var stdout, stderr bytes.Buffer
	args := []string{"--hub", h.srv.URL, "--token", "hwr_abc", "--machine", "may-test", "--config", path}
	if code := register(args, &stdout, &stderr); code != 0 {
		t.Fatalf("mã thoát %d, stderr: %s", code, stderr.String())
	}
	first := h.publicKey
	if code := register(args, &stdout, &stderr); code != 0 {
		t.Fatalf("mã thoát %d, stderr: %s", code, stderr.String())
	}
	if h.publicKey != first {
		t.Fatal("đăng ký lại phải dùng lại khoá cũ")
	}
}

func TestMachineAuthMigratesLegacyToken(t *testing.T) {
	h := newKeyHub(t)
	path := filepath.Join(t.TempDir(), "worker.json")
	if err := config.Save(path, config.Config{HubURL: h.srv.URL, MachineID: "may-test", MachineToken: "hwm_old"}); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	ts, err := machineAuth(context.Background(), &cfg)
	if err != nil || ts == nil {
		t.Fatalf("machineAuth = %v, %v", ts, err)
	}
	if h.keyBearer != "Bearer hwm_old" {
		t.Fatalf("gửi khoá với Authorization %q", h.keyBearer)
	}
	saved, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if saved.MachineToken != "" || saved.ID != testMachineUUID || saved.KeyStorage != machinekey.StorageFile {
		t.Fatalf("cấu hình sau khi gửi khoá = %+v", saved)
	}
	if token, _, err := ts.Token(context.Background(), false); err != nil || token != "hwa_test" {
		t.Fatalf("Token = %q, %v", token, err)
	}
}

func TestMachineAuthKeepsTokenOnOldHub(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	path := filepath.Join(t.TempDir(), "worker.json")
	want := config.Config{HubURL: srv.URL, MachineID: "may-test", MachineToken: "hwm_old"}
	if err := config.Save(path, want); err != nil {
		t.Fatal(err)
	}
	cfg, _ := config.Load(path)
	ts, err := machineAuth(context.Background(), &cfg)
	if err != nil || ts != nil {
		t.Fatalf("hub cũ: machineAuth = %v, %v", ts, err)
	}
	if token, err := hubBearer(context.Background(), &cfg); err != nil || token != "hwm_old" {
		t.Fatalf("hubBearer = %q, %v", token, err)
	}
	saved, _ := config.Load(path)
	want.Path = path
	if saved != want {
		t.Fatalf("cấu hình bị đổi: %+v", saved)
	}
}

func TestMachineAuthNeedsKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "worker.json")
	cfg := config.Config{HubURL: "https://hub.example", MachineID: "may-test", ID: testMachineUUID, KeyStorage: machinekey.StorageFile, Path: path}
	if _, err := machineAuth(context.Background(), &cfg); err == nil || !strings.Contains(err.Error(), "hive-worker register") {
		t.Fatalf("thiếu khoá: %v", err)
	}
}
