package tokenreport

import (
	"context"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// DefaultAccount là đăng nhập mặc định của CLI (~/.claude, ~/.codex), không thuộc gói nào của app.
const DefaultAccount = "default"

// Options chọn phạm vi báo cáo.
type Options struct {
	// Home là thư mục nhà; rỗng thì lấy của hệ điều hành. Test đặt thư mục tạm để không đụng dữ liệu thật.
	Home string
	// Accounts lọc theo gói (tên thư mục trong ~/.xdev-hive/accounts, hoặc "default"); rỗng là mọi gói.
	Accounts []string
	// Days chỉ đọc transcript sửa trong N ngày gần nhất; 0 là toàn bộ.
	Days int
	// Cutoff chia số liệu thành trước/sau mốc (theo giờ bắt đầu phiên); zero là không chia.
	Cutoff time.Time
	// OptimizerDir chứa sessions/*/ledger.jsonl và cache; rỗng thì ~/.xdev-hive/optimizer.
	OptimizerDir string
	// NoCache tắt cache theo (file, mtime, cỡ).
	NoCache bool
	// RTK thay cho việc gọi `rtk gain --format json`; NoRTK bỏ qua mục này.
	RTK   RTKFunc
	NoRTK bool
	Now   func() time.Time
	// Roots là danh sách gói người gọi đã biết (accounts.json), kể cả gói có thư mục cấu hình ngoài
	// ~/.xdev-hive/accounts. Rỗng thì quét theo tiền tố như cũ. Accounts vẫn lọc theo Root.Account.
	Roots []Root
}

// Root là thư mục cấu hình của một gói CLI; transcript nằm trong projects/ (Claude) hoặc sessions/ (Codex) của nó.
type Root struct {
	Account string
	CLI     string
	Dir     string
}

// Report giữ tên trường của scripts/token-audit.ts; phần thêm (sessions, split, trimmed, rtkGain) bỏ trống khi không có.
type Report struct {
	// Days là số ngày hoặc "all", như bản TypeScript.
	Days        any    `json:"days"`
	GeneratedAt string `json:"generatedAt"`
	Sessions    int    `json:"sessions"`
	Aggregate
	MemoryInventory MemoryInventory `json:"memoryInventory"`
	OtherMemory     OtherMemory     `json:"otherMemory"`
	Versions        []string        `json:"versions"`
	Split           *Split          `json:"split,omitempty"`
	Trimmed         *TrimStats      `json:"trimmed,omitempty"`
	RTKGain         json.RawMessage `json:"rtkGain,omitempty"`
}

// Split là hai cột trước/sau mốc bật tối ưu.
type Split struct {
	Cutoff string    `json:"cutoff"`
	Before Aggregate `json:"before"`
	After  Aggregate `json:"after"`
	// SessionsBefore/After đếm phiên mỗi bên để biết cột nào quá ít mẫu.
	SessionsBefore int `json:"sessionsBefore"`
	SessionsAfter  int `json:"sessionsAfter"`
}

type root struct {
	account string
	// home là thư mục cấu hình của CLI, dir là thư mục chứa transcript bên trong nó.
	home string
	dir  string
}

func (o *Options) wants(account string) bool {
	if len(o.Accounts) == 0 {
		return true
	}
	for _, a := range o.Accounts {
		if a == account {
			return true
		}
	}
	return false
}

// roots liệt kê thư mục cấu hình của các gói có tiền tố prefix, rồi tới đăng nhập mặc định. Có Options.Roots thì chỉ
// dùng các gói của CLI prefix trong đó.
func (o *Options) roots(home, prefix, defaultDir, sub string) []root {
	var out []root
	if len(o.Roots) > 0 {
		for _, r := range o.Roots {
			if r.CLI == prefix && o.wants(r.Account) {
				out = append(out, root{r.Account, r.Dir, filepath.Join(r.Dir, sub)})
			}
		}
		return existingRoots(out)
	}
	accountsDir := filepath.Join(home, ".xdev-hive", "accounts")
	if entries, err := os.ReadDir(accountsDir); err == nil {
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), prefix) && o.wants(e.Name()) {
				h := filepath.Join(accountsDir, e.Name())
				out = append(out, root{e.Name(), h, filepath.Join(h, sub)})
			}
		}
	}
	if o.wants(DefaultAccount) {
		h := filepath.Join(home, defaultDir)
		out = append(out, root{DefaultAccount, h, filepath.Join(h, sub)})
	}
	return existingRoots(out)
}

func existingRoots(out []root) []root {
	var existing []root
	for _, r := range out {
		if exists(r.dir) {
			existing = append(existing, r)
		}
	}
	return existing
}

// walk gom file khớp match. memory/ chỉ chứa .md; tool-results/ là output đã tách ra file, đọc qua transcript.
func walk(dir string, since time.Time, match func(string) bool) []string {
	var out []string
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if p != dir && (d.Name() == "memory" || d.Name() == "tool-results") {
				return filepath.SkipDir
			}
			return nil
		}
		if !match(d.Name()) {
			return nil
		}
		if !since.IsZero() {
			if info, err := d.Info(); err != nil || info.ModTime().Before(since) {
				return nil
			}
		}
		out = append(out, p)
		return nil
	})
	return out
}

