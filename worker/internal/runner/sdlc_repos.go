package runner

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/procattr"
)

// CapSdlcMultiRepo: worker checkout được các repo tham gia của hạng mục nhiều dự án cho run sdlc (specs/011 T086). Hub
// chỉ gửi spec.sdlc.repos cho máy khai capability này; máy khác vẫn nhận tóm tắt repo trong seed như trước.
const CapSdlcMultiRepo = "sdlc-multirepo"

// SdlcReposDir là thư mục chứa các repo tham gia trong worktree tạm. Khớp SDLC_REPOS_DIR của hub.
const SdlcReposDir = ".hive/repos"

// sdlcReposStatus là file worker ghi để agent biết repo nào đã có, repo nào không lấy được và vì sao. Prompt của hub trỏ
// tới file này vì hub không biết trước máy nào sẽ clone được repo nào.
const sdlcReposStatus = SdlcReposDir + "/STATUS.md"

// Giới hạn của checkout nhiều repo. Là biến để test hạ xuống; repo quá cỡ bị bỏ (agent dùng tóm tắt), không làm hỏng run.
var (
	sdlcMaxRepos         = 8
	sdlcRepoMaxBytes     = int64(200 << 20)
	sdlcReposMaxBytes    = int64(500 << 20)
	sdlcRepoCloneTimeout = 5 * time.Minute
	// sdlcRepoSchemes: hub gửi repoHttpUrl của dự án. Không nhận file:// hay ext:: để hub không lấy được repo cục bộ
	// của máy hay chạy lệnh qua transport của git; test thêm "file".
	sdlcRepoSchemes = map[string]bool{"https": true, "http": true, "ssh": true}
)

var (
	sdlcRepoKey    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	sdlcRepoBranch = regexp.MustCompile(`^[A-Za-z0-9_./-]{1,200}$`)
	// scp-like của ssh: git@host:owner/repo.git
	sdlcRepoSCP = regexp.MustCompile(`^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._/~-]+$`)
)

// SdlcRepo là một phần tử của spec.sdlc.repos: repo của dự án tham gia mà run nên có bản chỉ đọc.
type SdlcRepo struct {
	ProjectKey string `json:"projectKey"`
	CloneURL   string `json:"cloneUrl"`
	Branch     string `json:"branch"`
	Dir        string `json:"dir"`
}

// SdlcRepoStatus là kết quả checkout của một repo; Reason rỗng khi đã có.
type SdlcRepoStatus struct {
	ProjectKey string
	Dir        string
	Reason     string
}

func validSdlcRepoURL(raw string) bool {
	if sdlcRepoSchemes["ssh"] && sdlcRepoSCP.MatchString(raw) {
		return true
	}
	u, err := url.Parse(raw)
	if err != nil || !sdlcRepoSchemes[strings.ToLower(u.Scheme)] {
		return false
	}
	// file:// không có host; mọi scheme mạng phải có.
	return u.Host != "" || u.Scheme == "file"
}

func validateSdlcRepo(r SdlcRepo) error {
	if !sdlcRepoKey.MatchString(r.ProjectKey) {
		return fmt.Errorf("mã dự án %q không hợp lệ", r.ProjectKey)
	}
	if r.Dir != SdlcReposDir+"/"+r.ProjectKey {
		return fmt.Errorf("thư mục %q phải là %s/%s", r.Dir, SdlcReposDir, r.ProjectKey)
	}
	// Nhánh bắt đầu bằng "-" thành cờ của git; ".." không phải tên nhánh hợp lệ.
	if !sdlcRepoBranch.MatchString(r.Branch) || strings.HasPrefix(r.Branch, "-") || strings.Contains(r.Branch, "..") {
		return fmt.Errorf("nhánh %q không hợp lệ", r.Branch)
	}
	if !validSdlcRepoURL(r.CloneURL) {
		return errors.New("địa chỉ repo không được phép")
	}
	return nil
}

