package ctxsync

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
)

// Dấu khối (research mục 2). sha nằm ngay trong dòng mở để biết khối bị sửa tay mà không cần state.json: mất trạng thái
// vẫn không ghi đè chữ người dùng.
const (
	openPrefix  = "<!-- xdev-hive:context v1 sha="
	closeMarker = "<!-- /xdev-hive:context -->"
	headLocal   = "## Tại máy"
	headHub     = "## Từ hub"
	importLine  = "@AGENTS.md"
	bom         = "\ufeff"
)

var (
	openRe  = regexp.MustCompile(`^<!--\s*xdev-hive:context\s+v1\s+sha=([0-9a-f]{12})\s*-->$`)
	closeRe = regexp.MustCompile(`^<!--\s*/xdev-hive:context\s*-->$`)
	// anyMarker bắt mọi dòng trông như dấu của app, kể cả dấu hỏng, để không coi dấu hỏng là chữ thường rồi ghi thêm
	// một khối thứ hai.
	anyMarker = regexp.MustCompile(`^<!--.*xdev-hive:context`)
)

// HubItem là một memory đã duyệt kéo từ hub, theo thứ tự đã chọn (ghim trước, mới trước).
type HubItem struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Pinned    bool   `json:"pinned"`
	CreatedAt string `json:"createdAt"`
	Content   string `json:"content"`
	Tokens    int    `json:"tokens,omitempty"`
}

// BlockOptions: ImportAgents thêm dòng @AGENTS.md cho Claude khi thư mục chỉ có AGENTS.md (có CLAUDE.local.md thì Claude
// bỏ AGENTS.md, research mục 1). EOL theo file đích để không trộn CRLF với LF.
type BlockOptions struct {
	ImportAgents bool
	EOL          string
}

// Block là một khối tìm thấy trong file. Start..End là byte của khối, từ đầu dòng mở tới hết chữ của dòng đóng, không gồm
// dấu xuống dòng sau đó: thay khối bằng khối mới không đụng byte nào ngoài khối.
type Block struct {
	Start, End int
	// Sha là băm ghi trong dòng mở; Actual là băm của Body hiện tại. Khác nhau là khối bị sửa tay.
	Sha, Actual string
	// Body là chữ giữa hai dòng dấu, đã đổi CRLF thành LF.
	Body string
	// Line là số dòng (từ 1) của dòng mở, để báo lỗi.
	Line int
}

// Edited cho biết người dùng đã sửa chữ trong khối sau lần app ghi.
func (b Block) Edited() bool { return b.Sha != b.Actual }

func hashBody(body string) string {
	sum := sha256.Sum256([]byte(body))
	return hex.EncodeToString(sum[:])[:12]
}

func normalize(s string) string { return strings.ReplaceAll(s, "\r\n", "\n") }

// renderBody dựng phần giữa hai dòng dấu (LF). Mục rỗng thì bỏ: nguồn rỗng mà có memory hub là hợp lệ.
func renderBody(local string, hub []HubItem, importAgents bool) string {
	var parts []string
	if importAgents {
		parts = append(parts, importLine)
	}
	if local = strings.Trim(normalize(local), "\n"); strings.TrimSpace(local) != "" {
		parts = append(parts, headLocal+"\n\n"+local)
	}
	if len(hub) > 0 {
		lines := make([]string, 0, len(hub))
		for _, it := range hub {
			text := strings.Trim(normalize(it.Content), "\n")
			if strings.TrimSpace(text) == "" {
				continue
			}
			lines = append(lines, "- "+strings.ReplaceAll(text, "\n", "\n  "))
		}
		if len(lines) > 0 {
			parts = append(parts, headHub+"\n\n"+strings.Join(lines, "\n"))
		}
	}
	return strings.Join(parts, "\n\n")
}

// RenderBlock dựng khối hoàn chỉnh, không có dấu xuống dòng cuối.
func RenderBlock(local string, hub []HubItem, opts BlockOptions) string {
	return wrapBody(renderBody(local, hub, opts.ImportAgents), opts.EOL)
}

func wrapBody(body, eol string) string {
	if eol == "" {
		eol = "\n"
	}
	text := openPrefix + hashBody(body) + " -->\n"
	if body != "" {
		text += body + "\n"
	}
	text += closeMarker
	return strings.ReplaceAll(text, "\n", eol)
}

