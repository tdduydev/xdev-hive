package memstore

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/procattr"
)

// maxCompressChars chặn gói quá lớn: prompt nén mà tốn hơn số token tiết kiệm được thì vô nghĩa.
const maxCompressChars = 200_000

// CompressTimeout là thời gian tối đa cho một lần nhờ AI nén.
const CompressTimeout = 5 * time.Minute

// CompressOptions: Command là lệnh `claude` (Args là phần đứng trước các cờ của worker, dùng cho CLI giả khi test).
// Env là biến môi trường thêm cho gói được chọn (CLAUDE_CONFIG_DIR).
type CompressOptions struct {
	Command string
	Args    []string
	Env     []string
	Files   []string
	Timeout time.Duration
}

// Proposal là đề xuất cho một file. Chưa ghi gì: người dùng xem diff rồi mới gọi `memory edit`.
type Proposal struct {
	Path         string `json:"path"`
	Before       string `json:"before"`
	Content      string `json:"content"`
	TokensBefore int    `json:"tokensBefore"`
	TokensAfter  int    `json:"tokensAfter"`
	// NewLines là số dòng (từ 1) của Content mà không có trong bất kỳ file nguồn nào, để người duyệt soi kỹ phần AI tự
	// thêm.
	NewLines []int `json:"newLines"`
}

type Compression struct {
	Files      []Proposal `json:"files"`
	TokensUsed int        `json:"tokensUsed"`
	Warnings   []string   `json:"warnings"`
}

