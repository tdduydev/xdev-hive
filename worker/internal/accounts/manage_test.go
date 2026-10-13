package accounts

import (
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

const legacy = `{"runner":{"maxParallel":4},"agents":[
 {"id":"claude-3","label":"claude-3","kind":"claude","env":{"CLAUDE_CONFIG_DIR":"~/.xdev-hive/accounts/claude-3","ANTHROPIC_API_KEY":"sk-ant-bimat"},"enabled":true,"priority":30,"maxConcurrent":1,"cooldownMinutes":60,"stopAtSession":80,"stopAtWeek":70,"roles":["implement","research"],"timeoutMinutes":120},
 {"id":"codex-3","label":"duy@xdev.asia","kind":"codex","env":{"CODEX_HOME":"~/.xdev-hive/accounts/codex-3"},"enabled":false,"priority":5,"maxConcurrent":1},
 {"id":"antigravity-1","label":"anti","kind":"antigravity","env":{},"enabled":true,"priority":35}
]}`

func TestImportLegacyOnceWithoutSecrets(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "config.json")
	dst := filepath.Join(dir, "xdev-hive", "accounts.json")
	_ = os.WriteFile(src, []byte(legacy), 0o600)
	n, err := ImportLegacy(src, dst, false)
	if err != nil || n != 3 {
		t.Fatalf("import = %d, %v", n, err)
	}
	b, _ := os.ReadFile(dst)
	if strings.Contains(string(b), "sk-ant") || strings.Contains(string(b), "API_KEY") {
		t.Fatalf("biến môi trường khác của app v1 bị chép: %s", b)
	}
	// Windows không có quyền kiểu Unix: chỉ kiểm trên hệ điều hành có.
	if st, _ := os.Stat(dst); runtime.GOOS != "windows" && st.Mode().Perm() != 0o600 {
		t.Fatalf("quyền file = %v", st.Mode().Perm())
	}
	list, _ := Load(dst)
	if list[0].ConfigDir != "~/.xdev-hive/accounts/claude-3" || list[1].ConfigDir != "~/.xdev-hive/accounts/codex-3" || list[2].CLI != "antigravity" {
		t.Fatalf("list = %+v", list)
	}
	// Ngưỡng, vai trò và thời hạn của app v1 được chép; vai trò worker không giao (research) bị bỏ.
	if c := list[0]; c.StopAtSession != 80 || c.StopAtWeek != 70 || !reflect.DeepEqual(c.Roles, []string{"implement"}) || c.TimeoutMinutes != 120 {
		t.Fatalf("claude-3 = %+v", c)
	}
	if c := list[1]; c.StopAtSession != 95 || c.StopAtWeek != 90 || len(c.Roles) != 3 || c.TimeoutMinutes != 60 {
		t.Fatalf("codex-3 thiếu trường thì lấy mặc định: %+v", c)
	}
	if n, _ := Capacity(dst, 8); n != 4 {
		t.Fatalf("maxParallel của app v1 = %d", n)
	}
	// Lần sau không nhập lại, để bật tắt trong app mới không bị app v1 ghi đè.
	_ = SetEnabled(dst, "codex-3", true)
	if n, _ := ImportLegacy(src, dst, false); n != 0 {
		t.Fatalf("nhập lại khi đã có accounts.json: %d", n)
	}
	list, _ = Load(dst)
	if !list[1].Enabled {
		t.Fatal("SetEnabled không giữ")
	}
	if err := SetEnabled(dst, "khong-co", true); err == nil {
		t.Fatal("tài khoản lạ phải báo lỗi")
	}
	if n, _ := ImportLegacy(filepath.Join(dir, "khong-co.json"), filepath.Join(dir, "x.json"), false); n != 0 {
		t.Fatal("không có app v1 thì không nhập gì")
	}
}

// noCLIs đặt CLI nào có trên PATH cho test, không phụ thuộc máy chạy test.
func noCLIs(t *testing.T, missing ...string) {
	t.Helper()
	saved := lookPath
	lookPath = func(name string) (string, error) {
		for _, m := range missing {
			if m == name {
				return "", errors.New("không có")
			}
		}
		return "/usr/local/bin/" + name, nil
	}
	t.Cleanup(func() { lookPath = saved })
}

