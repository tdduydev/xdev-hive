package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/zalando/go-keyring"

	"github.com/tdduydev/xdev-hive/worker/internal/projects"
	"github.com/tdduydev/xdev-hive/worker/internal/secretstore"
)

const transferPassword = "correct horse battery staple"

func passwordJSON(p string) string { return string(mustJSON(map[string]string{"password": p})) }

// transferEnv thêm vào secretsEnv: Argon2 nhẹ cho test và remote giả cho hai dự án (thư mục không có thật).
func transferEnv(t *testing.T, origins map[string]string) string {
	t.Helper()
	cfg := secretsEnv(t)
	oldKDF := secretstore.DefaultKDF
	secretstore.DefaultKDF = secretstore.KDFParams{Time: 1, Memory: 8 << 10, Threads: 1}
	t.Cleanup(func() { secretstore.DefaultKDF = oldKDF })
	oldOrigin := secretsOrigin
	secretsOrigin = func(folder string) (string, error) {
		if u, ok := origins[folder]; ok {
			return u, nil
		}
		return "", errors.New("no remote")
	}
	t.Cleanup(func() { secretsOrigin = oldOrigin })
	return cfg
}

// seedSecrets dựng ba bí mật: một gán cho app và api, một không gán, một dùng chung.
func seedSecrets(t *testing.T, cfg string) {
	t.Helper()
	for _, args := range [][]string{
		{"set", "--name", "DATABASE_URL", "--description-file", descFile(t, "Postgres của môi trường thử")},
		{"assign", "--name", "DATABASE_URL", "--project", appLocalID},
		{"assign", "--name", "DATABASE_URL", "--project", apiLocalID},
		{"set", "--name", "STRIPE_TEST_KEY"},
		{"set", "--name", "SENTRY_DSN"},
		{"assign", "--name", "SENTRY_DSN", "--all-projects"},
	} {
		stdin := ""
		if args[0] == "set" {
			stdin = valueJSON(fakeValue)
			if args[2] == "STRIPE_TEST_KEY" {
				stdin = valueJSON(fakeValue2)
			}
		}
		if r := secretsCall(t, stdin, append(args, "--config", cfg)...); r.code != 0 {
			t.Fatalf("%v: %+v", args, r)
		}
	}
}

func decodeImport(t *testing.T, r secretsRun) importView {
	t.Helper()
	var v importView
	if r.code != 0 || json.Unmarshal([]byte(r.stdout), &v) != nil {
		t.Fatalf("import: %+v", r)
	}
	return v
}

func itemByName(t *testing.T, v importView, name string) importItem {
	t.Helper()
	for _, it := range v.Items {
		if it.Name == name {
			return it
		}
	}
	t.Fatalf("không có %s trong %+v", name, v.Items)
	return importItem{}
}

func exportTo(t *testing.T, cfg, out string, extra ...string) secretsRun {
	t.Helper()
	return secretsCall(t, passwordJSON(transferPassword), append([]string{"export", "--config", cfg, "--out", out}, extra...)...)
}

