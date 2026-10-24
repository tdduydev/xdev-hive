package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/config"
	"github.com/tdduydev/xdev-hive/worker/internal/registry"
)

// orgHub là hub giả có hai tổ chức: mã `hwr_a…` thuộc tổ chức A, mã `hwr_b…` thuộc tổ chức B. Mỗi lần đăng ký trả
// machine token mới, như hub thật cài lại máy.
func orgHub(t *testing.T) *httptest.Server {
	t.Helper()
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/worker/register" {
			http.NotFound(w, r)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		token, _ := body["registrationToken"].(string)
		org, name := "00000000-0000-4000-8000-00000000000a", "Công ty A"
		if strings.HasPrefix(token, "hwr_b") {
			org, name = "00000000-0000-4000-8000-00000000000b", "Công ty B"
		}
		n++
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"id": "00000000-0000-4000-8000-000000000001", "orgId": org, "orgName": name,
			"teamId": "00000000-0000-4000-8000-000000000003", "machineId": body["machineId"].(string),
			"machineToken": "hwm_" + token + "_" + string(rune('0'+n)),
		})
	}))
	t.Cleanup(srv.Close)
	return srv
}

// tempBook trỏ sổ đăng ký vào thư mục tạm và tắt các biến môi trường chọn đăng ký của máy dev.
func tempBook(t *testing.T) registry.Book {
	t.Helper()
	dir := t.TempDir()
	book := registry.Book{ConfigRoot: filepath.Join(dir, "config"), CacheRoot: filepath.Join(dir, "cache")}
	prev := registryBook
	registryBook = func() (registry.Book, error) { return book, nil }
	t.Cleanup(func() { registryBook = prev })
	t.Setenv(registry.EnvRegistration, "")
	t.Setenv(registry.EnvWorkerConfig, "")
	return book
}

