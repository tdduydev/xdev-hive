package runner

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Hook cục bộ (`hive-worker hook pre-tool|post-tool|prompt --local`) là guard của run gắn vào phiên Claude Code người dùng tự
// mở, qua settings.json của gói (specs/015-client-token-optimizer). Không có thư mục của run nên trạng thái để theo
// session_id trong ~/.xdev-hive/optimizer/sessions/<id>/; pre-tool chỉ nhắc, vì chặn giữa lúc người dùng đang làm tay
// gây khó chịu hơn số token tiết kiệm được.
const (
	localOptimizerDir = "optimizer"
	localSessionsDir  = "sessions"
	// localOutDir nằm trong dự án vì phiên tương tác không có --add-dir: Read ngoài dự án sẽ hỏi quyền người dùng.
	localOutDir = ".hive-out"
	// localSessionMaxAge: phiên không ghi gì lâu hơn thì bị dọn, kèm output đầy đủ của nó.
	localSessionMaxAge = 7 * 24 * time.Hour
	localCleanupEvery  = 24 * time.Hour
	localLevelDefault  = "balanced"
)

type localHookInput struct {
	hookInput
	SessionID string `json:"session_id"`
	// Prompt chỉ có ở UserPromptSubmit (hook prompt).
	Prompt string `json:"prompt"`
}

// localConfig là cấu hình của phiên, lấy từ manifest một lần rồi giữ trong thư mục phiên: người dùng bật/tắt hay đổi
// mức giữa phiên thì áp từ phiên sau, đổi lại mỗi lần gọi hook không phải đọc manifest.
type localConfig struct {
	guardConfig
	Level string `json:"level"`
}

// localManifestProfile là phần của một gói trong ~/.xdev-hive/optimizer/state.json mà hook cần. Đọc lỏng (map theo
// id hay mảng, khoá thiếu dùng mặc định) để manifest thêm trường không làm hỏng hook.
type localManifestProfile struct {
	ID                 string `json:"id"`
	Profile            string `json:"profile"`
	ConfigDir          string `json:"configDir"`
	Level              string `json:"level"`
	ExploreBudget      *int   `json:"exploreBudget"`
	ToolOutputMaxChars *int   `json:"toolOutputMaxChars"`
}

type localLedgerEntry struct {
	TS     string `json:"ts"`
	Tool   string `json:"tool"`
	Before int    `json:"before"`
	After  int    `json:"after"`
}

// localHookMain chạy hook cho phiên tương tác. Lỗi gì (kể cả panic) cũng thoát 0 và không in gì.
func localHookMain(sub string, stdin io.Reader, stdout io.Writer) (code int) {
	defer func() {
		if recover() != nil {
			code = 0
		}
	}()
	var in localHookInput
	if err := json.NewDecoder(io.LimitReader(stdin, 64<<20)).Decode(&in); err != nil {
		return 0
	}
	sid := safeName(in.SessionID)
	home, err := os.UserHomeDir()
	if sid == "" || strings.Trim(sid, "-") == "" || err != nil {
		return 0
	}
	root := filepath.Join(home, ".xdev-hive", localOptimizerDir)
	sessions := filepath.Join(root, localSessionsDir)
	dir := filepath.Join(sessions, sid)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return 0
	}
	cleanupLocalSessions(sessions, sid, time.Now())
	cfg := loadLocalConfig(root, dir, home)
	var reply any
	switch sub {
	case "pre-tool":
		reply = localPreTool(dir, cfg, in.hookInput)
	case "post-tool":
		reply = localPostTool(dir, sid, home, cfg, in.hookInput)
	case "prompt":
		reply = localPrompt(dir, in)
	}
	if reply != nil {
		_ = json.NewEncoder(stdout).Encode(reply)
	}
	return 0
}

