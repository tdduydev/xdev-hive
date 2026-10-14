package accounts

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSummariesReportQuotaWithoutSecrets(t *testing.T) {
	noCLIs(t)
	home := t.TempDir()
	path := filepath.Join(home, "accounts.json")
	signIn(t, home, "~/.xdev-hive/accounts/claude-2", "claude")
	list := []Account{
		{ID: "claude-2", Label: "Gói Max đội A", CLI: "claude", ConfigDir: "~/.xdev-hive/accounts/claude-2", Enabled: true, StopAtSession: 90, Roles: []string{"plan"}},
		{ID: "codex-1", Label: "Codex", CLI: "codex", ConfigDir: "~/.xdev-hive/accounts/codex-1"},
		{ID: "claude-9", Label: "đang đăng nhập", CLI: "claude", ConfigDir: "~/.xdev-hive/accounts/claude-9", Pending: true},
	}
	if err := Save(path, 0, list); err != nil {
		t.Fatal(err)
	}
	reset := time.Date(2026, 10, 13, 18, 0, 0, 0, time.FixedZone("ICT", 7*3600))
	err := UpdateState(StatePath(path), t0, func(s *State) {
		s.Usage["claude-2"] = Usage{Session: &Limit{Percent: 142, ResetsAt: &reset}, Week: &Limit{Percent: 17.5}}
		s.Active["claude-2"] = 1
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := Summaries(path, home, t0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("tài khoản đang đăng nhập dở không được báo: %+v", got)
	}
	a := got[0]
	if a.ID != "claude-2" || a.Label != "Gói Max đội A" || !a.Enabled || a.LoggedIn == nil || !*a.LoggedIn || a.InUse != 1 || a.StopAtSession != 90 {
		t.Fatalf("claude-2 = %+v", a)
	}
	if a.SessionPct == nil || *a.SessionPct != 100 || a.WeekPct == nil || *a.WeekPct != 17.5 {
		t.Fatalf("phần trăm phải chặn trong 0..100: %+v", a)
	}
	// Z và mili giây: z.iso.datetime() của hợp đồng từ chối giờ lệch múi.
	if a.ResetsAt == nil || *a.ResetsAt != "2026-10-13T11:00:00.000Z" {
		t.Fatalf("resetsAt = %v", a.ResetsAt)
	}
	b, _ := json.Marshal(got[1])
	for _, field := range []string{`"loggedIn":false`, `"sessionPct":null`, `"weekPct":null`, `"resetsAt":null`, `"roles":["plan","implement","review"]`} {
		if !strings.Contains(string(b), field) {
			t.Errorf("codex-1 thiếu %s: %s", field, b)
		}
	}
	if strings.Contains(string(b), "duy@fpt.com") {
		t.Fatalf("lộ email: %s", b)
	}
}

func TestSummariesCapAndMissingFile(t *testing.T) {
	dir := t.TempDir()
	got, err := Summaries(filepath.Join(dir, "none.json"), dir, t0)
	if err != nil || got == nil || len(got) != 0 {
		t.Fatalf("không có file phải trả mảng rỗng (hub đòi mảng): %v %v", got, err)
	}
	var many []Account
	for i := 0; i < 40; i++ {
		many = append(many, Account{ID: "claude-" + string(rune('a'+i%26)) + string(rune('a'+i/26)), CLI: "claude", Label: strings.Repeat("ă", 100)})
	}
	path := filepath.Join(dir, "accounts.json")
	_ = Save(path, 0, many)
	got, _ = Summaries(path, dir, t0)
	if len(got) != 32 {
		t.Fatalf("len = %d, hợp đồng chặn 32", len(got))
	}
	if n := len([]rune(got[0].Label)); n != 80 {
		t.Fatalf("nhãn %d ký tự", n)
	}
	_ = os.Remove(path)
}
