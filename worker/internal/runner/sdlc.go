package runner

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// KindSdlc là run soạn tài liệu của chế độ AI SDLC (specs/011, ADR 0021): worktree tạm từ nhánh chính như doccheck,
// nhưng agent được ghi file (quyền workspace). Worker ghi sẵn `seed` vào worktree, chạy CLI, rồi gửi lại nội dung các
// file `collect`. Không commit, không đẩy: tài liệu đi về hub qua report.artifacts, không qua git.
const KindSdlc = "sdlc"

// Giới hạn khớp SDLC_ARTIFACT_LIMITS trong packages/contracts/src/worker-protocol.ts. Vượt thì run lỗi chứ không cắt:
// bản cắt dở dễ bị duyệt như tài liệu đầy đủ.
const (
	sdlcMaxFiles     = 20
	sdlcMaxFileChars = 200_000
	sdlcMaxTotal     = 2_000_000
	sdlcMaxSeed      = 100
)

// SdlcSeed là một file hub cần có trong worktree trước khi CLI chạy (baseline và bản nháp chưa có trong repo).
type SdlcSeed struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// SdlcCollect là một file worker đọc lại sau khi CLI thoát, kèm id hạng mục tài liệu hub gắn cho nó.
type SdlcCollect struct {
	ArtifactID string `json:"artifactId"`
	Path       string `json:"path"`
}

// SdlcJob là spec.sdlc của job_offer.
type SdlcJob struct {
	Step    string        `json:"step"`
	Seed    []SdlcSeed    `json:"seed"`
	Collect []SdlcCollect `json:"collect"`
	// Repos chỉ có khi máy khai CapSdlcMultiRepo và hạng mục có dự án tham gia đọc được (T086).
	Repos []SdlcRepo `json:"repos,omitempty"`
}

// SdlcArtifact là một phần tử của report.artifacts. SHA256 tính trên đúng chuỗi Content gửi đi (UTF-8) để hub kiểm lại.
type SdlcArtifact struct {
	ArtifactID string `json:"artifactId"`
	Path       string `json:"path"`
	Content    string `json:"content"`
	SHA256     string `json:"sha256"`
}

// worktreeFile đổi đường dẫn tương đối kiểu hub (dấu "/") thành đường dẫn tuyệt đối trong worktree. Hub đã kiểm đường
// dẫn, nhưng worker kiểm lại vì spec đi qua mạng và vì symlink chỉ có thể biết trên máy này: một repo hay chính agent
// có thể đặt symlink trỏ ra ngoài để lấy file khác của máy qua `collect` hoặc ghi đè file khác qua `seed`.
//
// root phải là đường dẫn đã giải symlink (macOS đặt thư mục tạm dưới symlink /var). Mọi thành phần đã tồn tại trên
// đường đi không được là symlink hay junction; thành phần chưa tồn tại thì sẽ do chính worker tạo.
func worktreeFile(root, rel string) (path string, exists bool, err error) {
	bad := func(why string) (string, bool, error) {
		return "", false, fmt.Errorf("đường dẫn %q không hợp lệ: %s", rel, why)
	}
	switch {
	case rel == "":
		return bad("để trống")
	case strings.ContainsRune(rel, 0):
		return bad("chứa ký tự NUL")
	// Chặn dấu "\" ở mọi hệ điều hành, như hợp đồng: trên Windows nó là dấu phân cách và có thể lách kiểm ".."
	case strings.ContainsRune(rel, '\\'):
		return bad("không dùng dấu \\, chỉ dùng dấu /")
	case strings.HasPrefix(rel, "/") || filepath.IsAbs(rel) || filepath.VolumeName(rel) != "":
		return bad("phải là đường dẫn tương đối trong repo")
	}
	parts := strings.Split(rel, "/")
	for _, part := range parts {
		if part == ".." {
			return bad("không được chứa \"..\"")
		}
	}
	// Thư mục .git của worktree là file trỏ về repo gốc; ghi vào đó có thể đổi cấu hình git của người dùng.
	if strings.EqualFold(parts[0], ".git") {
		return bad("không được ghi vào .git")
	}
	cur := root
	for i, part := range parts {
		if part == "" || part == "." {
			continue
		}
		cur = filepath.Join(cur, part)
		info, err := os.Lstat(cur)
		if errors.Is(err, os.ErrNotExist) {
			// Phần còn lại chưa có gì để đi qua symlink.
			cur = filepath.Join(append([]string{cur}, parts[i+1:]...)...)
			exists = false
			break
		}
		if err != nil {
			return "", false, fmt.Errorf("đường dẫn %q: %w", rel, err)
		}
		if info.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
			return bad("đi qua symlink hoặc liên kết, không theo ra ngoài worktree")
		}
		exists = true
	}
	if r, err := filepath.Rel(root, cur); err != nil || r == "." || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
		return bad("nằm ngoài worktree")
	}
	return cur, exists, nil
}

