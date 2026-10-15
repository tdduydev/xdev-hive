package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/tdduydev/xdev-hive/worker/internal/hubtls"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// skillsDir là nơi Claude Code tìm skill của dự án: nó chỉ nạp tên và mô tả vào ngữ cảnh, đọc phần còn lại khi cần
// (progressive disclosure). Codex, Gemini, Antigravity đọc skill qua MCP (skill_list, skill_get) nên không chép.
const skillsDir = ".claude/skills"

// skillCacheTTL: bản skill không run nào dùng trong khoảng này bị xoá khỏi cache; bộ skill mặc định nặng vài MB mỗi bản.
const skillCacheTTL = 30 * 24 * time.Hour

var skillNamePattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
var skillHashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// runSkill khớp runSkill trong packages/contracts/src/worker-protocol.ts.
type runSkill struct {
	Name   string `json:"name"`
	Hash   string `json:"hash"`
	Source string `json:"source"`
	Files  []struct {
		Path string `json:"path"`
		Text string `json:"text"`
	} `json:"files,omitempty"`
}

// wantsSkills: chỉ run sửa code và run review chạy bằng Claude Code mới được chép skill vào worktree.
func wantsSkills(j Job) bool {
	return j.CLI == "claude" && (j.Kind == "" || j.Kind == "code" || j.Kind == KindReview)
}

// installSkills chép skill hub cho phép (của tổ chức, đội, dự án và bộ mặc định đang bật) vào .claude/skills của
// worktree. Hub chỉ gửi file của skill có hash chưa nằm trong cache. Skill repo đã có cùng tên thì giữ bản của repo.
// Mỗi thư mục chép vào có .gitignore "*" để agent không commit nó, mà không phải ghi info/exclude dùng chung của repo
// người dùng đã gắn (ADR 0020). Trả tên skill đã chép.
func installSkills(ctx context.Context, client *http.Client, cacheDir string, j Job, work string) ([]string, error) {
	hub := strings.TrimRight(j.Env["HIVE_HUB_URL"], "/")
	token := j.Env["HIVE_RUN_TOKEN"]
	if hub == "" || token == "" {
		return nil, nil
	}
	if client == nil {
		client = hubtls.NewClient(2 * time.Minute)
	}
	if err := os.MkdirAll(cacheDir, 0o700); err != nil {
		return nil, err
	}
	have := cachedSkills(cacheDir)
	body, _ := json.Marshal(map[string]any{"have": have})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, hub+"/api/v1/run/skills", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	// Hub cũ chưa có đường này: chạy như trước, agent vẫn đọc skill qua MCP.
	if res.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("hub trả %d khi lấy skill", res.StatusCode)
	}
	var out struct {
		Skills []runSkill `json:"skills"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, err
	}
	var installed []string
	for _, s := range out.Skills {
		if !skillNamePattern.MatchString(s.Name) || !skillHashPattern.MatchString(s.Hash) {
			continue
		}
		cached := filepath.Join(cacheDir, s.Hash)
		if s.Files != nil {
			if err := storeSkill(cacheDir, s); err != nil {
				return installed, err
			}
		}
		if _, err := os.Stat(cached); err != nil {
			continue
		}
		dst := filepath.Join(work, filepath.FromSlash(skillsDir), s.Name)
		if _, err := os.Lstat(dst); err == nil {
			continue
		}
		if err := copyDir(cached, dst); err != nil {
			return installed, err
		}
		if err := os.WriteFile(filepath.Join(dst, ".gitignore"), []byte("*\n"), 0o644); err != nil {
			return installed, err
		}
		now := time.Now()
		_ = os.Chtimes(cached, now, now)
		installed = append(installed, s.Name)
	}
	pruneSkillCache(cacheDir, time.Now().Add(-skillCacheTTL))
	return installed, nil
}

func cachedSkills(cacheDir string) []string {
	entries, _ := os.ReadDir(cacheDir)
	have := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() && skillHashPattern.MatchString(e.Name()) {
			have = append(have, e.Name())
		}
	}
	// Hub nhận tối đa 500 hash; cache lớn hơn thì gửi một phần, phần còn lại hub gửi lại file.
	if len(have) > 500 {
		have = have[:500]
	}
	return have
}

// storeSkill ghi skill vào thư mục tạm rồi đổi tên, để run khác chạy song song không đọc phải bản ghi dở.
func storeSkill(cacheDir string, s runSkill) error {
	final := filepath.Join(cacheDir, s.Hash)
	if _, err := os.Stat(final); err == nil {
		return nil
	}
	tmp, err := os.MkdirTemp(cacheDir, ".tmp-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	for _, f := range s.Files {
		rel := filepath.FromSlash(f.Path)
		// Đường dẫn do hub gửi: không cho thoát khỏi thư mục skill.
		if !filepath.IsLocal(rel) {
			return fmt.Errorf("skill %s có đường dẫn không hợp lệ: %q", s.Name, f.Path)
		}
		p := filepath.Join(tmp, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return err
		}
		mode := os.FileMode(0o644)
		if strings.HasSuffix(f.Path, ".sh") || strings.HasPrefix(f.Text, "#!") {
			mode = 0o755
		}
		if err := os.WriteFile(p, []byte(f.Text), mode); err != nil {
			return err
		}
	}
	if err := os.Rename(tmp, final); err != nil {
		// Run khác vừa ghi cùng hash: bản đó cũng đúng.
		if _, statErr := os.Stat(final); statErr == nil {
			return nil
		}
		return err
	}
	return nil
}

func copyDir(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, info.Mode().Perm())
	})
}

func pruneSkillCache(cacheDir string, before time.Time) {
	entries, _ := os.ReadDir(cacheDir)
	for _, e := range entries {
		info, err := e.Info()
		if err != nil || !info.ModTime().Before(before) {
			continue
		}
		if skillHashPattern.MatchString(e.Name()) || strings.HasPrefix(e.Name(), ".tmp-") {
			_ = os.RemoveAll(filepath.Join(cacheDir, e.Name()))
		}
	}
}