func TestViewsReadLoginWithoutTokens(t *testing.T) {
	noCLIs(t)
	home := t.TempDir()
	claudeDir := filepath.Join(home, ".xdev-hive", "accounts", "claude-3")
	codexDir := filepath.Join(home, ".xdev-hive", "accounts", "codex-3")
	_ = os.MkdirAll(claudeDir, 0o700)
	_ = os.MkdirAll(codexDir, 0o700)
	_ = os.WriteFile(filepath.Join(claudeDir, ".claude.json"), []byte(`{"oauthAccount":{"emailAddress":"duy@fpt.com"}}`), 0o600)
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"email":"duy@xdev.asia"}`))
	_ = os.WriteFile(filepath.Join(codexDir, "auth.json"), []byte(`{"tokens":{"id_token":"h.`+payload+`.s","access_token":"bimat"}}`), 0o600)
	st, _ := LoadState(filepath.Join(home, "none.json"))
	views := Views([]Account{
		{ID: "claude-3", CLI: "claude", ConfigDir: "~/.xdev-hive/accounts/claude-3", Enabled: true},
		{ID: "codex-3", CLI: "codex", ConfigDir: "~/.xdev-hive/accounts/codex-3", Enabled: true},
		{ID: "claude-9", CLI: "claude", ConfigDir: "~/.xdev-hive/accounts/claude-9", Enabled: true},
		{ID: "antigravity-1", CLI: "antigravity", Enabled: true},
	}, st, home, t0)
	if !*views[0].LoggedIn || views[0].Email != "duy@fpt.com" {
		t.Fatalf("claude = %+v", views[0])
	}
	if !*views[1].LoggedIn || views[1].Email != "duy@xdev.asia" {
		t.Fatalf("codex = %+v", views[1])
	}
	if *views[2].LoggedIn || views[2].State != StateSignedOut || *views[2].Usage.Reason != "Chưa đăng nhập" {
		t.Fatalf("thư mục chưa đăng nhập: %+v", views[2])
	}
	if views[3].LoggedIn != nil || views[3].Supported || *views[3].Usage.Reason != reasonUnsupported {
		t.Fatalf("antigravity = %+v", views[3])
	}
	if *views[0].Usage.Reason != reasonNotRead {
		t.Fatalf("chưa đọc quota: %+v", views[0].Usage)
	}
}

// Mỗi tài khoản có đúng một trạng thái, cái đầu tiên đúng theo thứ tự của app v1.
func TestViewStateOrder(t *testing.T) {
	noCLIs(t, "codex")
	home := t.TempDir()
	ids := []string{"off", "nocli", "out", "run", "over", "cool", "near", "ready", "resumed"}
	var list []Account
	for _, id := range ids {
		a := Account{ID: id, CLI: "claude", ConfigDir: "~/" + id, Enabled: id != "off"}.withDefaults()
		if id == "nocli" {
			a.CLI = "codex"
		}
		if id != "out" {
			signIn(t, home, a.ConfigDir, a.CLI)
		}
		list = append(list, a)
	}
	later := t0.Add(time.Hour)
	st, _ := LoadState(filepath.Join(home, "none.json"))
	over := Usage{Session: &Limit{Percent: 97, ResetsAt: &later}, Week: &Limit{Percent: 50}}
	for _, id := range ids {
		st.Usage[id] = Usage{Session: &Limit{Percent: 10}, Week: &Limit{Percent: 20}}
	}
	// Đang chạy thắng chạm ngưỡng: việc máy đang làm hiện trước.
	st.Active["run"], st.Usage["run"] = 1, over
	st.Usage["over"], st.CoolUntil["over"] = over, later
	st.CoolUntil["cool"] = later
	st.Usage["near"] = Usage{Session: &Limit{Percent: 30}, Week: &Limit{Percent: 86}}
	st.Usage["resumed"], st.ResumeUntil["resumed"] = over, later
	views := Views(list, st, home, t0)
	want := []string{StateDisabled, StateNoCLI, StateSignedOut, StateRunning, StateOverLimit, StateCooling, StateNear, StateReady, StateNear}
	for i, v := range views {
		if v.State != want[i] {
			t.Fatalf("%s: state = %s, muốn %s", v.ID, v.State, want[i])
		}
	}
	if views[5].CoolUntil == nil || !views[5].CoolUntil.Equal(later) || views[8].ResumeUntil == nil || views[3].Active != 1 {
		t.Fatalf("giờ nghỉ, Dùng tiếp, active = %+v / %+v / %+v", views[5], views[8], views[3])
	}
	// Giờ nghỉ đã qua thì không hiện.
	if v := Views(list[5:6], st, home, later.Add(time.Second))[0]; v.CoolUntil != nil || v.State != StateReady {
		t.Fatalf("hết nghỉ: %+v", v)
	}
}

func TestAddCreatesIDAndDir(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(t.TempDir(), "accounts.json")
	// Tài khoản đầu tiên của CLI dùng đăng nhập mặc định của máy.
	first, command, env, err := Add(path, home, "claude", "  Gói Max  ", "", "")
	if err != nil || first.ID != "claude-1" || first.ConfigDir != "" || first.Label != "Gói Max" || command != "claude auth login" || len(env) != 0 {
		t.Fatalf("claude đầu = %+v %q %v %v", first, command, env, err)
	}
	if !first.Enabled || first.StopAtSession != 95 || first.StopAtWeek != 90 || first.TimeoutMinutes != 60 || len(first.Roles) != 3 {
		t.Fatalf("mặc định của tài khoản mới: %+v", first)
	}
	second, command, env, err := Add(path, home, "claude", "Công ty", "sso", "duy@fpt.com")
	dir := filepath.Join(home, ".xdev-hive", "accounts", "claude-2")
	if err != nil || second.ID != "claude-2" || second.ConfigDir != "~/.xdev-hive/accounts/claude-2" || command != "claude auth login --sso --email duy@fpt.com" || env["CLAUDE_CONFIG_DIR"] != dir {
		t.Fatalf("claude sau = %+v %q %v %v", second, command, env, err)
	}
	st, err := os.Stat(dir)
	if err != nil || !st.IsDir() || (runtime.GOOS != "windows" && st.Mode().Perm() != 0o700) {
		t.Fatalf("thư mục đăng nhập: %v %v", st, err)
	}
	if _, command, _, _ := Add(path, home, "claude", "Console", "console", ""); command != "claude auth login --console" {
		t.Fatalf("console: %q", command)
	}
	codex, command, env, _ := Add(path, home, "codex", "ChatGPT", "device", "")
	if codex.ID != "codex-1" || codex.ConfigDir != "" || command != "codex login --device-auth" || len(env) != 0 {
		t.Fatalf("codex = %+v %q %v", codex, command, env)
	}
	if _, command, env, _ := Add(path, home, "codex", "ChatGPT 2", "browser", ""); command != "codex login" || env["CODEX_HOME"] != filepath.Join(home, ".xdev-hive", "accounts", "codex-2") {
		t.Fatalf("codex browser: %q %v", command, env)
	}
	// Id nhỏ nhất còn trống: xoá claude-1 thì lần thêm sau lấy lại claude-1, có thư mục riêng vì đã có claude-2.
	if err := Remove(path, "claude-1", t0); err != nil {
		t.Fatal(err)
	}
	again, _, _, _ := Add(path, home, "claude", "Lại", "plan", "")
	if again.ID != "claude-1" || again.ConfigDir != "~/.xdev-hive/accounts/claude-1" {
		t.Fatalf("thêm lại = %+v", again)
	}
	for _, bad := range []struct{ cli, label, how, email string }{
		{"gemini", "x", "", ""},
		{"claude", "  ", "", ""},
		{"claude", strings.Repeat("a", 81), "", ""},
		{"claude", "x", "device", ""},
		{"codex", "x", "sso", ""},
		{"codex", "x", "", "duy@fpt.com"},
		{"claude", "x", "", "duy@fpt.com; rm -rf ~"},
		{"claude", "x", "", "khong-phai-email"},
	} {
		if _, _, _, err := Add(path, home, bad.cli, bad.label, bad.how, bad.email); err == nil {
			t.Fatalf("phải báo lỗi: %+v", bad)
		}
	}
	list, _ := Load(path)
	if len(list) != 5 {
		t.Fatalf("lệnh lỗi không được thêm gì: %d", len(list))
	}
}

func intp(v int) *int { return &v }

func TestUpdateChecksRanges(t *testing.T) {
	path := filepath.Join(t.TempDir(), "accounts.json")
	_ = os.WriteFile(path, []byte(three), 0o600)
	label := " Gói chính "
	err := Update(path, "claude-4", Changes{Label: &label, Priority: intp(70), MaxConcurrent: intp(3), CooldownMinutes: intp(30), StopAtSession: intp(80), StopAtWeek: intp(75), TimeoutMinutes: intp(90), Roles: []string{"review", " plan", "review"}})
	if err != nil {
		t.Fatal(err)
	}
	list, _ := Load(path)
	got := list[1]
	if got.Label != "Gói chính" || got.Priority != 70 || got.MaxConcurrent != 3 || got.CooldownMinutes != 30 || got.StopAtSession != 80 || got.StopAtWeek != 75 || got.TimeoutMinutes != 90 || !reflect.DeepEqual(got.Roles, []string{"review", "plan"}) {
		t.Fatalf("update = %+v", got)
	}
	// Chỉ đổi trường được đặt.
	if err := Update(path, "claude-4", Changes{Priority: intp(0)}); err != nil {
		t.Fatal(err)
	}
	list, _ = Load(path)
	if list[1].Priority != 0 || list[1].StopAtSession != 80 {
		t.Fatalf("đổi một trường: %+v", list[1])
	}
	empty := ""
	for _, bad := range []Changes{
		{Priority: intp(101)}, {Priority: intp(-1)},
		{MaxConcurrent: intp(0)}, {MaxConcurrent: intp(9)},
		{CooldownMinutes: intp(0)}, {CooldownMinutes: intp(1441)},
		{StopAtSession: intp(0)}, {StopAtSession: intp(101)},
		{StopAtWeek: intp(0)}, {StopAtWeek: intp(101)},
		{TimeoutMinutes: intp(0)}, {TimeoutMinutes: intp(721)},
		{Roles: []string{""}}, {Roles: []string{"research"}},
		{Label: &empty},
		// Một trường sai thì không đổi trường nào.
		{Priority: intp(50), StopAtWeek: intp(200)},
	} {
		if err := Update(path, "claude-4", bad); err == nil {
			t.Fatalf("phải báo lỗi: %+v", bad)
		}
	}
	list, _ = Load(path)
	if list[1].Priority != 0 {
		t.Fatalf("lệnh lỗi đã đổi file: %+v", list[1])
	}
	if err := Update(path, "khong-co", Changes{Priority: intp(1)}); err == nil {
		t.Fatal("tài khoản lạ phải báo lỗi")
	}
}

func TestRemoveKeepsLoginDir(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(t.TempDir(), "accounts.json")
	_, _, _, _ = Add(path, home, "codex", "a", "", "")
	b, _, _, _ := Add(path, home, "codex", "b", "", "")
	_ = UpdateState(StatePath(path), t0, func(s *State) {
		s.CoolUntil[b.ID] = t0.Add(time.Hour)
		s.Usage[b.ID] = Usage{Week: &Limit{Percent: 50}}
	})
	if err := Remove(path, b.ID, t0); err != nil {
		t.Fatal(err)
	}
	list, _ := Load(path)
	st, _ := LoadState(StatePath(path))
	if len(list) != 1 || list[0].ID != "codex-1" {
		t.Fatalf("list = %+v", list)
	}
	if _, ok := st.Usage[b.ID]; ok || !st.CoolUntil[b.ID].IsZero() {
		t.Fatalf("trạng thái của tài khoản đã xoá còn: %+v", st)
	}
	if _, err := os.Stat(filepath.Join(home, ".xdev-hive", "accounts", "codex-2")); err != nil {
		t.Fatalf("thư mục đăng nhập phải còn: %v", err)
	}
	if err := Remove(path, "codex-9", t0); err == nil {
		t.Fatal("tài khoản lạ phải báo lỗi")
	}
}

func TestResumeUntilResetOfBarOverLimit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "accounts.json")
	_ = os.WriteFile(path, []byte(three), 0o600)
	sessionReset, weekReset := t0.Add(2*time.Hour), t0.Add(50*time.Hour)
	cases := []struct {
		usage Usage
		want  time.Time
	}{
		{Usage{Session: &Limit{Percent: 96, ResetsAt: &sessionReset}, Week: &Limit{Percent: 10, ResetsAt: &weekReset}}, sessionReset},
		// Cả hai vượt: tới lần reset muộn hơn, vì thanh kia vẫn còn chặn.
		{Usage{Session: &Limit{Percent: 96, ResetsAt: &sessionReset}, Week: &Limit{Percent: 91, ResetsAt: &weekReset}}, weekReset},
		{Usage{Session: &Limit{Percent: 100}}, t0.Add(5 * time.Hour)},
		// Không thanh nào vượt (chỉ đang nghỉ): bỏ nghỉ, không giữ Dùng tiếp.
		{Usage{Session: &Limit{Percent: 20}}, time.Time{}},
	}
	for i, c := range cases {
		_ = UpdateState(StatePath(path), t0, func(s *State) {
			s.Usage["claude-3"] = c.usage
			s.CoolUntil["claude-3"] = t0.Add(time.Hour)
		})
		if err := Resume(path, "claude-3", t0); err != nil {
			t.Fatal(err)
		}
		st, _ := LoadState(StatePath(path))
		if !st.CoolUntil["claude-3"].IsZero() || !st.ResumeUntil["claude-3"].Equal(c.want) {
			t.Fatalf("case %d: cool %v, resume %v, muốn %v", i, st.CoolUntil["claude-3"], st.ResumeUntil["claude-3"], c.want)
		}
	}
	if err := Resume(path, "khong-co", t0); err == nil {
		t.Fatal("tài khoản lạ phải báo lỗi")
	}
}