// loadLocalConfig đọc cấu hình đã giữ của phiên, chưa có thì dựng từ manifest theo gói của CLAUDE_CONFIG_DIR.
func loadLocalConfig(root, dir, home string) localConfig {
	p := filepath.Join(dir, "config.json")
	if b, err := os.ReadFile(p); err == nil {
		var cfg localConfig
		if json.Unmarshal(b, &cfg) == nil && cfg.Level != "" {
			return cfg
		}
	}
	cfg := localConfig{
		guardConfig: guardConfig{ExploreBudget: defaultExploreBudget, MaxChars: defaultToolOutputMaxChars},
		Level:       localLevelDefault,
	}
	if prof, ok := manifestProfile(filepath.Join(root, "state.json"), os.Getenv("CLAUDE_CONFIG_DIR"), home); ok {
		if prof.Level == "aggressive" {
			cfg.Level = prof.Level
		}
		if prof.ExploreBudget != nil {
			cfg.ExploreBudget = max(0, *prof.ExploreBudget)
		}
		if prof.ToolOutputMaxChars != nil {
			cfg.MaxChars = max(0, *prof.ToolOutputMaxChars)
		}
	}
	if b, err := json.Marshal(cfg); err == nil {
		tmp := p + ".tmp"
		if os.WriteFile(tmp, b, 0o600) == nil {
			_ = os.Rename(tmp, p)
		}
	}
	return cfg
}

// manifestProfile tìm mục của gói: khớp đường dẫn configDir, hoặc id là tên thư mục gói
// (~/.xdev-hive/accounts/<id>). Không đặt CLAUDE_CONFIG_DIR là gói mặc định ~/.claude.
func manifestProfile(path, configDir, home string) (localManifestProfile, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return localManifestProfile{}, false
	}
	var m struct {
		Profiles json.RawMessage `json:"profiles"`
	}
	if json.Unmarshal(b, &m) != nil || len(m.Profiles) == 0 {
		return localManifestProfile{}, false
	}
	var list []localManifestProfile
	var byID map[string]localManifestProfile
	if json.Unmarshal(m.Profiles, &byID) == nil {
		for id, p := range byID {
			if p.ID == "" {
				p.ID = id
			}
			list = append(list, p)
		}
	} else if json.Unmarshal(m.Profiles, &list) != nil {
		return localManifestProfile{}, false
	}
	want := filepath.Join(home, ".claude")
	if configDir != "" {
		want = expandHome(configDir, home)
	}
	want = filepath.Clean(want)
	id := filepath.Base(want)
	for _, p := range list {
		if p.ConfigDir != "" && filepath.Clean(expandHome(p.ConfigDir, home)) == want {
			return p, true
		}
	}
	for _, p := range list {
		if p.ID == "" {
			p.ID = p.Profile
		}
		if p.ConfigDir == "" && (p.ID == id || configDir == "" && p.ID == "default") {
			return p, true
		}
	}
	return localManifestProfile{}, false
}

func expandHome(p, home string) string {
	if p == "~" {
		return home
	}
	if strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		return filepath.Join(home, p[2:])
	}
	return p
}

// cleanupLocalSessions dọn phiên quá hạn mỗi ngày một lần. Khoá không chờ: phiên khác đang dọn thì bỏ qua, hook không
// được chậm vì việc dọn.
func cleanupLocalSessions(sessions, current string, now time.Time) {
	mark := filepath.Join(sessions, ".cleanup")
	if fi, err := os.Stat(mark); err == nil && now.Sub(fi.ModTime()) < localCleanupEvery {
		return
	}
	f, err := os.OpenFile(filepath.Join(sessions, ".cleanup.lock"), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	if ok, err := tryLockFile(f); !ok || err != nil {
		return
	}
	defer func() { _ = unlockFile(f) }()
	// Kiểm lại sau khi có khoá: phiên vừa nhả khoá có thể đã dọn xong.
	if fi, err := os.Stat(mark); err == nil && now.Sub(fi.ModTime()) < localCleanupEvery {
		return
	}
	if err := os.WriteFile(mark, nil, 0o600); err != nil {
		return
	}
	_ = os.Chtimes(mark, now, now)
	entries, err := os.ReadDir(sessions)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() || e.Name() == current {
			continue
		}
		dir := filepath.Join(sessions, e.Name())
		if now.Sub(localLastWrite(dir)) < localSessionMaxAge {
			continue
		}
		removeLocalOutDirs(dir, e.Name())
		_ = os.RemoveAll(dir)
	}
}

