package main

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/zalando/go-keyring"

	"github.com/tdduydev/xdev-hive/worker/internal/delivery"
	"github.com/tdduydev/xdev-hive/worker/internal/registry"
	"github.com/tdduydev/xdev-hive/worker/internal/secretstore"
)

const deliveryFakeValue = "bot:fake-jenkins-token-never-print"

// deliveryCredsEnv dùng kho giả và sổ đăng ký tạm, trả worker.json ngoài sổ (thuộc reg_legacy).
func deliveryCredsEnv(t *testing.T) (string, registry.Book) {
	t.Helper()
	cfg := secretsEnv(t)
	old := deliveryCredsStore
	deliveryCredsStore = secretstore.NewDeliveryStore
	t.Cleanup(func() { deliveryCredsStore = old })
	return cfg, tempBook(t)
}

func TestDeliveryCredsSetListDelete(t *testing.T) {
	cfg, _ := deliveryCredsEnv(t)
	if r := secretsCall(t, valueJSON("  "+deliveryFakeValue+"\n"), "delivery", "set", "--config", cfg, "--name", "jenkins-prod"); r.code != 0 {
		t.Fatalf("set: %d %s %s", r.code, r.stdout, r.stderr)
	} else if strings.Contains(r.stdout+r.stderr, deliveryFakeValue) {
		t.Fatal("set in ra giá trị")
	}
	// Giá trị bỏ khoảng trắng đầu, cuối, nằm ở kho delivery theo khoá của đăng ký.
	got, err := secretstore.NewDeliveryStore().Get(secretstore.DeliveryAccount(registry.LegacyID, "jenkins-prod"))
	if err != nil || got != deliveryFakeValue {
		t.Fatalf("giá trị trong kho sai: %v", err)
	}
	r := secretsCall(t, "", "delivery", "list", "--config", cfg, "--json")
	var list deliveryCredsListView
	if r.code != 0 || json.Unmarshal([]byte(r.stdout), &list) != nil {
		t.Fatalf("list: %d %s", r.code, r.stdout)
	}
	if list.Registration != registry.LegacyID || len(list.Credentials) != 1 || list.Credentials[0].Name != "jenkins-prod" ||
		!list.Credentials[0].ValueChangedAt.Equal(secretsClock) {
		t.Fatalf("list = %+v", list)
	}
	if strings.Contains(r.stdout, deliveryFakeValue) {
		t.Fatal("list in ra giá trị")
	}

	// Credential triển khai không có trong danh mục bí mật dự án, nên không gán được cho dự án.
	if r := secretsCall(t, "", "list", "--config", cfg); strings.Contains(r.stdout, "jenkins-prod") {
		t.Fatalf("lộ sang danh mục dự án: %s", r.stdout)
	}
	if r := secretsCall(t, "", "assign", "--config", cfg, "--name", "jenkins-prod", "--project", appLocalID); r.code == 0 {
		t.Fatal("gán credential triển khai cho dự án phải lỗi")
	}

	if r := secretsCall(t, "", "delivery", "delete", "--config", cfg, "--name", "jenkins-prod"); r.code != 0 || !strings.Contains(r.stdout, `"deleted":"jenkins-prod"`) {
		t.Fatalf("delete: %d %s", r.code, r.stdout)
	}
	if _, err := secretstore.NewDeliveryStore().Get(secretstore.DeliveryAccount(registry.LegacyID, "jenkins-prod")); !errors.Is(err, secretstore.ErrMissing) {
		t.Fatalf("xoá chưa xoá kho: %v", err)
	}
	if r := secretsCall(t, "", "delivery", "delete", "--config", cfg, "--name", "jenkins-prod"); r.errCode(t) != secretstore.CodeNotFound {
		t.Fatalf("xoá lần hai: %s", r.stdout)
	}
}

// Giá trị CLI ghi đọc lại được bằng đúng đường worker dùng khi chạy việc (ScopedCredentials + KeyringCredentials).
func TestDeliveryCredsReadableByWorker(t *testing.T) {
	cfg, _ := deliveryCredsEnv(t)
	if r := secretsCall(t, valueJSON(deliveryFakeValue), "delivery", "set", "--config", cfg, "--name", "argocd"); r.code != 0 {
		t.Fatalf("set: %s", r.stdout)
	}
	c := delivery.ScopedCredentials{
		Scope: delivery.Scope{RegistrationID: registry.LegacyID},
		Store: delivery.KeyringCredentials{Store: secretstore.NewDeliveryStore()},
	}
	v, err := c.Read("argocd")
	if err != nil || string(v) != deliveryFakeValue {
		t.Fatalf("worker đọc lại: %v", err)
	}
}