// Compress copy các file vào thư mục tạm rồi chạy Claude Code chỉ đọc trong đó: `--restricted` giam tool file trong thư
// mục làm việc, nên dù prompt bị file memory chèn lệnh, CLI cũng không chạm được file thật của người dùng.
func Compress(ctx context.Context, opts CompressOptions) (Compression, error) {
	if len(opts.Files) == 0 {
		return Compression{}, errors.New("chưa chọn file memory nào để nén")
	}
	if opts.Command == "" {
		return Compression{}, errors.New("không tìm thấy lệnh claude")
	}
	work, err := os.MkdirTemp("", "hive-compress-")
	if err != nil {
		return Compression{}, err
	}
	defer os.RemoveAll(work)

	type source struct{ path, name, content string }
	var sources []source
	total := 0
	for i, p := range opts.Files {
		raw, err := os.ReadFile(p)
		if err != nil {
			return Compression{}, fmt.Errorf("không đọc được %s: %w", p, err)
		}
		total += len(raw)
		if total > maxCompressChars {
			return Compression{}, fmt.Errorf("các file chọn dài quá %d ký tự, hãy chọn ít file hơn", maxCompressChars)
		}
		// Số thứ tự đứng đầu để hai file cùng tên ở hai thư mục không đè nhau.
		name := fmt.Sprintf("%02d-%s", i+1, filepath.Base(p))
		if err := os.WriteFile(filepath.Join(work, name), raw, 0o600); err != nil {
			return Compression{}, err
		}
		sources = append(sources, source{p, name, string(raw)})
	}

	var names []string
	for _, s := range sources {
		names = append(names, s.name)
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = CompressTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	args := append(append([]string{}, opts.Args...), "-p", "--output-format", "json", "--restricted", "--strict-mcp-config",
		"--tools", "Read,Glob,Grep", "--permission-prompts", "none")
	cmd := procattr.CommandContext(ctx, opts.Command, args...)
	cmd.Dir = work
	cmd.Env = append(os.Environ(), opts.Env...)
	cmd.Stdin = strings.NewReader(compressPrompt(names))
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return Compression{}, fmt.Errorf("claude không trả lời trong %s", timeout)
		}
		detail := strings.TrimSpace(stderr.String())
		if len(detail) > 300 {
			detail = detail[:300]
		}
		return Compression{}, fmt.Errorf("claude lỗi: %v %s", err, detail)
	}

	var reply struct {
		Result  string `json:"result"`
		IsError bool   `json:"is_error"`
		Usage   struct {
			Input         int `json:"input_tokens"`
			Output        int `json:"output_tokens"`
			CacheCreation int `json:"cache_creation_input_tokens"`
			CacheRead     int `json:"cache_read_input_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &reply); err != nil {
		return Compression{}, fmt.Errorf("không đọc được kết quả của claude: %w", err)
	}
	if reply.IsError {
		return Compression{}, fmt.Errorf("claude báo lỗi: %s", reply.Result)
	}
	out := Compression{Files: []Proposal{}, Warnings: []string{},
		TokensUsed: reply.Usage.Input + reply.Usage.Output + reply.Usage.CacheCreation + reply.Usage.CacheRead}
	var answer struct {
		Files []struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		} `json:"files"`
	}
	if err := json.Unmarshal([]byte(extractJSON(reply.Result)), &answer); err != nil {
		return out, errors.New("claude không trả về JSON đề xuất hợp lệ")
	}

	known := map[string]bool{}
	for _, s := range sources {
		for _, line := range strings.Split(s.content, "\n") {
			if k := lineKey(line); k != "" {
				known[k] = true
			}
		}
	}
	seen := map[string]bool{}
	for _, f := range answer.Files {
		var src *source
		for i := range sources {
			if sources[i].name == f.Path || sources[i].path == f.Path {
				src = &sources[i]
			}
		}
		switch {
		case src == nil:
			out.Warnings = append(out.Warnings, "Bỏ qua đề xuất cho file không nằm trong danh sách chọn: "+f.Path)
			continue
		case seen[src.path]:
			out.Warnings = append(out.Warnings, "Bỏ qua đề xuất lặp cho "+src.path)
			continue
		case strings.TrimSpace(f.Content) == "":
			// Nén không có nghĩa là xoá; xoá đi qua `memory delete` để có thùng rác và xác nhận.
			out.Warnings = append(out.Warnings, "Bỏ qua đề xuất rỗng cho "+src.path)
			continue
		case f.Content == src.content:
			continue
		}
		seen[src.path] = true
		p := Proposal{Path: src.path, Before: src.content, Content: f.Content, NewLines: []int{},
			TokensBefore: EstimateTokens(src.content), TokensAfter: EstimateTokens(f.Content)}
		for i, line := range strings.Split(f.Content, "\n") {
			if k := lineKey(line); k != "" && !known[k] {
				p.NewLines = append(p.NewLines, i+1)
			}
		}
		out.Files = append(out.Files, p)
	}
	return out, nil
}

func compressPrompt(names []string) string {
	var b strings.Builder
	b.WriteString("Bạn đang nén các file memory/instruction của một CLI lập trình để mỗi phiên tốn ít token hơn.\n")
	b.WriteString("Các file nằm trong thư mục làm việc hiện tại, đọc bằng tool Read:\n")
	for _, n := range names {
		b.WriteString("- " + n + "\n")
	}
	b.WriteString("\nQuy tắc:\n")
	b.WriteString("- Giữ mọi sự thật, quy ước và đường dẫn còn dùng được; bỏ lặp, chữ thừa, mục đã cũ. Không bịa thêm ý mới.\n")
	b.WriteString("- Giữ nguyên ngôn ngữ, định dạng markdown và các liên kết giữa các file (MEMORY.md trỏ tới file chủ đề).\n")
	b.WriteString("- Chỉ trả về file cần đổi. Không sửa file bằng tool, không chạy lệnh.\n")
	b.WriteString("\nTrả lời DUY NHẤT một đối tượng JSON, không kèm giải thích:\n")
	b.WriteString(`{"files":[{"path":"<đúng tên file ở trên>","content":"<nội dung mới đầy đủ>"}]}` + "\n")
	return b.String()
}

// extractJSON bỏ rào ``` và chữ dẫn mà model hay thêm quanh đối tượng JSON.
func extractJSON(text string) string {
	start, end := strings.Index(text, "{"), strings.LastIndex(text, "}")
	if start < 0 || end < start {
		return text
	}
	return text[start : end+1]
}

// lineKey chuẩn hoá một dòng để so "có nguồn hay không"; dòng trống và dòng chỉ có dấu định dạng không tính là mới.
func lineKey(line string) string {
	k := strings.Join(strings.Fields(line), " ")
	if strings.Trim(k, "-*_#>`=| ") == "" {
		return ""
	}
	return k
}