// localLastWrite là lần ghi cuối của phiên. Ledger chỉ được nối thêm nên không đổi mtime của thư mục.
func localLastWrite(dir string) time.Time {
	var last time.Time
	for _, p := range []string{dir, filepath.Join(dir, "ledger.jsonl")} {
		if fi, err := os.Stat(p); err == nil && fi.ModTime().After(last) {
			last = fi.ModTime()
		}
	}
	return last
}

// removeLocalOutDirs xoá output đầy đủ phiên đã ghi vào các dự án. Chỉ xoá đúng thư mục .hive-out/<id> để danh sách
// bị sửa tay cũng không xoá nhầm thứ khác.
func removeLocalOutDirs(dir, sid string) {
	f, err := os.Open(filepath.Join(dir, "outdirs.txt"))
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		p := filepath.Clean(strings.TrimSpace(sc.Text()))
		if filepath.IsAbs(p) && filepath.Base(p) == sid && filepath.Base(filepath.Dir(p)) == localOutDir {
			_ = os.RemoveAll(p)
		}
	}
}

// localPreTool đếm như preTool của run nhưng chỉ nhắc qua additionalContext. Hết ngân sách khảo sát thì nhắc một lần,
// cat file lớn thì nhắc mỗi lần vì mỗi lần là một file khác.
func localPreTool(dir string, cfg localConfig, in hookInput) any {
	if cfg.ExploreBudget <= 0 {
		return nil
	}
	switch in.Tool {
	case "Edit", "Write", "MultiEdit", "NotebookEdit":
		withState(dir, func(st *guardState) { st.Edited = true })
		return nil
	case "Bash":
		var ti struct {
			Command string `json:"command"`
		}
		if json.Unmarshal(in.ToolInput, &ti) != nil {
			return nil
		}
		if big := bigCat(ti.Command, in.Cwd); big != "" {
			withState(dir, func(st *guardState) { st.Blocked++ })
			return nudge(fmt.Sprintf("[xdev-hive] %s dài hơn %d dòng: lần sau đọc bằng Read với offset/limit (hoặc rg -n trong file đó) thay vì cat cả file.", big, bigFileLines))
		}
		if !exploreCommand(ti.Command) {
			return nil
		}
	case "Read":
		var ti struct {
			FilePath string `json:"file_path"`
			Offset   *int   `json:"offset"`
			Limit    *int   `json:"limit"`
		}
		if json.Unmarshal(in.ToolInput, &ti) != nil || ti.Offset != nil || ti.Limit != nil || countLines(resolvePath(ti.FilePath, in.Cwd), bigFileLines+1) <= bigFileLines {
			return nil
		}
	default:
		return nil
	}
	var reply any
	withState(dir, func(st *guardState) {
		if st.Edited {
			return
		}
		st.Explore++
		if st.Explore == cfg.ExploreBudget+1 {
			st.Blocked++
			reply = nudge(fmt.Sprintf("[xdev-hive] Đã dò repo %d lần trước lần sửa đầu. Tìm bằng Grep/rg với thư mục cụ thể, đọc file bằng Read có offset/limit thay vì liệt kê hay đọc cả repo.", st.Explore))
		}
	})
	return reply
}

func nudge(msg string) map[string]any {
	return map[string]any{"hookSpecificOutput": map[string]any{
		"hookEventName":     "PreToolUse",
		"additionalContext": msg,
	}}
}