func TestDeliveryCredsRegistrationFromBook(t *testing.T) {
	_, book := deliveryCredsEnv(t)
	const id = "reg_abcdefgh"
	if err := book.Update(func(ix *registry.Index) error {
		ix.Registrations = append(ix.Registrations, registry.Registration{ID: id, HubURL: "https://hub.a"})
		ix.Active = id
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	cfg := book.ConfigPath(id)
	if err := os.MkdirAll(book.ConfigDir(id), 0o700); err != nil {
		t.Fatal(err)
	}
	if r := secretsCall(t, valueJSON(deliveryFakeValue), "delivery", "set", "--config", cfg, "--name", "jenkins"); r.code != 0 {
		t.Fatalf("set: %s %s", r.stdout, r.stderr)
	}
	if _, err := secretstore.NewDeliveryStore().Get(secretstore.DeliveryAccount(id, "jenkins")); err != nil {
		t.Fatalf("khoá phải theo đăng ký %s: %v", id, err)
	}
	if _, err := secretstore.NewDeliveryStore().Get(secretstore.DeliveryAccount(registry.LegacyID, "jenkins")); !errors.Is(err, secretstore.ErrMissing) {
		t.Fatalf("không được ghi vào reg_legacy: %v", err)
	}
}

func TestDeliveryCredsRejectsBadInput(t *testing.T) {
	cfg, _ := deliveryCredsEnv(t)
	cases := []struct {
		stdin string
		args  []string
		code  string
	}{
		{valueJSON(deliveryFakeValue), []string{"--name", "Jenkins"}, secretstore.CodeInvalidName},
		{valueJSON(deliveryFakeValue), []string{"--name", "a_b"}, secretstore.CodeInvalidName},
		{"", []string{"--name", "jenkins"}, secretstore.CodeInvalidValue},
		{valueJSON("short"), []string{"--name", "jenkins"}, secretstore.CodeInvalidValue},
		{deliveryFakeValue, []string{"--name", "jenkins"}, secretstore.CodeInvalidValue},
	}
	for _, c := range cases {
		r := secretsCall(t, c.stdin, append([]string{"delivery", "set", "--config", cfg}, c.args...)...)
		if got := r.errCode(t); got != c.code {
			t.Fatalf("%v: mã %s, muốn %s", c.args, got, c.code)
		}
		if strings.Contains(r.stdout+r.stderr, deliveryFakeValue) {
			t.Fatalf("%v: lỗi in ra giá trị", c.args)
		}
	}
	// Giá trị chỉ qua stdin: không có cờ --value, và lỗi cờ không chép lại giá trị gõ nhầm.
	r := secretsCall(t, "", "delivery", "set", "--config", cfg, "--name", "jenkins", "--value="+deliveryFakeValue)
	if r.code != 2 || strings.Contains(r.stdout+r.stderr, deliveryFakeValue) {
		t.Fatalf("--value: %d %s %s", r.code, r.stdout, r.stderr)
	}
	for _, args := range [][]string{{"delivery"}, {"delivery", "list", "--name", "x"}, {"delivery", "delete"}, {"delivery", "assign", "--name", "x"}} {
		if r := secretsCall(t, "", append(args, "--config", cfg)...); r.code != 2 {
			t.Fatalf("%v: code %d", args, r.code)
		}
	}
}

func TestDeliveryCredsStoreUnavailable(t *testing.T) {
	cfg, _ := deliveryCredsEnv(t)
	keyring.MockInitWithError(errors.New("backend failed for " + deliveryFakeValue))
	r := secretsCall(t, valueJSON(deliveryFakeValue), "delivery", "set", "--config", cfg, "--name", "jenkins")
	if code := r.errCode(t); code != secretstore.CodeStoreUnavailable && code != secretstore.CodeStoreLocked {
		t.Fatalf("mã %s", code)
	}
	if strings.Contains(r.stdout+r.stderr, deliveryFakeValue) {
		t.Fatal("lỗi kho in ra giá trị")
	}
	// Ghi kho lỗi thì danh mục không có mục mồ côi.
	if r := secretsCall(t, "", "delivery", "list", "--config", cfg); r.code != 0 || strings.Contains(r.stdout, "jenkins") {
		t.Fatalf("list sau lỗi: %s", r.stdout)
	}
	if r := secretsCall(t, "", "delivery", "status", "--config", cfg); r.code != 0 || !strings.Contains(r.stdout, `"available"`) {
		t.Fatalf("status: %s", r.stdout)
	}
}