// checkoutSdlcRepos clone nông (depth 1) từng repo vào SdlcReposDir của worktree, bỏ .git để không có gì đẩy được, rồi
// khoá ghi. Repo nào không lấy được (máy thiếu quyền đọc, mạng, quá cỡ) thì bỏ và ghi lý do vào STATUS.md: agent vẫn có
// tóm tắt repo hub seed sẵn. Lỗi trả về chỉ khi chính worktree có vấn đề.
func checkoutSdlcRepos(ctx context.Context, work string, repos []SdlcRepo) ([]SdlcRepoStatus, error) {
	if len(repos) == 0 {
		return nil, nil
	}
	root, err := resolveWorktree(work)
	if err != nil {
		return nil, err
	}
	base, exists, err := worktreeFile(root, SdlcReposDir)
	if err != nil {
		return nil, err
	}
	// Repo của dự án có sẵn thư mục này thì không trộn bản checkout vào file của repo.
	if exists {
		return nil, fmt.Errorf("worktree đã có %s, không checkout repo tham gia vào đó", SdlcReposDir)
	}
	if err := os.MkdirAll(base, 0o755); err != nil {
		return nil, fmt.Errorf("tạo %s: %w", SdlcReposDir, err)
	}
	out := make([]SdlcRepoStatus, 0, len(repos))
	seen := map[string]bool{}
	var total int64
	for i, r := range repos {
		st := SdlcRepoStatus{ProjectKey: r.ProjectKey, Dir: r.Dir}
		switch {
		case i >= sdlcMaxRepos:
			st.Reason = fmt.Sprintf("vượt giới hạn %d repo mỗi run", sdlcMaxRepos)
		case validateSdlcRepo(r) != nil:
			st.Reason = validateSdlcRepo(r).Error()
		case seen[strings.ToLower(r.ProjectKey)]:
			st.Reason = "trùng dự án"
		default:
			seen[strings.ToLower(r.ProjectKey)] = true
			size, reason := cloneSdlcRepo(ctx, filepath.Join(base, r.ProjectKey), r, sdlcReposMaxBytes-total)
			total += size
			st.Reason = reason
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		out = append(out, st)
	}
	if err := os.WriteFile(filepath.Join(base, "STATUS.md"), []byte(sdlcReposStatusText(out)), 0o644); err != nil {
		return nil, fmt.Errorf("ghi %s: %w", sdlcReposStatus, err)
	}
	return out, nil
}

// cloneSdlcRepo trả số byte đã giữ lại và lý do bỏ (rỗng khi đã có repo).
func cloneSdlcRepo(ctx context.Context, dest string, r SdlcRepo, budget int64) (int64, string) {
	cctx, cancel := context.WithTimeout(ctx, sdlcRepoCloneTimeout)
	defer cancel()
	// core.symlinks=false: symlink trong repo tham gia thành file thường, không trỏ ra file khác của máy. Không đệ quy
	// submodule, không tải LFS: agent chỉ cần đọc code và tài liệu.
	c := procattr.CommandContext(cctx, "git", "-c", "core.symlinks=false", "-c", "advice.detachedHead=false",
		"clone", "--depth", "1", "--single-branch", "--no-tags", "--branch", r.Branch, "--", r.CloneURL, dest)
	// Máy thiếu quyền thì git hỏi mật khẩu và treo run; tắt mọi lời hỏi để lỗi trả về ngay.
	c.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=never", "GIT_LFS_SKIP_SMUDGE=1")
	var stderr bytes.Buffer
	c.Stderr = &stderr
	if err := c.Run(); err != nil {
		_ = forceRemoveAll(dest)
		if errors.Is(cctx.Err(), context.DeadlineExceeded) && ctx.Err() == nil {
			return 0, fmt.Sprintf("clone quá %s", sdlcRepoCloneTimeout)
		}
		return 0, "không clone được (máy thiếu quyền đọc repo hoặc lỗi mạng): " + lastLine(stderr.String())
	}
	if err := os.RemoveAll(filepath.Join(dest, ".git")); err != nil {
		_ = forceRemoveAll(dest)
		return 0, "không gỡ được .git của bản checkout"
	}
	size, err := dirSize(dest)
	limit := min(sdlcRepoMaxBytes, budget)
	if err != nil || size > limit {
		_ = forceRemoveAll(dest)
		if err != nil {
			return 0, "không đọc được bản checkout"
		}
		return 0, fmt.Sprintf("vượt giới hạn kích thước (%d MB, còn được %d MB)", size>>20, max(limit, 0)>>20)
	}
	if err := setReadOnly(dest); err != nil {
		_ = forceRemoveAll(dest)
		return 0, "không khoá ghi được bản checkout"
	}
	return size, ""
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	line := strings.TrimSpace(lines[len(lines)-1])
	if len(line) > 200 {
		line = line[:200]
	}
	return line
}

func dirSize(dir string) (int64, error) {
	var n int64
	err := filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type().IsRegular() {
			info, err := d.Info()
			if err != nil {
				return err
			}
			n += info.Size()
		}
		return nil
	})
	return n, err
}

// setReadOnly bỏ quyền ghi của file và thư mục. Trên Windows thuộc tính chỉ đọc của thư mục không chặn tạo file nên chỉ
// khoá file. Agent vẫn có thể tự đổi quyền; đây là rào để công cụ ghi của CLI báo lỗi thay vì lặng lẽ sửa repo khác.
func setReadOnly(dir string) error {
	var dirs []string
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			dirs = append(dirs, path)
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		return os.Chmod(path, info.Mode().Perm()&^0o222)
	})
	if err != nil || runtime.GOOS == "windows" {
		return err
	}
	// Thư mục khoá sau cùng, từ trong ra ngoài, vì khoá thư mục cha trước thì không đổi quyền con được nữa.
	for i := len(dirs) - 1; i >= 0; i-- {
		if err := os.Chmod(dirs[i], 0o555); err != nil {
			return err
		}
	}
	return nil
}

// forceRemoveAll trả lại quyền ghi rồi xoá: os.RemoveAll không xoá được file trong thư mục đã khoá ghi, và trên Windows
// không xoá được file chỉ đọc.
func forceRemoveAll(dir string) error {
	if _, err := os.Lstat(dir); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			_ = os.Chmod(path, 0o755)
		} else if d.Type().IsRegular() {
			_ = os.Chmod(path, 0o644)
		}
		return nil
	})
	return os.RemoveAll(dir)
}

// removeSdlcRepos dọn các repo tham gia trước khi worktree bị dời đi xoá: bản checkout đã khoá ghi nên đường dọn chung
// của worktree không xoá được.
func removeSdlcRepos(work string) error {
	return forceRemoveAll(filepath.Join(work, filepath.FromSlash(SdlcReposDir)))
}

func sdlcReposStatusText(st []SdlcRepoStatus) string {
	var b strings.Builder
	b.WriteString("# Repo tham gia\n\nBản checkout nông, chỉ đọc, không có lịch sử git. Không sửa, không commit vào đây.\n\n")
	for _, s := range st {
		if s.Reason == "" {
			fmt.Fprintf(&b, "- %s: `%s/`\n", s.ProjectKey, s.Dir)
		} else {
			fmt.Fprintf(&b, "- %s: không có bản checkout (%s); đọc tóm tắt repo hub đã seed\n", s.ProjectKey, s.Reason)
		}
	}
	return b.String()
}
