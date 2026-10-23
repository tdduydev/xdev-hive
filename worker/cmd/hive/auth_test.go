package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zalando/go-keyring"

	"github.com/tdduydev/xdev-hive/worker/internal/config"
)

func (s *syncBuffer) Reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.b.Reset()
}

const authHub = "https://hive.example.test"

func authApp(t *testing.T) *testApp {
	t.Helper()
	keyring.MockInit()
	a := loginApp(t)
	a.keyring = osKeyring{}
	// Không dùng cấu hình worker hay thư mục nhà thật của máy chạy test.
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("HIVE_WORKER_CONFIG", filepath.Join(home, "worker.json"))
	return a
}

func authRun(t *testing.T, a *testApp, code int, args ...string) authResult {
	t.Helper()
	a.out.Reset()
	a.err.Reset()
	got := a.run(append([]string{"auth"}, args...))
	if got != code {
		t.Fatalf("mã thoát = %d, cần %d; stderr = %s", got, code, a.err.String())
	}
	if strings.Contains(a.err.String(), testToken) {
		t.Fatal("token xuất hiện trong stderr")
	}
	var result authResult
	if err := json.Unmarshal([]byte(a.out.String()), &result); err != nil {
		t.Fatalf("kết quả không phải JSON: %v", err)
	}
	return result
}

func TestAuthKeychainLifecycle(t *testing.T) {
	a := authApp(t)
	a.stdin = strings.NewReader(testToken + "\r\n")
	stored := authRun(t, a, exitOK, "store", "--hub", authHub+"/", "--json")
	if stored.HubURL != authHub || stored.Source != "keychain" || !stored.Authenticated || stored.Token != "" {
		t.Fatalf("store = %+v", stored)
	}
	if got, _ := keyring.Get(keyringService, authHub); got != testToken {
		t.Fatal("token chưa vào mục dùng chung của desktop")
	}
	cfg, _, err := a.loadCLIConfig()
	if err != nil || cfg.HubURL != authHub || cfg.Token != "" {
		t.Fatal("file cấu hình phải chỉ chứa hub khi dùng được keychain")
	}
	token := authRun(t, a, exitOK, "token", "--json")
	if token.Token != testToken || token.OrgID != testOrg || token.Source != "keychain" {
		t.Fatal("token thiếu thông tin hợp đồng")
	}
	status := authRun(t, a, exitOK, "status", "--json")
	if !status.Authenticated || status.Token != "" || strings.Contains(a.out.String(), testToken) {
		t.Fatal("status phải trả metadata, không trả token")
	}
	hub, secret, err := a.credentials()
	if err != nil || hub != authHub || secret != testToken {
		t.Fatal("lệnh cũ không đọc được token do auth lưu")
	}
	authRun(t, a, exitOK, "logout", "--json")
	if _, err := keyring.Get(keyringService, authHub); !errors.Is(err, keyring.ErrNotFound) {
		t.Fatal("logout chưa xoá keychain")
	}
	authRun(t, a, exitDenied, "token", "--json")
	authRun(t, a, exitDenied, "status", "--json")
	if cfg, _, _ := a.loadCLIConfig(); cfg.HubURL != authHub || cfg.Token != "" {
		t.Fatal("logout phải giữ hub, bỏ token")
	}
}

func TestAuthReadsExistingKeychainWithoutCLIConfig(t *testing.T) {
	a := authApp(t)
	if err := keyring.Set(keyringService, authHub, testToken); err != nil {
		t.Fatal(err)
	}
	result := authRun(t, a, exitOK, "token", "--json", "--hub", authHub+"///")
	if result.Token != testToken || result.Source != "keychain" {
		t.Fatal("không đọc được mục có sẵn khi chưa có hive.json")
	}
}

func TestAuthStoreWithoutKeychainKeepsTokenOutOfFiles(t *testing.T) {
	a := authApp(t)
	a.keyring = &memKeyring{broken: true}
	a.stdin = strings.NewReader(testToken)
	a.err.Reset()
	if code := a.run([]string{"auth", "store", "--hub", authHub, "--json"}); code != exitFailed {
		t.Fatalf("không có keychain phải báo lỗi, nhận %d", code)
	}
	if !strings.Contains(a.err.String(), "HIVE_TOKEN") || strings.Contains(a.err.String(), testToken) {
		t.Fatalf("phải hướng dẫn HIVE_TOKEN, không lộ token: %q", a.err.String())
	}
	_, path, _ := a.loadCLIConfig()
	if data, err := os.ReadFile(path); err == nil && strings.Contains(string(data), testToken) {
		t.Fatal("token không được ghi ra hive.json")
	}
	a.getenv = func(k string) string { return map[string]string{"HIVE_TOKEN": testToken}[k] }
	if r := authRun(t, a, exitOK, "token", "--hub", authHub, "--json"); r.Token != testToken || r.Source != "env" {
		t.Fatalf("token của phiên = %+v", r)
	}
	a.getenv = func(k string) string { return map[string]string{"HIVE_TOKEN": "hwm_khong-phai-pat"}[k] }
	if code := a.run([]string{"auth", "token", "--hub", authHub, "--json"}); code != exitFailed {
		t.Fatalf("HIVE_TOKEN sai dạng phải báo lỗi, nhận %d", code)
	}
}

