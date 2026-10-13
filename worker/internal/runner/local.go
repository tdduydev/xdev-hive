package runner

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/tdduydev/xdev-hive/worker/internal/projects"
)

// repoSource là repo mà run tạo worktree từ đó: repo cache bare của worker, hoặc repo người dùng đã gắn với dự án
// (projects.json, ADR 0020).
type repoSource struct {
	// lock là khoá tuần tự hoá lệnh git ghi vào repo; với repo đã gắn, file khoá nằm trong DataDir chứ không trong thư
	// mục của người dùng.
	lock string
	// dir là thư mục chạy fetch, worktree add/remove.
	dir string
	// common là thư mục git chung (objects, refs) mà Codex cần quyền ghi.
	common string
	local  bool
}

func bareSource(dataDir, repoURL string) repoSource {
	digest := sha256.Sum256([]byte(repoURL))
	cache := filepath.Join(dataDir, "repos", fmt.Sprintf("%x.git", digest[:12]))
	return repoSource{lock: cache, dir: cache, common: cache}
}

func localSource(folder string) repoSource { return repoSource{dir: folder, local: true} }

// localLock là khoá của repo đã gắn, theo thư mục git chung: worktree nào của repo cũng ra cùng một khoá.
func localLock(dataDir, common string) string {
	digest := sha256.Sum256([]byte(cleanAbs(common)))
	return filepath.Join(dataDir, "repos", fmt.Sprintf("local-%x", digest[:12]))
}

// openLocal kiểm repo đã gắn trước khi đụng tới nó: thư mục còn, là work tree git, origin khớp repo của dự án. Không
// đoán: sai thì run hỏng kèm lý do, không quay về repo cache hay remote khác.
func (s *repoSource) openLocal(ctx context.Context, dataDir, repoURL string) error {
	st, err := os.Stat(s.dir)
	if err != nil || !st.IsDir() {
		return fmt.Errorf("thư mục repo đã gắn với dự án không còn: %s. Gắn lại thư mục ở màn Dự án trên máy của app", s.dir)
	}
	if inside, _ := gitOutput(ctx, s.dir, "rev-parse", "--is-inside-work-tree"); strings.TrimSpace(inside) != "true" {
		return fmt.Errorf("thư mục %s đã gắn với dự án nhưng không phải repo git", s.dir)
	}
	origin, err := gitOutput(ctx, s.dir, "remote", "get-url", "origin")
	if err != nil || strings.TrimSpace(origin) == "" {
		return fmt.Errorf("repo %s không có remote origin; run cần origin trỏ tới %s", s.dir, projects.Redact(repoURL))
	}
	if origin = strings.TrimSpace(origin); !projects.SameRepo(origin, repoURL) {
		return fmt.Errorf("remote origin của %s là %s, không khớp repo của dự án %s", s.dir, projects.Redact(origin), projects.Redact(repoURL))
	}
	common, err := gitOutput(ctx, s.dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return fmt.Errorf("không đọc được thư mục git của %s: %w", s.dir, err)
	}
	s.common = filepath.Clean(filepath.FromSlash(strings.TrimSpace(common)))
	s.lock = localLock(dataDir, s.common)
	return os.MkdirAll(filepath.Dir(s.lock), 0700)
}

// branchMark ghi nhánh của run trước khi `worktree add -B` đặt lại nó trong repo của người dùng, để dọn run không đẩy
// được gì thì trả nhánh về như cũ (xoá nếu trước đó chưa có). File nằm cạnh worktree trong runs/.
type branchMark struct {
	Folder  string `json:"folder"`
	Lock    string `json:"lock"`
	Branch  string `json:"branch"`
	Tip     string `json:"tip,omitempty"`
	Existed bool   `json:"existed"`
}

func markPath(work string) string { return work + ".branch.json" }

// prepareBranch từ chối khi đặt lại nhánh của run sẽ đè việc của người dùng: nhánh đang checkout ở worktree không do
// worker tạo, hoặc có commit chưa có trên remote nào của origin. Thay đổi chưa commit trong thư mục làm việc của người
// dùng không chặn run, vì run chạy ở worktree riêng.
func (s repoSource) prepareBranch(ctx context.Context, runsRoot, work, branch string) error {
	list, err := gitOutput(ctx, s.dir, "worktree", "list", "--porcelain")
	if err != nil {
		return fmt.Errorf("không đọc được danh sách worktree của %s: %w", s.dir, err)
	}
	for _, wt := range parseWorktrees(list) {
		if wt.branch == "refs/heads/"+branch && !insideDir(runsRoot, wt.path) {
			return fmt.Errorf("nhánh %s đang được checkout ở %s; chuyển thư mục đó sang nhánh khác rồi chạy lại", branch, wt.path)
		}
	}
	mark := branchMark{Folder: s.dir, Lock: s.lock, Branch: branch}
	if tip, err := gitOutput(ctx, s.dir, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch); err == nil {
		mark.Tip, mark.Existed = strings.TrimSpace(tip), true
		pushed, err := gitOutput(ctx, s.dir, "for-each-ref", "--contains", mark.Tip, "--format=%(refname)", "refs/remotes/origin")
		if err != nil {
			return fmt.Errorf("không kiểm được nhánh %s của %s: %w", branch, s.dir, err)
		}
		if strings.TrimSpace(pushed) == "" {
			return fmt.Errorf("nhánh %s trong %s có commit chưa push lên origin; push hoặc đổi tên nhánh đó rồi chạy lại", branch, s.dir)
		}
	}
	b, err := json.Marshal(mark)
	if err != nil {
		return err
	}
	return os.WriteFile(markPath(work), b, 0600)
}