// Xuất ở máy này rồi nhập ở "máy khác" (cấu hình mới, kho rỗng): dự án khớp theo remote, không thì theo tên.
func TestSecretsExportImportRoundTrip(t *testing.T) {
	origins := map[string]string{"/home/dev/app": "https://user:pw@git.example.test/acme/app.git"}
	cfg := transferEnv(t, origins)
	seedSecrets(t, cfg)
	out := filepath.Join(t.TempDir(), "backup.hivesecrets")
	r := exportTo(t, cfg, out)
	var ev exportView
	if r.code != 0 || json.Unmarshal([]byte(r.stdout), &ev) != nil || ev.Out != out ||
		!reflect.DeepEqual(ev.Names, []string{"DATABASE_URL", "SENTRY_DSN", "STRIPE_TEST_KEY"}) {
		t.Fatalf("export: %+v", r)
	}
	file, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{fakeValue, fakeValue2, "DATABASE_URL", "git.example.test", transferPassword} {
		if bytes.Contains(file, []byte(s)) {
			t.Errorf("file xuất lộ %q", s)
		}
	}
	if runtime.GOOS != "windows" {
		if st, _ := os.Stat(out); st.Mode().Perm() != 0o600 {
			t.Errorf("quyền file xuất %v", st.Mode().Perm())
		}
	}
	// Remote trong file đã bỏ tên đăng nhập và mật khẩu.
	secrets, err := secretstore.Open(file, transferPassword)
	if err != nil {
		t.Fatal(err)
	}
	if got := secrets[0].Projects; len(got) != 2 || got[0].Name != "app" || got[0].RemoteURL != "https://git.example.test/acme/app.git" || got[1].RemoteURL != "" {
		t.Fatalf("dự án trong file: %+v", got)
	}

	// Máy mới: app ở thư mục khác nhưng cùng remote, api không có, có thêm dự án "web".
	keyring.MockInit()
	cfg2 := filepath.Join(t.TempDir(), "worker.json")
	list := map[string]any{"projects": []projects.Project{
		{LocalID: "3333333333333333", Name: "app-moved", Folder: "/srv/app"},
		{LocalID: "4444444444444444", Name: "web", Folder: "/srv/web"},
	}}
	if err := os.WriteFile(projects.DefaultPath(cfg2), mustJSON(list), 0o600); err != nil {
		t.Fatal(err)
	}
	origins["/srv/app"] = "git@git.example.test:acme/app.git"

	pv := decodeImport(t, secretsCall(t, passwordJSON(transferPassword), "import", "--config", cfg2, "--in", out, "--dry-run"))
	if !pv.DryRun || len(pv.Items) != 3 {
		t.Fatalf("xem trước: %+v", pv)
	}
	db := itemByName(t, pv, "DATABASE_URL")
	if db.Status != importNew || db.Action != actionCreate || len(db.Projects) != 1 || db.Projects[0].LocalID != "3333333333333333" ||
		len(db.Unmatched) != 1 || db.Unmatched[0].Name != "api" {
		t.Fatalf("DATABASE_URL xem trước: %+v", db)
	}
	if strings.Contains(pv2s(pv), fakeValue) {
		t.Fatal("xem trước in giá trị")
	}
	if _, err := secretstore.NewStore().Get("DATABASE_URL"); !errors.Is(err, secretstore.ErrMissing) {
		t.Fatal("xem trước mà ghi kho")
	}
	if cat, _ := secretstore.LoadCatalog(secretstore.CatalogPath(cfg2)); len(cat.Secrets) != 0 {
		t.Fatal("xem trước mà ghi danh mục")
	}

	iv := decodeImport(t, secretsCall(t, passwordJSON(transferPassword), "import", "--config", cfg2, "--in", out))
	if iv.DryRun || !reflect.DeepEqual(iv.Items, pv.Items) {
		t.Fatalf("nhập thật khác xem trước:\n%+v\n%+v", iv.Items, pv.Items)
	}
	store := secretstore.NewStore()
	if v, _ := store.Get("DATABASE_URL"); v != fakeValue {
		t.Fatal("thiếu giá trị DATABASE_URL")
	}
	if v, _ := store.Get("STRIPE_TEST_KEY"); v != fakeValue2 {
		t.Fatal("thiếu giá trị STRIPE_TEST_KEY")
	}
	cat, _ := secretstore.LoadCatalog(secretstore.CatalogPath(cfg2))
	if s := cat.Find("DATABASE_URL"); s == nil || s.Description != "Postgres của môi trường thử" || !reflect.DeepEqual(s.Projects, []string{"3333333333333333"}) {
		t.Fatalf("DATABASE_URL: %+v", s)
	}
	if s := cat.Find("SENTRY_DSN"); s == nil || !s.AllProjects {
		t.Fatalf("SENTRY_DSN: %+v", s)
	}

	// Nhập lại: cùng giá trị thì bỏ qua, ghi đè cũng không đổi giờ đặt giá trị.
	again := decodeImport(t, secretsCall(t, passwordJSON(transferPassword), "import", "--config", cfg2, "--in", out, "--on-conflict", "overwrite"))
	for _, it := range again.Items {
		if it.Status != importSameValue || it.Action != actionOverwrite || len(it.Projects) != 0 {
			t.Errorf("nhập lại %s: %+v", it.Name, it)
		}
	}

	log, _ := secretstore.ReadLog(secretstore.GrantsPath(cfg), secretstore.LogFilter{}, secretstore.Catalog{})
	if len(log) == 0 || log[0].Kind != secretstore.KindExport || len(log[0].Names) != 3 {
		t.Fatalf("nhật ký xuất: %+v", log)
	}
	log, _ = secretstore.ReadLog(secretstore.GrantsPath(cfg2), secretstore.LogFilter{}, secretstore.Catalog{})
	if len(log) != 2 || log[0].Kind != secretstore.KindImport || log[1].Kind != secretstore.KindImport {
		t.Fatalf("nhật ký nhập: %+v", log)
	}
}

func pv2s(v importView) string { return string(mustJSON(v)) }