func addRegistration(t *testing.T, hub, token string) registrationView {
	t.Helper()
	var stdout, stderr bytes.Buffer
	if code := registrationsCommand([]string{"add", "--hub", hub, "--token", token, "--machine", "may-test", "--json"}, &stdout, &stderr); code != 0 {
		t.Fatalf("add %s: mã %d, %s", token, code, stderr.String())
	}
	var v registrationView
	if err := json.Unmarshal(stdout.Bytes(), &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestRegistrationsKeepOrgsApart(t *testing.T) {
	book := tempBook(t)
	hub := orgHub(t)
	a := addRegistration(t, hub.URL, "hwr_a1")
	b := addRegistration(t, hub.URL, "hwr_b1")
	if a.ID == b.ID || a.OrgName != "Công ty A" || b.OrgName != "Công ty B" {
		t.Fatalf("hai tổ chức phải là hai đăng ký: %+v %+v", a, b)
	}
	cfgA, errA := config.Load(book.ConfigPath(a.ID))
	cfgB, errB := config.Load(book.ConfigPath(b.ID))
	if errA != nil || errB != nil {
		t.Fatal(errA, errB)
	}
	if cfgA.MachineToken == cfgB.MachineToken || cfgA.KeyScope != a.ID || cfgB.KeyScope != b.ID {
		t.Fatalf("mỗi tổ chức một token và một khoá: %+v %+v", cfgA, cfgB)
	}
	// Không có keychain thì khoá nằm trong file cạnh worker.json của từng đăng ký.
	keyA, _ := os.ReadFile(newKeyStore(book.ConfigPath(a.ID)).File)
	keyB, _ := os.ReadFile(newKeyStore(book.ConfigPath(b.ID)).File)
	if len(keyA) == 0 || len(keyB) == 0 || bytes.Equal(keyA, keyB) {
		t.Fatal("hai đăng ký cùng hub, cùng tên máy phải có hai khoá riêng")
	}

	ix, _ := book.Load()
	if ix.Active != a.ID || len(ix.Registrations) != 2 {
		t.Fatalf("đăng ký đầu tiên được chọn: %+v", ix)
	}
	var out, errOut bytes.Buffer
	if code := registrationsCommand([]string{"use", b.ID}, &out, &errOut); code != 0 {
		t.Fatalf("use: %s", errOut.String())
	}
	if p, err := pathOrIn(book); err != nil || p != book.ConfigPath(b.ID) {
		t.Fatalf("lệnh không có cờ dùng đăng ký đang chọn: %s %v", p, err)
	}
	t.Setenv(registry.EnvRegistration, a.ID)
	if p, err := pathOrIn(book); err != nil || p != book.ConfigPath(a.ID) {
		t.Fatalf("--registration thắng đăng ký đang chọn: %s %v", p, err)
	}
}

// pathOrIn là pathOr với sổ của test: pathOr đọc sổ theo thư mục hệ điều hành, test không được đụng sổ thật.
func pathOrIn(book registry.Book) (string, error) {
	id, err := book.Selected("")
	if err != nil {
		return "", err
	}
	return book.ConfigPath(id), nil
}

// FR-004: đăng ký lại cùng hub và tổ chức thay đăng ký cũ, không thêm dòng thứ hai.
func TestRegistrationsSameOrgReplaces(t *testing.T) {
	book := tempBook(t)
	hub := orgHub(t)
	first := addRegistration(t, hub.URL, "hwr_a1")
	again := addRegistration(t, hub.URL, "hwr_a2")
	if again.ID != first.ID {
		t.Fatalf("cùng tổ chức phải giữ đăng ký %s, nhận %s", first.ID, again.ID)
	}
	ix, _ := book.Load()
	if len(ix.Registrations) != 1 {
		t.Fatalf("sổ chỉ có một dòng cho một tổ chức: %+v", ix)
	}
	cfg, err := config.Load(book.ConfigPath(first.ID))
	if err != nil || !strings.HasPrefix(cfg.MachineToken, "hwm_hwr_a2") {
		t.Fatalf("worker.json phải mang token mới: %+v %v", cfg, err)
	}
	store := newKeyStore(cfg.Path)
	store.Scope = cfg.KeyScope
	if _, err := store.Load(cfg.HubURL, cfg.MachineID); err != nil {
		t.Fatalf("khoá của lần đăng ký mới phải nằm cạnh worker.json của đăng ký cũ: %v", err)
	}
	entries, _ := os.ReadDir(filepath.Join(book.ConfigRoot, "orgs"))
	if len(entries) != 1 {
		t.Fatalf("thư mục của lần đăng ký trùng phải được dọn: %d thư mục", len(entries))
	}
}

func TestRegistrationsLegacyMachineUnchanged(t *testing.T) {
	book := tempBook(t)
	legacy := config.Config{HubURL: "https://hub.cu", MachineID: "may-cu", MachineToken: "hwm_cu"}
	if err := config.Save(book.ConfigPath(registry.LegacyID), legacy); err != nil {
		t.Fatal(err)
	}
	if p, err := pathOrIn(book); err != nil || p != filepath.Join(book.ConfigRoot, "worker.json") {
		t.Fatalf("máy cũ dùng worker.json ở chỗ cũ: %s %v", p, err)
	}
	b := addRegistration(t, orgHub(t).URL, "hwr_b1")
	ix, _ := book.Load()
	if ix.Active != registry.LegacyID || len(ix.Registrations) != 2 {
		t.Fatalf("thêm tổ chức không đổi đăng ký máy cũ đang chạy: %+v", ix)
	}
	if cfg, _ := config.Load(book.ConfigPath(registry.LegacyID)); cfg.MachineToken != "hwm_cu" {
		t.Fatalf("token đăng ký cũ bị ghi đè: %+v", cfg)
	}
	var out, errOut bytes.Buffer
	if code := registrationsCommand([]string{"remove", registry.LegacyID}, &out, &errOut); code == 0 {
		t.Fatal("không gỡ đăng ký cũ bằng lệnh này")
	}
	if code := registrationsCommand([]string{"remove", "../x"}, &out, &errOut); code != 2 {
		t.Fatal("id lạ phải bị chặn")
	}
	if code := registrationsCommand([]string{"set", b.ID, "--label", "Khách B"}, &out, &errOut); code != 0 {
		t.Fatalf("set: %s", errOut.String())
	}
	if ix, _ = book.Load(); ix.Registrations[1].Label != "Khách B" {
		t.Fatalf("nhãn: %+v", ix.Registrations[1])
	}
}

func TestTakeRegistrationFlag(t *testing.T) {
	t.Setenv(registry.EnvRegistration, "")
	args, ok := takeRegistrationFlag([]string{"--registration", "reg_abcdefgh", "run", "--status-json"})
	if !ok || strings.Join(args, " ") != "run --status-json" || os.Getenv(registry.EnvRegistration) != "reg_abcdefgh" {
		t.Fatalf("cờ đứng trước lệnh: %v %v", args, ok)
	}
	args, ok = takeRegistrationFlag([]string{"--registration=reg_bbbbbbbb", "config"})
	if !ok || len(args) != 1 || os.Getenv(registry.EnvRegistration) != "reg_bbbbbbbb" {
		t.Fatalf("cờ dạng =: %v %v", args, ok)
	}
	if args, ok = takeRegistrationFlag([]string{"run"}); ok || len(args) != 1 {
		t.Fatal("không có cờ thì giữ nguyên")
	}
}