// restoreBranch trả nhánh của run về như trước run (hoặc xoá nhánh run vừa tạo) rồi bỏ file ghi. `git branch -f/-D`
// tự từ chối nhánh người dùng vừa checkout, nên không làm lệch thư mục làm việc của họ.
func restoreBranch(work string) {
	b, err := os.ReadFile(markPath(work))
	if err != nil {
		return
	}
	var m branchMark
	if json.Unmarshal(b, &m) == nil && m.Folder != "" && m.Lock != "" && m.Branch != "" {
		if m.Existed {
			_ = gitWrite(context.Background(), m.Lock, m.Folder, "branch", "-f", m.Branch, m.Tip)
		} else {
			_ = gitWrite(context.Background(), m.Lock, m.Folder, "branch", "-D", m.Branch)
		}
	}
	_ = os.Remove(markPath(work))
}

// removeLocalWorktree gỡ đúng siêu dữ liệu worktree của run trong repo người dùng. Không `git worktree prune` cả repo:
// prune xoá luôn worktree của người dùng nằm trên ổ chưa gắn.
func removeLocalWorktree(dataDir, work, gitDir string) {
	if gitDir == "" {
		gitDir = linkedGitDir(work)
	}
	if gitDir == "" || filepath.Base(filepath.Dir(gitDir)) != "worktrees" {
		return
	}
	// Chỉ xoá khi siêu dữ liệu trỏ đúng về worktree của run, để file .git hỏng không làm xoá nhầm worktree khác.
	back, err := os.ReadFile(filepath.Join(gitDir, "gitdir"))
	if err != nil || !samePath(filepath.Dir(strings.TrimSpace(string(back))), work) {
		return
	}
	if unlock, err := lockRepo(context.Background(), localLock(dataDir, filepath.Dir(filepath.Dir(gitDir)))); err == nil {
		_ = os.RemoveAll(gitDir)
		unlock()
	}
}

// linkedGitDir đọc file .git của worktree ("gitdir: <repo>/.git/worktrees/<tên>"); rỗng khi không phải worktree liên kết.
func linkedGitDir(work string) string {
	b, err := os.ReadFile(filepath.Join(work, ".git"))
	if err != nil {
		return ""
	}
	dir, ok := strings.CutPrefix(strings.TrimSpace(string(b)), "gitdir:")
	if !ok {
		return ""
	}
	dir = filepath.FromSlash(strings.TrimSpace(dir))
	if !filepath.IsAbs(dir) {
		dir = filepath.Join(work, dir)
	}
	return filepath.Clean(dir)
}

type worktreeEntry struct{ path, branch string }

func parseWorktrees(porcelain string) []worktreeEntry {
	var out []worktreeEntry
	for _, block := range strings.Split(strings.ReplaceAll(porcelain, "\r\n", "\n"), "\n\n") {
		var e worktreeEntry
		for _, line := range strings.Split(block, "\n") {
			if p, ok := strings.CutPrefix(line, "worktree "); ok {
				e.path = filepath.FromSlash(p)
			} else if b, ok := strings.CutPrefix(line, "branch "); ok {
				e.branch = b
			}
		}
		if e.path != "" {
			out = append(out, e)
		}
	}
	return out
}

func insideDir(root, p string) bool {
	rel, err := filepath.Rel(cleanAbs(root), cleanAbs(p))
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func samePath(a, b string) bool { return cleanAbs(a) == cleanAbs(b) }

// cleanAbs đi qua symlink (thư mục tạm của macOS là /private/var qua /var) để so được đường dẫn git trả về với
// đường dẫn worker tự dựng; Windows không phân biệt hoa thường.
func cleanAbs(p string) string {
	if abs, err := filepath.Abs(p); err == nil {
		p = abs
	}
	// Worktree đã dời đi thì không còn để đi qua symlink: đi qua thư mục cha rồi ghép tên.
	if real, err := filepath.EvalSymlinks(p); err == nil {
		p = real
	} else if dir, err := filepath.EvalSymlinks(filepath.Dir(p)); err == nil {
		p = filepath.Join(dir, filepath.Base(p))
	}
	p = filepath.Clean(p)
	if runtime.GOOS == "windows" {
		p = strings.ToLower(p)
	}
	return p
}

// reapLocal dọn phần của repo đã gắn mà run chết giữa chừng để lại trong runs/: siêu dữ liệu worktree trong repo của
// người dùng và nhánh run đã đặt lại.
func reapLocal(dataDir, work string) {
	// Worktree của repo cache bare để vòng prune của ReapOrphans lo.
	if gitDir := linkedGitDir(work); gitDir != "" && !insideDir(filepath.Join(dataDir, "repos"), gitDir) {
		removeLocalWorktree(dataDir, work, gitDir)
	}
	restoreBranch(work)
}