func TestAuthMovesLegacyFileTokenIntoKeychain(t *testing.T) {
	a := authApp(t)
	_, path, _ := a.loadCLIConfig()
	if err := saveCLIConfig(path, cliConfig{HubURL: authHub, Token: testToken, UserID: "u1"}); err != nil {
		t.Fatal(err)
	}
	// Vẫn không có keychain: dùng token cũ để khỏi đăng xuất ngang, nhưng nhắc bỏ nó.
	a.keyring = &memKeyring{broken: true}
	if r := authRun(t, a, exitOK, "token", "--json"); r.Token != testToken || r.Source != "file" {
		t.Fatalf("token bản cũ = %+v", r)
	}
	if !strings.Contains(a.err.String(), "hive logout") {
		t.Fatalf("phải nhắc bỏ token trong file: %q", a.err.String())
	}
	authRun(t, a, exitDenied, "token", "--hub", "https://other.example.test", "--json")
	a.keyring = osKeyring{}
	if r := authRun(t, a, exitOK, "token", "--json"); r.Token != testToken || r.Source != "keychain" {
		t.Fatalf("token sau khi chuyển = %+v", r)
	}
	if got, _ := keyring.Get(keyringService, authHub); got != testToken {
		t.Fatal("chưa chuyển token vào keychain")
	}
	if cfg, _, _ := a.loadCLIConfig(); cfg.Token != "" || cfg.UserID != "u1" || cfg.HubURL != authHub {
		t.Fatalf("hive.json phải bỏ token, giữ hub và danh tính: %+v", cfg)
	}
}

func TestAuthHubPrecedence(t *testing.T) {
	a := authApp(t)
	workerPath := os.Getenv("HIVE_WORKER_CONFIG")
	if err := config.Save(workerPath, config.Config{HubURL: authHub}); err != nil {
		t.Fatal(err)
	}
	if err := keyring.Set(keyringService, authHub, testToken); err != nil {
		t.Fatal(err)
	}
	if r := authRun(t, a, exitOK, "token", "--json"); r.HubURL != authHub {
		t.Fatal("phải tìm hub từ worker.json")
	}
	_, path, _ := a.loadCLIConfig()
	if err := saveCLIConfig(path, cliConfig{HubURL: "https://cli.example.test"}); err != nil {
		t.Fatal(err)
	}
	if r := authRun(t, a, exitDenied, "token", "--json"); r.HubURL != "https://cli.example.test" {
		t.Fatal("hive.json phải ưu tiên hơn worker.json")
	}
	a.getenv = func(k string) string {
		if k == "HIVE_HUB_URL" {
			return "https://env.example.test/"
		}
		return ""
	}
	if r := authRun(t, a, exitDenied, "token", "--json"); r.HubURL != "https://env.example.test" {
		t.Fatal("biến môi trường phải ưu tiên hơn file")
	}
	authRun(t, a, exitOK, "token", "--json", "--hub", authHub)
}

func TestAuthMissingAndInvalidInput(t *testing.T) {
	a := authApp(t)
	for _, command := range []string{"token", "status"} {
		if r := authRun(t, a, exitDenied, command, "--json"); r.Authenticated || r.Token != "" {
			t.Fatal("chưa cấu hình phải trả mã 3 và không có token")
		}
	}
	for _, args := range [][]string{
		nil, {testToken}, {"store", "--hub", authHub, testToken},
		{"store", "--hub", authHub, "--json=" + testToken},
		{"token", "--hub", testToken}, {"store"},
	} {
		a.out.Reset()
		a.err.Reset()
		if code := a.run(append([]string{"auth"}, args...)); code != exitUsage {
			t.Fatalf("mã thoát = %d, cần 2", code)
		}
		if strings.Contains(a.err.String()+a.out.String(), testToken) {
			t.Fatal("đối số không hợp lệ làm lộ token")
		}
	}
	for _, input := range []string{"", "hwm_secret", testToken + "\n" + testToken, strings.Repeat("x", 1025)} {
		a.stdin = strings.NewReader(input)
		a.err.Reset()
		if code := a.run([]string{"auth", "store", "--hub", authHub}); code != exitUsage {
			t.Fatalf("stdin không hợp lệ: mã = %d", code)
		}
		if strings.Contains(a.err.String(), testToken) {
			t.Fatal("stdin không hợp lệ làm lộ token")
		}
	}
}