func TestSecretsImportConflicts(t *testing.T) {
	cfg := transferEnv(t, nil)
	seedSecrets(t, cfg)
	out := filepath.Join(t.TempDir(), "backup.hivesecrets")
	if r := exportTo(t, cfg, out, "--name", "database_url", "--name", "STRIPE_TEST_KEY"); r.code != 0 {
		t.Fatalf("export: %+v", r)
	}
	// Đổi giá trị và mô tả ở máy sau khi xuất.
	if r := secretsCall(t, valueJSON(fakeValue2), "set", "--config", cfg, "--name", "DATABASE_URL", "--description-file", descFile(t, "mô tả mới")); r.code != 0 {
		t.Fatalf("set: %+v", r)
	}
	if r := secretsCall(t, "", "unassign", "--config", cfg, "--name", "DATABASE_URL", "--project", apiLocalID); r.code != 0 {
		t.Fatalf("unassign: %+v", r)
	}

	skip := decodeImport(t, secretsCall(t, passwordJSON(transferPassword), "import", "--config", cfg, "--in", out))
	db := itemByName(t, skip, "DATABASE_URL")
	if db.Status != importSameName || db.Action != actionSkip || len(db.Projects) != 0 {
		t.Fatalf("bỏ qua: %+v", db)
	}
	if st := itemByName(t, skip, "STRIPE_TEST_KEY"); st.Status != importSameValue || st.Action != actionSkip {
		t.Fatalf("cùng giá trị: %+v", st)
	}
	if v, _ := secretstore.NewStore().Get("DATABASE_URL"); v != fakeValue2 {
		t.Fatal("bỏ qua mà vẫn ghi đè")
	}

	over := decodeImport(t, secretsCall(t, passwordJSON(transferPassword), "import", "--config", cfg, "--in", out, "--on-conflict", "overwrite"))
	db = itemByName(t, over, "DATABASE_URL")
	if db.Status != importSameName || db.Action != actionOverwrite || len(db.Projects) != 1 || db.Projects[0] != (importProject{apiLocalID, "api"}) {
		t.Fatalf("ghi đè: %+v", db)
	}
	if v, _ := secretstore.NewStore().Get("DATABASE_URL"); v != fakeValue {
		t.Fatal("ghi đè không đổi giá trị")
	}
	cat, _ := secretstore.LoadCatalog(secretstore.CatalogPath(cfg))
	if s := cat.Find("DATABASE_URL"); s.Description != "Postgres của môi trường thử" || len(s.Projects) != 2 {
		t.Fatalf("ghi đè danh mục: %+v", s)
	}
}

