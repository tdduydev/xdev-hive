package gitgroups

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestRepoDirRejectsUnsafePaths(t *testing.T) {
	root := t.TempDir()
	dir, err := RepoDir(root, "acme/payments/api")
	if err != nil || dir != filepath.Join(root, "acme", "payments", "api") {
		t.Fatalf("RepoDir = %q, %v", dir, err)
	}
	for _, bad := range []string{"acme/../x", "acme//x", "acme/con", "acme/NUL.txt", `acme/a\b`, "acme/a:b", "acme/x.", "/abs", "acme/\x01"} {
		if _, err := RepoDir(root, bad); err == nil {
			t.Errorf("RepoDir(%q) không báo lỗi", bad)
		}
	}
	if _, err := RepoDir("relative", "a/b"); err == nil {
		t.Error("gốc tương đối không báo lỗi")
	}
}

func TestRepoDirAtLevel(t *testing.T) {
	root := t.TempDir()
	for _, tc := range []struct {
		group, repo string
		level       int
		want        []string
	}{
		{"acme", "acme/pay/api", 0, []string{"acme", "pay", "api"}},
		{"acme", "acme/pay/api", 1, []string{"pay", "api"}},
		{"ACME", "acme/web", 1, []string{"web"}},
		{"acme/pay", "acme/pay/api", 1, []string{"pay", "api"}},
		{"acme/pay", "acme/pay/api", 2, []string{"api"}},
		// Repo không nằm dưới group, hay nhóm cũ chưa có đường dẫn group: luôn theo đường dẫn đầy đủ.
		{"acme", "other/api", 1, []string{"other", "api"}},
		{"", "acme/api", 1, []string{"acme", "api"}},
	} {
		g := Group{Path: tc.group, Root: root}
		dir, err := repoDir(g, tc.repo, tc.level)
		if want := filepath.Join(append([]string{root}, tc.want...)...); err != nil || dir != want {
			t.Errorf("repoDir(%q, %q, %d) = %q, %v; muốn %q", tc.group, tc.repo, tc.level, dir, err, want)
		}
	}
	if _, err := repoDir(Group{Path: "acme", Root: root}, "acme/../x", 1); err == nil {
		t.Error("đường dẫn ra ngoài thư mục gốc không báo lỗi")
	}
	if levels(Group{Path: "acme/pay"}) != 3 || levels(Group{}) != 1 {
		t.Errorf("levels = %d, %d", levels(Group{Path: "acme/pay"}), levels(Group{}))
	}
	if runtime.GOOS != "windows" {
		return
	}
	// Gốc chọn từ hộp thoại Windows: gạch ngược, gạch cuối, gạch xuôi đều ra cùng thư mục.
	want := `E:\Codes\acme-ai\his\backend\his-service`
	for _, r := range []string{`E:\Codes\acme-ai`, `E:\Codes\acme-ai\`, `E:/Codes/acme-ai`} {
		g := Group{Path: "acme-ai", Root: r}
		if dir, err := repoDir(g, "acme-ai/his/backend/his-service", 1); err != nil || dir != want {
			t.Errorf("repoDir(%q) = %q, %v", r, dir, err)
		}
	}
}

func TestNormalizeHostAndGroupPath(t *testing.T) {
	h, err := NormalizeHost(KindGitLab, "git.acme.vn/", "")
	if err != nil || h.URL != "https://git.acme.vn" || h.Name != "git.acme.vn" {
		t.Fatalf("host = %+v, %v", h, err)
	}
	if h, _ := NormalizeHost(KindGitHub, "", ""); h.URL != "https://github.com" {
		t.Fatalf("github mặc định = %+v", h)
	}
	for _, bad := range []string{"https://u:p@git.acme.vn", "ftp://x", "https://x?a=1"} {
		if _, err := NormalizeHost(KindGitLab, bad, ""); err == nil {
			t.Errorf("NormalizeHost(%q) không báo lỗi", bad)
		}
	}
	if _, err := NormalizeHost("bitbucket", "", ""); err == nil {
		t.Error("loại lạ không báo lỗi")
	}
	if p, err := NormalizeGroupPath(h, "https://git.acme.vn/acme/pay/"); err != nil || p != "acme/pay" {
		t.Fatalf("dán URL group = %q, %v", p, err)
	}
	if _, err := NormalizeGroupPath(Host{Kind: KindGitHub, URL: "https://github.com"}, "acme/x"); err == nil {
		t.Error("GitHub nhận đường dẫn hai đoạn")
	}
	if _, err := NormalizeGroupPath(h, "acme/../x"); err == nil {
		t.Error("nhận ..")
	}
}

func TestSelectedAndChecks(t *testing.T) {
	g := Group{
		Filter:   "^acme/(api|web)",
		Excluded: []string{"ACME/web"},
		Repos: []Repo{
			{Path: "acme/api"}, {Path: "acme/web"}, {Path: "acme/api-old", Archived: true}, {Path: "acme/docs"},
		},
	}
	got, err := Selected(g)
	if err != nil || len(got) != 1 || got[0].Path != "acme/api" {
		t.Fatalf("Selected = %+v, %v", got, err)
	}
	g.IncludeArchived = true
	if got, _ := Selected(g); len(got) != 2 {
		t.Fatalf("kèm archived = %+v", got)
	}
	g.Filter = "("
	if _, err := Selected(g); err == nil {
		t.Error("regex hỏng không báo lỗi")
	}
	root := t.TempDir()
	ok := Group{Root: root + string(filepath.Separator)}
	if err := ok.Check(); err != nil || ok.Protocol != ProtocolHTTPS || ok.Root != root {
		t.Fatalf("Check = %+v, %v", ok, err)
	}
	for _, bad := range []Group{{Root: "rel"}, {Root: root, Protocol: "ftp"}, {Root: root, Filter: "("}, {Root: root, AutoFetchMinutes: 2}} {
		if err := bad.Check(); err == nil {
			t.Errorf("Check(%+v) không báo lỗi", bad)
		}
	}
}

func TestConfigHostsAndGroups(t *testing.T) {
	file := filepath.Join(t.TempDir(), "gitgroups.json")
	var hostID string
	err := Modify(file, func(c *Config) error {
		h := c.AddHost(Host{Kind: KindGitLab, URL: "https://gitlab.com", Name: "a", Username: "ha"})
		again := c.AddHost(Host{Kind: KindGitLab, URL: "https://GITLAB.com", Name: "b", Username: "ha", AuthMode: "git"})
		if again.ID != h.ID || len(c.Hosts) != 1 || c.Hosts[0].Name != "b" || again.AuthMode != "git" {
			t.Fatalf("thêm trùng = %+v", c.Hosts)
		}
		hostID = h.ID
		if _, err := c.AddGroup(Group{HostID: h.ID, Path: "acme", Root: "/x"}); err != nil {
			return err
		}
		if _, err := c.AddGroup(Group{HostID: h.ID, Path: "ACME", Root: "/x/"}); err == nil {
			t.Error("thêm trùng nhóm không báo lỗi")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(file)
	if bytes.Contains(b, []byte("token")) {
		t.Fatalf("file có chữ token: %s", b)
	}
	err = Modify(file, func(c *Config) error { return c.RemoveHost(hostID) })
	if err == nil || !strings.Contains(err.Error(), "acme") {
		t.Fatalf("xoá kết nối còn nhóm = %v", err)
	}
	c, _ := Load(file)
	if err := Modify(file, func(c2 *Config) error { return c2.RemoveGroup(c.Groups[0].ID) }); err != nil {
		t.Fatal(err)
	}
	if err := Modify(file, func(c *Config) error { return c.RemoveHost(hostID) }); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		if info, _ := os.Stat(file); info.Mode().Perm()&0o077 != 0 {
			t.Errorf("quyền file = %v", info.Mode())
		}
	}
}

func TestDue(t *testing.T) {
	now := time.Date(2026, 10, 14, 10, 0, 0, 0, time.UTC)
	if Due(Group{}, now) {
		t.Error("tắt mà vẫn đến lượt")
	}
	if !Due(Group{AutoFetchMinutes: 15}, now) {
		t.Error("chưa fetch lần nào mà không đến lượt")
	}
	recent := Group{AutoFetchMinutes: 15, LastAutoFetchAt: now.Add(-10 * time.Minute).Format(time.RFC3339)}
	if Due(recent, now) || !Due(recent, now.Add(5*time.Minute)) {
		t.Error("tính lượt sai")
	}
}

func TestParsePorcelainAndClassify(t *testing.T) {
	out := "# branch.oid abc\r\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -3\n? new.txt\n"
	p := ParsePorcelain(out)
	if s, _ := classify(p, "main"); s != StateBehind || p.Behind != 3 {
		t.Fatalf("behind = %+v %s", p, s)
	}
	cases := []struct {
		out, def, want string
	}{
		{"# branch.oid a\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n", "main", StateClean},
		{"# branch.oid a\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -0\n", "main", StateAhead},
		{"# branch.oid a\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +1 -1\n", "main", StateDiverged},
		{"# branch.oid a\n# branch.head feat\n# branch.upstream origin/feat\n# branch.ab +0 -0\n", "main", StateDiverged},
		{"# branch.oid a\n# branch.head (detached)\n", "main", StateDiverged},
		{"# branch.oid a\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -2\n1 .M N... 100644 100644 100644 a b f.go\n", "main", StateDirty},
		{"# branch.oid a\n# branch.head main\n", "main", StateDiverged},
		{"# branch.oid (initial)\n# branch.head main\n", "main", StateClean},
		{"# branch.oid a\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\nu UU N... 1 2 3 4 a b c f\n", "", StateDirty},
	}
	for _, c := range cases {
		if got, _ := classify(ParsePorcelain(c.out), c.def); got != c.want {
			t.Errorf("classify(%q) = %s, muốn %s", c.out, got, c.want)
		}
	}
}

func TestHostOf(t *testing.T) {
	if hostOf("git@github.com:a/b.git") != "" || hostOf("https://h:1/a") != "h:1" {
		t.Error("hostOf sai")
	}
}