// ParseBlocks tìm mọi khối trong file. Lỗi khi dấu hỏng: dòng mở không có dòng đóng, dòng đóng lạc, hai dòng mở liền
// nhau hay dòng trông như dấu mà sai dạng. Nhiều khối không phải lỗi ở đây; bên gọi quyết định.
func ParseBlocks(content string) ([]Block, error) {
	var out []Block
	open := -1
	var cur Block
	pos := 0
	for n := 1; pos <= len(content); n++ {
		end := strings.IndexByte(content[pos:], '\n')
		next := len(content) + 1
		if end >= 0 {
			end += pos
			next = end + 1
		} else {
			end = len(content)
		}
		start := pos
		line := strings.TrimSuffix(content[start:end], "\r")
		textEnd := start + len(line)
		if n == 1 && strings.HasPrefix(line, bom) {
			line = line[len(bom):]
			start += len(bom)
		}
		trimmed := strings.TrimSpace(line)
		switch {
		case openRe.MatchString(trimmed):
			if open >= 0 {
				return out, fmt.Errorf("dòng %d mở khối xdev-hive mới khi khối ở dòng %d chưa đóng", n, cur.Line)
			}
			open = next
			cur = Block{Start: start, Sha: openRe.FindStringSubmatch(trimmed)[1], Line: n}
		case closeRe.MatchString(trimmed):
			if open < 0 {
				return out, fmt.Errorf("dòng %d đóng khối xdev-hive mà không có dòng mở", n)
			}
			body := ""
			if start > open {
				body = strings.TrimSuffix(normalize(content[open:start]), "\n")
			}
			cur.End, cur.Body, cur.Actual = textEnd, body, hashBody(body)
			out = append(out, cur)
			open = -1
		case anyMarker.MatchString(trimmed):
			return out, fmt.Errorf("dòng %d có dấu xdev-hive sai dạng", n)
		}
		pos = next
	}
	if open >= 0 {
		return out, fmt.Errorf("khối xdev-hive mở ở dòng %d không có dòng đóng", cur.Line)
	}
	return out, nil
}

// LocalSection lấy phần "Tại máy" của một khối: khi người dùng chọn giữ bản trong file, phần này thành nguồn mới.
func LocalSection(body string) string {
	lines := strings.Split(normalize(body), "\n")
	if len(lines) > 0 && strings.TrimSpace(lines[0]) == importLine {
		lines = lines[1:]
	}
	local, hub := -1, -1
	for i, l := range lines {
		switch strings.TrimSpace(l) {
		case headLocal:
			if local < 0 && hub < 0 {
				local = i
			}
		case headHub:
			if hub < 0 {
				hub = i
			}
		}
	}
	start, end := 0, len(lines)
	if local >= 0 {
		start = local + 1
	}
	if hub >= start {
		end = hub
	}
	return strings.Trim(strings.Join(lines[start:end], "\n"), "\n")
}

// detectEOL lấy kiểu xuống dòng của file; file chưa có xuống dòng nào thì dùng LF.
func detectEOL(content string) string {
	if strings.Contains(content, "\r\n") {
		return "\r\n"
	}
	return "\n"
}

// appendBlock thêm khối vào cuối file. lead là phần chèn trước khối (dòng trống ngăn cách), lưu lại để tắt thì gỡ đúng
// từng byte đã thêm.
func appendBlock(content, block, eol string) (out, lead string) {
	rest := strings.TrimPrefix(content, bom)
	switch {
	case rest == "":
		lead = ""
	case strings.HasSuffix(rest, "\n"):
		lead = eol
	default:
		lead = eol + eol
	}
	return content + lead + block + eol, lead
}

// removeBlock gỡ khối b khỏi file. Khối ở cuối file thì gỡ cả dấu xuống dòng sau nó và lead đã chèn trước nó, nên file
// trở về đúng như trước khi bật.
func removeBlock(content string, b Block, lead string) string {
	start, end := b.Start, b.End
	tail := content[end:]
	switch {
	case strings.HasPrefix(tail, "\r\n"):
		end += 2
	case strings.HasPrefix(tail, "\n"):
		end++
	}
	if end == len(content) && lead != "" && strings.HasSuffix(content[:start], lead) {
		start -= len(lead)
	}
	return content[:start] + content[end:]
}
