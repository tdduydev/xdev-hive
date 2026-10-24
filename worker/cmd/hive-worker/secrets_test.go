package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/zalando/go-keyring"

	"github.com/tdduydev/xdev-hive/worker/internal/projects"
	"github.com/tdduydev/xdev-hive/worker/internal/secretstore"
)

// Giá trị giả, đủ dài để thấy ngay nếu bị in lại.
const (
	fakeValue  = "fake-Value-0123456789-should-never-print"
	fakeValue2 = "fake-Value-second-9876543210-never-print"
	appLocalID = "1111111111111111"
	apiLocalID = "2222222222222222"
)

var secretsClock = time.Date(2026, 10, 1, 8, 30, 0, 0, time.UTC)

// secretsEnv dựng thư mục cấu hình có projects.json cố định (thư mục giả, không cần tồn tại) và kho giả.
func secretsEnv(t *testing.T) string {
	t.Helper()
	keyring.MockInit()
	oldStore := secretsStore
	secretsStore = secretstore.NewStore
	t.Cleanup(func() { secretsStore = oldStore })
	now := secretsClock
	oldNow := secretsNow
	secretsNow = func() time.Time { return now }
	t.Cleanup(func() { secretsNow = oldNow })
	dir := t.TempDir()
	cfg := filepath.Join(dir, "worker.json")
	list := map[string]any{"projects": []projects.Project{
		{LocalID: appLocalID, Name: "app", Folder: "/home/dev/app"},
		{LocalID: apiLocalID, ProjectID: "0a0a0a0a-0000-4000-8000-000000000031", Name: "api", Folder: "/home/dev/api"},
	}}
	if err := os.WriteFile(projects.DefaultPath(cfg), mustJSON(list), 0o600); err != nil {
		t.Fatal(err)
	}
	return cfg
}

type secretsRun struct {
	code           int
	stdout, stderr string
}

func secretsCall(t *testing.T, stdin string, args ...string) secretsRun {
	t.Helper()
	var out, errOut bytes.Buffer
	code := secretsCommand(args, strings.NewReader(stdin), &out, &errOut)
	return secretsRun{code, out.String(), errOut.String()}
}

func (r secretsRun) errCode(t *testing.T) string {
	t.Helper()
	var v struct {
		Error secretstore.Error `json:"error"`
	}
	if err := json.Unmarshal([]byte(r.stdout), &v); err != nil || r.code != 1 {
		t.Fatalf("muốn lỗi JSON, có %d %q: %v", r.code, r.stdout, err)
	}
	return v.Error.Code
}

func valueJSON(v string) string { return string(mustJSON(map[string]string{"value": v})) }