type failingAuthKeyring struct{}

func (failingAuthKeyring) Get(string, string) (string, error) { return "", errors.New(testToken) }
func (failingAuthKeyring) Set(string, string, string) error   { return errors.New(testToken) }
func (failingAuthKeyring) Delete(string, string) error        { return errors.New(testToken) }

type failingAuthWriter struct{}

func (failingAuthWriter) Write([]byte) (int, error) { return 0, errors.New(testToken) }

func TestAuthErrorsDoNotLeakSecrets(t *testing.T) {
	a := authApp(t)
	a.keyring = failingAuthKeyring{}
	for _, command := range []string{"token", "status", "logout"} {
		a.err.Reset()
		if code := a.run([]string{"auth", command, "--hub", authHub, "--json"}); code != exitFailed {
			t.Fatalf("lỗi keychain phải trả mã 1, nhận %d", code)
		}
		if strings.Contains(a.err.String(), testToken) {
			t.Fatal("lỗi keychain làm lộ token")
		}
	}
	a.stdin = strings.NewReader(testToken)
	a.err.Reset()
	if code := a.run([]string{"auth", "store", "--hub", authHub, "--json"}); code != exitFailed || strings.Contains(a.err.String(), testToken) {
		t.Fatal("keychain lỗi thì store phải báo lỗi và không làm lộ token")
	}
	a.getenv = func(k string) string { return map[string]string{"HIVE_TOKEN": testToken}[k] }
	authRun(t, a, exitOK, "token", "--hub", authHub, "--json")
	a.stdout = failingAuthWriter{}
	a.err.Reset()
	if code := a.run([]string{"auth", "token", "--hub", authHub}); code != exitFailed || strings.Contains(a.err.String(), testToken) {
		t.Fatal("lỗi stdout phải trả mã 1 và không làm lộ token")
	}
	a.stdout = io.Discard
	a.getenv = func(string) string { return "" }
	_, path, _ := a.loadCLIConfig()
	if err := os.WriteFile(path, []byte(`{"token":"`+testToken), 0o600); err != nil {
		t.Fatal(err)
	}
	a.err.Reset()
	if code := a.run([]string{"auth", "token", "--hub", authHub}); code != exitFailed || strings.Contains(a.err.String(), testToken) {
		t.Fatal("cấu hình hỏng phải báo lỗi an toàn")
	}
}

func TestAuthLogoutClearsFallbackWhenKeychainUnavailable(t *testing.T) {
	a := authApp(t)
	a.keyring = failingAuthKeyring{}
	_, path, _ := a.loadCLIConfig()
	if err := saveCLIConfig(path, cliConfig{HubURL: authHub, Token: testToken}); err != nil {
		t.Fatal(err)
	}
	a.err.Reset()
	if code := a.run([]string{"auth", "logout", "--json"}); code != exitFailed {
		t.Fatal("phải báo lỗi khi không xác nhận được việc xoá keychain")
	}
	if cfg, _, err := a.loadCLIConfig(); err != nil || cfg.Token != "" || cfg.HubURL != authHub {
		t.Fatal("vẫn phải xoá token bản cũ trong file, giữ địa chỉ hub")
	}
	if strings.Contains(a.err.String(), testToken) {
		t.Fatal("lỗi xoá keychain làm lộ token")
	}
}

func TestAuthStoreDoesNotReportSuccessWithStaleKeychainToken(t *testing.T) {
	a := authApp(t)
	a.keyring = &memKeyring{broken: true, m: map[string]string{keyringService + "|" + authHub: testToken}}
	a.stdin = strings.NewReader(testToken[:len(testToken)-1] + "Z")
	if code := a.run([]string{"auth", "store", "--hub", authHub, "--json"}); code != exitFailed {
		t.Fatal("không được báo thành công khi lần đọc sau vẫn trả token cũ")
	}
	if strings.Contains(a.err.String(), testToken) {
		t.Fatal("lỗi cập nhật keychain làm lộ token")
	}
}