// Giới hạn 64 mỗi dự án: gán vượt bị liệt kê, bí mật vẫn được nhập, các mục khác vẫn chạy (FR-068).
func TestSecretsImportLimit(t *testing.T) {
	cfg := transferEnv(t, nil)
	var b strings.Builder
	for i := range secretstore.MaxPerProject + 1 {
		fmt.Fprintf(&b, "KEY_%02d=value-%02d-padding\n", i, i)
	}
	env := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(env, []byte(b.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	v := decodeImport(t, secretsCall(t, "", "import", "--config", cfg, "--env", env, "--project", appLocalID))
	if len(v.Items) != secretstore.MaxPerProject+1 {
		t.Fatalf("số mục: %d", len(v.Items))
	}
	last := v.Items[secretstore.MaxPerProject]
	if last.Name != "KEY_64" || last.Action != actionCreate || len(last.Projects) != 0 || len(last.Limited) != 1 || last.Limited[0].LocalID != appLocalID {
		t.Fatalf("mục vượt giới hạn: %+v", last)
	}
	if v.Items[0].Line != 1 || len(v.Items[0].Projects) != 1 {
		t.Fatalf("mục đầu: %+v", v.Items[0])
	}
	cat, _ := secretstore.LoadCatalog(secretstore.CatalogPath(cfg))
	if len(cat.Secrets) != secretstore.MaxPerProject+1 || len(cat.ForProject(appLocalID)) != secretstore.MaxPerProject {
		t.Fatalf("danh mục: %d bí mật, %d cho app", len(cat.Secrets), len(cat.ForProject(appLocalID)))
	}
}

func TestSecretsImportEnv(t *testing.T) {
	cfg := transferEnv(t, nil)
	if r := secretsCall(t, valueJSON(fakeValue2), "set", "--config", cfg, "--name", "API_KEY", "--description-file", descFile(t, "giữ mô tả")); r.code != 0 {
		t.Fatalf("set: %+v", r)
	}
	env := filepath.Join(t.TempDir(), ".env")
	src := "# môi trường thử\nexport API_KEY=\"" + fakeValue + "\"\nnot a line\nPATH=/bin\nNEW_ONE='" + fakeValue + "'\n"
	if err := os.WriteFile(env, []byte(src), 0o600); err != nil {
		t.Fatal(err)
	}
	r := secretsCall(t, "", "import", "--config", cfg, "--env", env, "--on-conflict", "overwrite", "--all-projects")
	if strings.Contains(r.stdout+r.stderr, fakeValue) {
		t.Fatal("output chứa giá trị")
	}
	v := decodeImport(t, r)
	var got []string
	for _, it := range v.Items {
		code := ""
		if it.Error != nil {
			code = it.Error.Code
		}
		got = append(got, fmt.Sprintf("%d %s %s %s %v %s", it.Line, it.Name, it.Status, it.Action, it.AllProjects, code))
	}
	want := []string{
		"2 API_KEY same_name overwrite true ",
		"3  invalid skip false file_format",
		"4 PATH invalid skip false reserved_name",
		"5 NEW_ONE new create true ",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mục:\n%s\nmuốn\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	if v, _ := secretstore.NewStore().Get("API_KEY"); v != fakeValue {
		t.Fatal("chưa ghi đè API_KEY")
	}
	cat, _ := secretstore.LoadCatalog(secretstore.CatalogPath(cfg))
	if s := cat.Find("API_KEY"); s.Description != "giữ mô tả" || !s.AllProjects {
		t.Fatalf("API_KEY: %+v", s)
	}

	if r := secretsCall(t, "", "import", "--config", cfg, "--env", env, "--project", "ffffffffffffffff"); r.errCode(t) != secretstore.CodeNotFound {
		t.Fatal("dự án không có")
	}
	for _, args := range [][]string{
		{"import", "--env", env, "--project", appLocalID, "--all-projects"},
		{"import", "--env", env, "--in", env},
		{"import"},
		{"import", "--env", env, "--on-conflict", "replace"},
		{"import", "--in", env, "--project", appLocalID},
		{"export"},
		{"export", "--out", env, "--dry-run"},
		{"export", "--out", env, fakeValue},
	} {
		r := secretsCall(t, "", append(args, "--config", cfg)...)
		if r.code != 2 || strings.Contains(r.stdout+r.stderr, fakeValue) {
			t.Errorf("%v phải là lỗi cú pháp: %+v", args, r)
		}
	}
}

// Mật khẩu chỉ đi qua stdin; mật khẩu yếu, sai, file có sẵn đều báo lỗi mà không in lại mật khẩu (FR-067, FR-068).
func TestSecretsTransferErrors(t *testing.T) {
	cfg := transferEnv(t, nil)
	seedSecrets(t, cfg)
	dir := t.TempDir()
	out := filepath.Join(dir, "backup.hivesecrets")
	check := func(label string, r secretsRun, wantCode string) {
		t.Helper()
		if got := r.errCode(t); got != wantCode {
			t.Errorf("%s: mã %s, muốn %s", label, got, wantCode)
		}
		if strings.Contains(r.stdout+r.stderr, transferPassword) || strings.Contains(r.stdout+r.stderr, "short-pass") {
			t.Errorf("%s: output chứa mật khẩu", label)
		}
	}
	check("mật khẩu yếu", secretsCall(t, passwordJSON("short-pass"), "export", "--config", cfg, "--out", out), secretstore.CodeWeakPassword)
	check("stdin không phải JSON", secretsCall(t, transferPassword, "export", "--config", cfg, "--out", out), secretstore.CodeInvalidValue)
	check("trường lạ", secretsCall(t, `{"password":"`+transferPassword+`","x":1}`, "export", "--config", cfg, "--out", out), secretstore.CodeInvalidValue)
	check("tên không có", secretsCall(t, passwordJSON(transferPassword), "export", "--config", cfg, "--out", out, "--name", "NOPE"), secretstore.CodeNotFound)
	if _, err := os.Stat(out); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("lỗi mà vẫn ghi file")
	}
	if r := secretsCall(t, transferPassword, "export", "--config", cfg, "--out", out, "--password", transferPassword); r.code != 2 || strings.Contains(r.stdout+r.stderr, transferPassword) {
		t.Fatalf("--password: %+v", r)
	}

	if r := exportTo(t, cfg, out); r.code != 0 {
		t.Fatalf("export: %+v", r)
	}
	first, _ := os.ReadFile(out)
	check("file đã có", exportTo(t, cfg, out), secretstore.CodeFileExists)
	if r := exportTo(t, cfg, out, "--force"); r.code != 0 {
		t.Fatalf("--force: %+v", r)
	}
	if second, _ := os.ReadFile(out); bytes.Equal(first, second) {
		t.Fatal("--force không ghi lại")
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Fatalf("còn file tạm: %v", entries)
	}

	check("sai mật khẩu", secretsCall(t, passwordJSON(transferPassword+"!"), "import", "--config", cfg, "--in", out, "--dry-run"), secretstore.CodeDecryptFailed)
	tampered := filepath.Join(dir, "tampered.hivesecrets")
	b, _ := os.ReadFile(out)
	i := bytes.Index(b, []byte(`"data": "`)) + len(`"data": "`) + 10
	b[i] = map[bool]byte{true: 'A', false: 'B'}[b[i] != 'A']
	if err := os.WriteFile(tampered, b, 0o600); err != nil {
		t.Fatal(err)
	}
	check("file bị sửa", secretsCall(t, passwordJSON(transferPassword), "import", "--config", cfg, "--in", tampered), secretstore.CodeDecryptFailed)
	check("không phải file xuất", secretsCall(t, passwordJSON(transferPassword), "import", "--config", cfg, "--in", projects.DefaultPath(cfg)), secretstore.CodeFileFormat)
}

// Fixture cho kiểu TS của desktop, cùng chỗ và cùng cách với TestSecretsCLIFixtures.
func TestSecretsTransferFixtures(t *testing.T) {
	origins := map[string]string{"/home/dev/app": "https://git.example.test/acme/app.git"}
	cfg := transferEnv(t, origins)
	seedSecrets(t, cfg)
	out := filepath.Join(t.TempDir(), "backup.hivesecrets")
	export := exportTo(t, cfg, out)
	if export.code != 0 {
		t.Fatalf("export: %+v", export)
	}
	// Đường dẫn tạm đổi mỗi lần chạy; fixture giữ một đường dẫn cố định.
	export.stdout = strings.Replace(export.stdout, string(mustJSON(out)), `"/home/dev/backup.hivesecrets"`, 1)

	if r := secretsCall(t, valueJSON(fakeValue2), "set", "--config", cfg, "--name", "DATABASE_URL"); r.code != 0 {
		t.Fatalf("set: %+v", r)
	}
	if r := secretsCall(t, "", "delete", "--config", cfg, "--name", "STRIPE_TEST_KEY"); r.code != 0 {
		t.Fatalf("delete: %+v", r)
	}
	if r := secretsCall(t, "", "unassign", "--config", cfg, "--name", "DATABASE_URL", "--project", apiLocalID); r.code != 0 {
		t.Fatalf("unassign: %+v", r)
	}
	// Đổi tên dự án api để nó không khớp được: hiện ở unmatched.
	list := map[string]any{"projects": []projects.Project{
		{LocalID: appLocalID, Name: "app", Folder: "/home/dev/app"},
		{LocalID: apiLocalID, Name: "api-v2", Folder: "/home/dev/api"},
	}}
	if err := os.WriteFile(projects.DefaultPath(cfg), mustJSON(list), 0o600); err != nil {
		t.Fatal(err)
	}
	preview := secretsCall(t, passwordJSON(transferPassword), "import", "--config", cfg, "--in", out, "--dry-run", "--on-conflict", "overwrite", "--json")
	imported := secretsCall(t, passwordJSON(transferPassword), "import", "--config", cfg, "--in", out, "--on-conflict", "overwrite", "--json")
	env := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(env, []byte("NEW_TOKEN="+fakeValue+"\nDATABASE_URL="+fakeValue+"\n1BAD=x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	importEnv := secretsCall(t, "", "import", "--config", cfg, "--env", env, "--project", appLocalID, "--dry-run", "--json")

	fixtures := map[string]secretsRun{
		"export.json":         export,
		"import-preview.json": preview,
		"import.json":         imported,
		"import-env.json":     importEnv,
	}
	dir := filepath.Join("..", "..", "internal", "secretstore", "testdata", "cli")
	for name, r := range fixtures {
		if r.code != 0 {
			t.Fatalf("%s: %+v", name, r)
		}
		var pretty bytes.Buffer
		if err := json.Indent(&pretty, []byte(r.stdout), "", "  "); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		path := filepath.Join(dir, name)
		if os.Getenv("SECRETS_UPDATE_GOLDEN") == "1" {
			if err := os.WriteFile(path, pretty.Bytes(), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		want, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("thiếu fixture (chạy lại với SECRETS_UPDATE_GOLDEN=1): %v", err)
		}
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