// localPostTool cắt output như postTool của run, ghi bản đầy đủ vào dự án và một dòng ledger.
func localPostTool(dir, sid, home string, cfg localConfig, in hookInput) any {
	if cfg.MaxChars <= 0 || len(in.ToolResponse) <= cfg.MaxChars {
		return nil
	}
	var resp any
	if json.Unmarshal(in.ToolResponse, &resp) != nil {
		return nil
	}
	var total int
	walkStrings(resp, func(s string) string { total += len(s); return s })
	if total <= cfg.MaxChars {
		return nil
	}
	name := safeName(in.ToolUseID)
	if name == "" {
		name = fmt.Sprint(time.Now().UnixNano())
	}
	var dump bytes.Buffer
	walkStrings(resp, func(s string) string {
		if len(s) > 0 {
			dump.WriteString(s)
			if !strings.HasSuffix(s, "\n") {
				dump.WriteString("\n")
			}
		}
		return s
	})
	full := writeLocalOut(dir, sid, home, in.Cwd, name+".txt", dump.Bytes())
	if full == "" {
		return nil
	}
	var cut int64
	resp = walkStrings(resp, func(s string) string {
		allow := max(1000, cfg.MaxChars*len(s)/total)
		if len(s) <= allow {
			return s
		}
		t := truncateKeep(s, allow, full)
		cut += int64(len(s) - len(t))
		return t
	})
	if cut <= 0 {
		return nil
	}
	line, _ := json.Marshal(localLedgerEntry{TS: time.Now().UTC().Format(time.RFC3339), Tool: in.Tool, Before: total, After: total - int(cut)})
	withState(dir, func(st *guardState) {
		st.Truncated++
		st.TruncatedChars += cut
		// Nối ledger dưới khoá của state để hai hook song song không chen dòng vào nhau.
		if f, err := os.OpenFile(filepath.Join(dir, "ledger.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
			_, _ = f.Write(append(line, '\n'))
			_ = f.Close()
		}
	})
	return map[string]any{"hookSpecificOutput": map[string]any{
		"hookEventName":     "PostToolUse",
		"updatedToolOutput": resp,
	}}
}

// writeLocalOut ghi output đầy đủ vào <cwd>/.claude/.hive-out/<phiên>/, không được thì vào thư mục phiên (Read ở đó sẽ
// hỏi quyền, vẫn hơn mất output). Trả đường dẫn đã ghi, rỗng khi không ghi được đâu cả.
func writeLocalOut(dir, sid, home, cwd, name string, data []byte) string {
	if out := projectOutDir(dir, sid, home, cwd); out != "" {
		p := filepath.Join(out, name)
		if os.WriteFile(p, data, 0o600) == nil {
			return p
		}
	}
	out := filepath.Join(dir, "out")
	if os.MkdirAll(out, 0o700) != nil {
		return ""
	}
	p := filepath.Join(out, name)
	if os.WriteFile(p, data, 0o600) != nil {
		return ""
	}
	return p
}

// projectOutDir tạo .claude/.hive-out/<phiên> trong dự án. Thư mục nhà bị bỏ qua vì ~/.claude là cấu hình của Claude
// Code, không phải dự án.
func projectOutDir(dir, sid, home, cwd string) string {
	if cwd == "" || !filepath.IsAbs(cwd) || filepath.Clean(cwd) == filepath.Clean(home) {
		return ""
	}
	if fi, err := os.Stat(cwd); err != nil || !fi.IsDir() {
		return ""
	}
	base := filepath.Join(cwd, ".claude", localOutDir)
	_, err := os.Stat(base)
	fresh := os.IsNotExist(err)
	out := filepath.Join(base, sid)
	if _, err := os.Stat(out); err == nil {
		return out
	}
	if os.MkdirAll(out, 0o700) != nil {
		return ""
	}
	if fresh {
		// info/exclude chỉ khớp đúng chỗ khi cwd là gốc repo; .gitignore "*" lo trường hợp cwd là thư mục con, để
		// output của Hive không bao giờ hiện trong git status của người dùng.
		_ = os.WriteFile(filepath.Join(base, ".gitignore"), []byte("*\n"), 0o644)
		if _, err := os.Stat(filepath.Join(cwd, ".git")); err == nil {
			_ = appendExclude(cwd, ".claude/"+localOutDir+"/")
		}
	}
	if f, err := os.OpenFile(filepath.Join(dir, "outdirs.txt"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
		_, _ = f.WriteString(out + "\n")
		_ = f.Close()
	}
	return out
}