// collected là kết quả đọc transcript, dùng chung cho Run và Sessions.
type collected struct {
	home, optDir            string
	now                     func() time.Time
	since                   time.Time
	claudeRoots, codexRoots []root
	sessions                []*session
}

func collect(ctx context.Context, opts Options) (*collected, error) {
	now := time.Now
	if opts.Now != nil {
		now = opts.Now
	}
	home := opts.Home
	if home == "" {
		h, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		home = h
	}
	optDir := opts.OptimizerDir
	if optDir == "" {
		optDir = filepath.Join(home, ".xdev-hive", "optimizer")
	}
	var since time.Time
	if opts.Days > 0 {
		since = now().Add(-time.Duration(opts.Days) * 24 * time.Hour)
	}
	cachePath := ""
	if !opts.NoCache {
		cachePath = filepath.Join(optDir, "report-cache.json")
	}
	c := loadCache(cachePath)

	claudeRoots := opts.roots(home, "claude", ".claude", "projects")
	codexRoots := opts.roots(home, "codex", ".codex", "sessions")

	var sessions []*session
	load := func(file, account string, read func(string, string) (*session, error)) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		info, err := os.Stat(file)
		if err != nil {
			return nil
		}
		s := c.get(file, info.ModTime().UnixNano(), info.Size())
		if s == nil {
			if s, err = read(file, account); err != nil {
				return nil
			}
			c.put(file, info.ModTime().UnixNano(), info.Size(), s)
		}
		if s.Calls == 0 {
			return nil
		}
		// Cache dùng chung giữa các lần lọc gói, nên gói gán lại theo thư mục đang đọc.
		cp := *s
		cp.Account = account
		cp.Subagent = isSubagent(file)
		if cp.Start.IsZero() {
			cp.Start = info.ModTime()
		}
		sessions = append(sessions, &cp)
		return nil
	}
	for _, r := range claudeRoots {
		for _, f := range walk(r.dir, since, func(n string) bool { return strings.HasSuffix(n, ".jsonl") }) {
			// Transcript của subagent nằm trong <phiên>/subagents/; tính là phiên riêng cùng nguồn.
			if err := load(f, r.account, readClaude); err != nil {
				return nil, err
			}
		}
	}
	for _, r := range codexRoots {
		for _, f := range walk(r.dir, since, func(n string) bool {
			return strings.HasPrefix(n, "rollout-") && strings.HasSuffix(n, ".jsonl")
		}) {
			if err := load(f, r.account, readCodex); err != nil {
				return nil, err
			}
		}
	}
	c.save()
	return &collected{home: home, optDir: optDir, now: now, since: since, claudeRoots: claudeRoots, codexRoots: codexRoots,
		sessions: sessions}, nil
}

// Run đọc transcript (chỉ đọc) và trả số tổng hợp.
func Run(ctx context.Context, opts Options) (*Report, error) {
	col, err := collect(ctx, opts)
	if err != nil {
		return nil, err
	}
	home, optDir, now, since, sessions := col.home, col.optDir, col.now, col.since, col.sessions
	claudeRoots, codexRoots := col.claudeRoots, col.codexRoots

	rep := &Report{
		Days:        "all",
		GeneratedAt: now().UTC().Format(time.RFC3339Nano),
		Sessions:    len(sessions),
		Aggregate:   aggregate(sessions),
	}
	if opts.Days > 0 {
		rep.Days = opts.Days
	}
	rep.MemoryInventory = memoryInventory(claudeRoots, now())
	codexHomes := codexRoots
	rep.OtherMemory = otherMemory(codexHomes, home)
	versions := map[string]bool{}
	for _, s := range sessions {
		for _, v := range s.Versions {
			versions[v] = true
		}
	}
	rep.Versions = []string{}
	for v := range versions {
		rep.Versions = append(rep.Versions, v)
	}
	sort.Strings(rep.Versions)
	if len(rep.Versions) > 6 {
		rep.Versions = rep.Versions[len(rep.Versions)-6:]
	}

	if !opts.Cutoff.IsZero() {
		var before, after []*session
		for _, s := range sessions {
			if s.Start.Before(opts.Cutoff) {
				before = append(before, s)
			} else {
				after = append(after, s)
			}
		}
		rep.Split = &Split{
			Cutoff: opts.Cutoff.UTC().Format(time.RFC3339), Before: aggregate(before), After: aggregate(after),
			SessionsBefore: len(before), SessionsAfter: len(after),
		}
	}
	trimFrom := opts.Cutoff
	if trimFrom.IsZero() {
		trimFrom = since
	} else if !since.IsZero() && since.After(trimFrom) {
		trimFrom = since
	}
	rep.Trimmed = readLedger(optDir, trimFrom)
	if !opts.NoRTK {
		fn := opts.RTK
		if fn == nil {
			fn = execRTK
		}
		rep.RTKGain = rtkGain(ctx, fn)
	}
	return rep, nil
}