func resolveWorktree(work string) (string, error) {
	root, err := filepath.EvalSymlinks(work)
	if err != nil {
		return "", fmt.Errorf("worktree: %w", err)
	}
	return root, nil
}

// writeSdlcSeed ghi các file hub gửi trước khi CLI chạy. Lỗi nào cũng làm run hỏng: thiếu baseline thì agent soạn trên
// nền sai.
func writeSdlcSeed(work string, seed []SdlcSeed) error {
	if len(seed) == 0 {
		return nil
	}
	if len(seed) > sdlcMaxSeed {
		return fmt.Errorf("spec.sdlc.seed có %d file, vượt giới hạn %d", len(seed), sdlcMaxSeed)
	}
	root, err := resolveWorktree(work)
	if err != nil {
		return err
	}
	for _, s := range seed {
		if n := utf8.RuneCountInString(s.Content); n > sdlcMaxFileChars {
			return fmt.Errorf("file seed %q dài %d ký tự, vượt giới hạn %d", s.Path, n, sdlcMaxFileChars)
		}
		path, _, err := worktreeFile(root, s.Path)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return fmt.Errorf("tạo thư mục cho file seed %q: %w", s.Path, err)
		}
		// Kiểm lại sau MkdirAll: thư mục vừa tạo là thật, nhưng bước này rẻ và khép kín khe hở giữa kiểm và ghi.
		if _, _, err := worktreeFile(root, s.Path); err != nil {
			return err
		}
		if err := os.WriteFile(path, []byte(s.Content), 0o644); err != nil {
			return fmt.Errorf("ghi file seed %q: %w", s.Path, err)
		}
	}
	return nil
}

// collectSdlcArtifacts đọc các file `collect` sau khi CLI thoát. File không có thì bỏ qua: hub coi "không có file" là
// bước thất bại, và agent không soạn ra file không phải lỗi của worker. Vượt giới hạn là lỗi của run, nói rõ giới hạn nào.
func collectSdlcArtifacts(work string, collect []SdlcCollect) ([]SdlcArtifact, error) {
	if len(collect) == 0 {
		return nil, nil
	}
	if len(collect) > sdlcMaxFiles {
		return nil, fmt.Errorf("spec.sdlc.collect có %d file, vượt giới hạn %d file mỗi run", len(collect), sdlcMaxFiles)
	}
	root, err := resolveWorktree(work)
	if err != nil {
		return nil, err
	}
	out := make([]SdlcArtifact, 0, len(collect))
	total := 0
	for _, c := range collect {
		path, exists, err := worktreeFile(root, c.Path)
		if err != nil {
			return nil, err
		}
		if !exists {
			continue
		}
		info, err := os.Lstat(path)
		if err != nil {
			return nil, fmt.Errorf("đọc file %q: %w", c.Path, err)
		}
		// Chỉ file thường: mở FIFO hay thiết bị có thể treo worker mãi.
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("%q không phải file thường", c.Path)
		}
		// Một ký tự UTF-8 tối đa 4 byte: file lớn hơn mức này chắc chắn vượt giới hạn ký tự, khỏi đọc vào bộ nhớ.
		if info.Size() > int64(sdlcMaxFileChars)*utf8.UTFMax {
			return nil, fmt.Errorf("file %q quá lớn (%d byte), giới hạn %d ký tự mỗi file", c.Path, info.Size(), sdlcMaxFileChars)
		}
		f, err := os.Open(path)
		if err != nil {
			return nil, fmt.Errorf("đọc file %q: %w", c.Path, err)
		}
		raw, err := io.ReadAll(io.LimitReader(f, int64(sdlcMaxFileChars)*utf8.UTFMax+1))
		_ = f.Close()
		if err != nil {
			return nil, fmt.Errorf("đọc file %q: %w", c.Path, err)
		}
		content := string(raw)
		if !utf8.Valid(raw) {
			// JSON thay mỗi byte hỏng bằng U+FFFD; làm trước để sha256 khớp với chuỗi hub nhận.
			content = string([]rune(content))
		}
		if n := utf8.RuneCountInString(content); n > sdlcMaxFileChars {
			return nil, fmt.Errorf("file %q dài %d ký tự, giới hạn %d ký tự mỗi file", c.Path, n, sdlcMaxFileChars)
		}
		total += len(content)
		if total > sdlcMaxTotal {
			return nil, fmt.Errorf("các file thu về vượt giới hạn tổng %d byte", sdlcMaxTotal)
		}
		sum := sha256.Sum256([]byte(content))
		out = append(out, SdlcArtifact{ArtifactID: c.ArtifactID, Path: c.Path, Content: content, SHA256: hex.EncodeToString(sum[:])})
	}
	return out, nil
}