func descFile(t *testing.T, s string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "desc.txt")
	if err := os.WriteFile(p, []byte(s), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestSecretsCommandFlow(t *testing.T) {
	cfg := secretsEnv(t)
	store := secretstore.NewStore()

	if r := secretsCall(t, "", "set", "--config", cfg, "--name", "db_url"); r.errCode(t) != secretstore.CodeInvalidValue {
		t.Fatal("tạo bí mật không có giá trị phải lỗi")
	}
	if r := secretsCall(t, valueJSON(fakeValue), "set", "--config", cfg, "--name", "PATH"); r.errCode(t) != secretstore.CodeReservedName {
		t.Fatal("tên dành riêng")
	}
	if _, err := store.Get("PATH"); !errors.Is(err, secretstore.ErrMissing) {
		t.Fatal("lỗi tên mà vẫn ghi kho")
	}
	r := secretsCall(t, valueJSON(fakeValue), "set", "--config", cfg, "--name", "db_url", "--description-file", descFile(t, "Chuỗi kết nối DB thử\n"))
	var item secretItem
	if r.code != 0 || json.Unmarshal([]byte(r.stdout), &item) != nil || item.Name != "DB_URL" || item.Description != "Chuỗi kết nối DB thử" {
		t.Fatalf("set: %+v", r)
	}
	if got, _ := store.Get("DB_URL"); got != fakeValue {
		t.Fatal("kho không có giá trị vừa đặt")
	}
	if r := secretsCall(t, valueJSON(fakeValue), "set", "--config", cfg, "--name", "OTHER", "--description-file", descFile(t, "token ghp_"+strings.Repeat("A", 36))); r.errCode(t) != secretstore.CodeDescriptionSecret {
		t.Fatal("mô tả giống bí mật")
	}

	// Đặt lại giá trị không cần mô tả; mô tả cũ giữ nguyên.
	later := secretsClock.Add(time.Hour)
	secretsNow = func() time.Time { return later }
	r = secretsCall(t, valueJSON(fakeValue2), "set", "--config", cfg, "--name", "DB_URL")
	if r.code != 0 || json.Unmarshal([]byte(r.stdout), &item) != nil || !item.ValueChangedAt.Equal(later) || !item.CreatedAt.Equal(secretsClock) || item.Description == "" {
		t.Fatalf("đặt lại: %+v", r)
	}
	if got, _ := store.Get("DB_URL"); got != fakeValue2 {
		t.Fatal("giá trị chưa đổi")
	}

	if r := secretsCall(t, "", "assign", "--config", cfg, "--name", "DB_URL", "--project", "ffffffffffffffff"); r.errCode(t) != secretstore.CodeNotFound {
		t.Fatal("gán cho dự án không có")
	}
	r = secretsCall(t, "", "assign", "--config", cfg, "--name", "db_url", "--project", appLocalID)
	if r.code != 0 || json.Unmarshal([]byte(r.stdout), &item) != nil || len(item.Projects) != 1 || item.Projects[0] != (secretProject{appLocalID, "app", "/home/dev/app"}) {
		t.Fatalf("assign: %+v", r)
	}

	r = secretsCall(t, "", "rename", "--config", cfg, "--name", "DB_URL", "--to", "database_url")
	if r.code != 0 || json.Unmarshal([]byte(r.stdout), &item) != nil || item.Name != "DATABASE_URL" || len(item.Projects) != 1 {
		t.Fatalf("rename: %+v", r)
	}
	if got, _ := store.Get("DATABASE_URL"); got != fakeValue2 {
		t.Fatal("đổi tên không chuyển giá trị")
	}
	if _, err := store.Get("DB_URL"); !errors.Is(err, secretstore.ErrMissing) {
		t.Fatal("đổi tên còn để lại mục cũ trong kho")
	}

	var list secretsListView
	r = secretsCall(t, "", "list", "--config", cfg, "--json", "--project", apiLocalID)
	if r.code != 0 || json.Unmarshal([]byte(r.stdout), &list) != nil || len(list.Secrets) != 0 || len(list.Reserved.Exact) == 0 {
		t.Fatalf("list theo dự án khác: %+v", r)
	}

	// Gỡ dự án khỏi máy thì bí mật thôi gán cho nó (FR-063).
	var errOut bytes.Buffer
	if pr := projectsCommand([]string{"unbind", "--config", cfg, "--folder", "/home/dev/app", "--json"}, &bytes.Buffer{}, &errOut); pr != 0 {
		t.Fatalf("projects unbind: %d %s", pr, errOut.String())
	}
	cat, _ := secretstore.LoadCatalog(secretstore.CatalogPath(cfg))
	if s := cat.Find("DATABASE_URL"); s == nil || len(s.Projects) != 0 {
		t.Fatalf("projects unbind không gỡ gán: %+v", cat)
	}

	var del secretDeleteView
	r = secretsCall(t, "", "delete", "--config", cfg, "--name", "DATABASE_URL")
	if r.code != 0 || json.Unmarshal([]byte(r.stdout), &del) != nil || del.Deleted != "DATABASE_URL" || del.InUse {
		t.Fatalf("delete: %+v", r)
	}
	if _, err := store.Get("DATABASE_URL"); !errors.Is(err, secretstore.ErrMissing) {
		t.Fatal("xoá không xoá kho")
	}
	if r := secretsCall(t, "", "delete", "--config", cfg, "--name", "DATABASE_URL"); r.errCode(t) != secretstore.CodeNotFound {
		t.Fatal("xoá lần hai")
	}
	if r := secretsCall(t, "", "status", "--config", cfg); r.code != 0 || !strings.Contains(r.stdout, `"available":true`) {
		t.Fatalf("status: %+v", r)
	}
}

// FR-066: bí mật dùng chung liệt kê mọi dự án trên máy, để desktop bọc terminal của dự án nào cũng được.
func TestSecretsAllProjects(t *testing.T) {
	cfg := secretsEnv(t)
	if r := secretsCall(t, valueJSON(fakeValue), "set", "--config", cfg, "--name", "SENTRY_DSN"); r.code != 0 {
		t.Fatalf("set: %+v", r)
	}
	if r := secretsCall(t, "", "assign", "--config", cfg, "--name", "SENTRY_DSN", "--project", appLocalID); r.code != 0 {
		t.Fatalf("assign: %+v", r)
	}
	for _, args := range [][]string{
		{"assign", "--name", "SENTRY_DSN", "--project", appLocalID, "--all-projects"},
		{"unassign", "--name", "SENTRY_DSN"},
	} {
		if r := secretsCall(t, "", append(args, "--config", cfg)...); r.code != 2 {
			t.Fatalf("%v phải là lỗi cú pháp: %+v", args, r)
		}
	}

	var item secretItem
	r := secretsCall(t, "", "assign", "--config", cfg, "--name", "sentry_dsn", "--all-projects")
	if r.code != 0 || json.Unmarshal([]byte(r.stdout), &item) != nil || !item.AllProjects || len(item.Projects) != 2 ||
		item.Projects[0].LocalID != appLocalID || item.Projects[1].LocalID != apiLocalID {
		t.Fatalf("assign --all-projects: %+v", r)
	}
	cat, _ := secretstore.LoadCatalog(secretstore.CatalogPath(cfg))
	if s := cat.Find("SENTRY_DSN"); s == nil || !s.AllProjects || len(s.Projects) != 0 {
		t.Fatalf("danh mục chỉ giữ cờ, không giữ gán riêng: %+v", s)
	}

	var list secretsListView
	r = secretsCall(t, "", "list", "--config", cfg, "--json", "--project", apiLocalID)
	if r.code != 0 || json.Unmarshal([]byte(r.stdout), &list) != nil || len(list.Secrets) != 1 || !list.Secrets[0].AllProjects {
		t.Fatalf("lọc theo dự án phải có bí mật dùng chung: %+v", r)
	}

	r = secretsCall(t, "", "unassign", "--config", cfg, "--name", "SENTRY_DSN", "--all-projects")
	if r.code != 0 || json.Unmarshal([]byte(r.stdout), &item) != nil || item.AllProjects || len(item.Projects) != 0 {
		t.Fatalf("unassign --all-projects: %+v", r)
	}
}

// FR-009, FR-036: giá trị chỉ đi qua stdin, và không lỗi nào in lại nó, kể cả khi người dùng đưa nhầm vào tham số.
func TestSecretsValueNeverEchoed(t *testing.T) {
	cfg := secretsEnv(t)
	check := func(label string, r secretsRun, wantCode int) {
		t.Helper()
		if r.code != wantCode {
			t.Errorf("%s: mã thoát %d, muốn %d", label, r.code, wantCode)
		}
		if strings.Contains(r.stdout+r.stderr, fakeValue) || strings.Contains(r.stdout+r.stderr, fakeValue[:16]) {
			t.Errorf("%s: output chứa giá trị", label)
		}
	}
	check("--value", secretsCall(t, "", "set", "--config", cfg, "--name", "API_KEY", "--value="+fakeValue), 2)
	check("--json=giá trị", secretsCall(t, "", "set", "--config", cfg, "--name", "API_KEY", "--json="+fakeValue), 2)
	check("đối số tự do", secretsCall(t, "", "set", "--config", cfg, "--name", "API_KEY", fakeValue), 2)
	check("stdin không phải JSON", secretsCall(t, fakeValue, "set", "--config", cfg, "--name", "API_KEY"), 1)
	check("JSON hỏng", secretsCall(t, `{"value":"`+fakeValue, "set", "--config", cfg, "--name", "API_KEY"), 1)
	check("trường lạ", secretsCall(t, `{"value":"`+fakeValue+`","x":"`+fakeValue+`"}`, "set", "--config", cfg, "--name", "API_KEY"), 1)
	check("hai JSON", secretsCall(t, valueJSON(fakeValue)+valueJSON(fakeValue), "set", "--config", cfg, "--name", "API_KEY"), 1)
	check("giá trị quá dài", secretsCall(t, valueJSON(fakeValue+strings.Repeat("x", 9<<10)), "set", "--config", cfg, "--name", "API_KEY"), 1)
	check("tên sai", secretsCall(t, valueJSON(fakeValue), "set", "--config", cfg, "--name", "1BAD"), 1)
	if _, err := secretstore.NewStore().Get("API_KEY"); !errors.Is(err, secretstore.ErrMissing) {
		t.Fatal("lệnh lỗi mà vẫn ghi kho")
	}
	// Lỗi của kho có thể chép lại thứ đã gửi nó; lệnh chỉ in thông báo của gói.
	keyring.MockInitWithError(errors.New("backend failed for " + fakeValue))
	t.Cleanup(keyring.MockInit)
	r := secretsCall(t, valueJSON(fakeValue), "set", "--config", cfg, "--name", "API_KEY")
	check("kho lỗi", r, 1)
	if r.errCode(t) != secretstore.CodeStoreUnavailable {
		t.Fatalf("kho lỗi: %+v", r)
	}
	if cat, _ := secretstore.LoadCatalog(secretstore.CatalogPath(cfg)); len(cat.Secrets) != 0 {
		t.Fatal("kho lỗi mà danh mục vẫn thêm mục")
	}
}

// Fixture cho kiểu TS của desktop (apps/desktop/src/lib/secrets.ts). Đổi kiểu Go thì chạy lại với
// SECRETS_UPDATE_GOLDEN=1 rồi cập nhật kiểu TS.
func TestSecretsCLIFixtures(t *testing.T) {
	cfg := secretsEnv(t)
	run := func(stdin string, args ...string) string {
		t.Helper()
		r := secretsCall(t, stdin, append(args, "--config", cfg, "--json")...)
		if r.code != 0 && !strings.Contains(r.stdout, `"error"`) {
			t.Fatalf("%v: %+v", args, r)
		}
		return r.stdout
	}
	run(valueJSON(fakeValue), "set", "--name", "DATABASE_URL", "--description-file", descFile(t, "Postgres của môi trường thử"))
	run("", "assign", "--name", "DATABASE_URL", "--project", appLocalID)
	run("", "assign", "--name", "DATABASE_URL", "--project", apiLocalID)
	item := run(valueJSON(fakeValue2), "set", "--name", "STRIPE_TEST_KEY")
	run(valueJSON(fakeValue), "set", "--name", "SENTRY_DSN")
	run("", "assign", "--name", "SENTRY_DSN", "--all-projects")
	reason := "Máy không có kho bí mật (Secret Service). Cài gnome-keyring hoặc KWallet rồi thử lại."
	status, _ := json.Marshal(secretstore.Status{Backend: "secret-service", Reason: &reason})
	fixtures := map[string]string{
		"status.json": string(status) + "\n",
		"list.json":   run("", "list"),
		"item.json":   item,
		"delete.json": run("", "delete", "--name", "STRIPE_TEST_KEY"),
		"error.json":  run(valueJSON(fakeValue), "set", "--name", "PATH"),
	}
	dir := filepath.Join("..", "..", "internal", "secretstore", "testdata", "cli")
	for name, got := range fixtures {
		var pretty bytes.Buffer
		if err := json.Indent(&pretty, []byte(got), "", "  "); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		path := filepath.Join(dir, name)
		if os.Getenv("SECRETS_UPDATE_GOLDEN") == "1" {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, pretty.Bytes(), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		want, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("thiếu fixture (chạy lại với SECRETS_UPDATE_GOLDEN=1): %v", err)
		}
		// So theo giá trị JSON, không theo chữ: autocrlf đổi xuống dòng, biome gộp mảng ngắn về một dòng.
		var wantV, gotV any
		if err := json.Unmarshal(want, &wantV); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if err := json.Unmarshal(pretty.Bytes(), &gotV); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !reflect.DeepEqual(wantV, gotV) {
			t.Errorf("%s lệch kiểu Go; chạy lại với SECRETS_UPDATE_GOLDEN=1 rồi cập nhật kiểu TS.\ncó:\n%s\nmuốn:\n%s", name, want, pretty.String())
		}
	}
}
