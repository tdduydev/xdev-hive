package ctxsync

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/tdduydev/xdev-hive/worker/internal/gitexclude"
)

// TargetID là CLI nhận khối ngữ cảnh.
type TargetID string

const (
	Claude      TargetID = "claude"
	Codex       TargetID = "codex"
	Gemini      TargetID = "gemini"
	Antigravity TargetID = "antigravity"
)

// Targets theo thứ tự ghi và hiển thị.
var Targets = []TargetID{Claude, Codex, Gemini, Antigravity}

// Readable là kết quả kiểm tay từng CLI có đọc file cục bộ không (task T001, research mục 9). Chưa kiểm nên theo tài
// liệu (research mục 1) coi cả bốn là đọc được; CLI kiểm ra "không" thì đặt false để file đích thành skipped.
var Readable = map[TargetID]bool{Claude: true, Codex: true, Gemini: true, Antigravity: true}

var targetNames = map[TargetID]string{Claude: "Claude Code", Codex: "Codex", Gemini: "Gemini CLI", Antigravity: "Antigravity"}

var (
	geminiSettings  = filepath.Join(".gemini", "settings.json")
	geminiLocalName = "GEMINI.local.md"
	// antigravityMax: Antigravity cắt rule dài hơn mức này (research mục 1), khối bị cắt thì mất dòng đóng.
	antigravityMax = 24000
)

func targetPath(id TargetID) string {
	switch id {
	case Claude:
		return "CLAUDE.local.md"
	case Codex:
		return "AGENTS.override.md"
	case Gemini:
		return geminiLocalName
	case Antigravity:
		return filepath.Join(".agents", "rules", "xdev-hive.md")
	}
	return ""
}

func validTarget(id TargetID) bool { return targetPath(id) != "" }

// write là một file sẽ ghi trong một lần đồng bộ.
type write struct {
	rel     string
	content string
}

// planned là kết quả tính cho một file đích: trạng thái và các file cần ghi (rỗng là đã đúng). Chưa ghi gì.
type planned struct {
	id       TargetID
	status   string
	reason   string
	block    *Block
	conflict *Conflict
	writes   []write
	// excludes là đường dẫn cần thêm vào .git/info/exclude khi ghi.
	excludes []string
	// excludeLine là dòng exclude đã thêm cho file đích trong lần ghi này.
	excludeLine *string
	sha         string
	created     bool
	lead        *string
	mirror      *Mirror
	extra       *GeminiExtra
}

func skipped(id TargetID, reason string) planned {
	return planned{id: id, status: StatusSkipped, reason: reason}
}

// readTarget đọc file đích sau khi kiểm nó nằm trong dự án và ghi được. reason không rỗng thì phải bỏ qua file này.
func readTarget(folder, rel string) (cur string, exists bool, reason string) {
	parts := strings.Split(filepath.ToSlash(rel), "/")
	for i := 1; i < len(parts); i++ {
		dir := filepath.Join(folder, filepath.Join(parts[:i]...))
		st, err := os.Lstat(dir)
		if os.IsNotExist(err) {
			break
		}
		if err != nil {
			return "", false, fmt.Sprintf("Không đọc được %s: %v", filepath.ToSlash(rel), err)
		}
		if st.Mode()&os.ModeSymlink != 0 || !st.IsDir() {
			return "", false, fmt.Sprintf("%s trỏ ra ngoài thư mục dự án: bỏ qua để không ghi nhầm chỗ", strings.Join(parts[:i], "/"))
		}
	}
	path := filepath.Join(folder, rel)
	st, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return "", false, ""
	}
	if err != nil {
		return "", false, fmt.Sprintf("Không đọc được %s: %v", filepath.ToSlash(rel), err)
	}
	switch {
	case st.Mode()&os.ModeSymlink != 0:
		return "", false, filepath.ToSlash(rel) + " là liên kết tượng trưng: bỏ qua để không ghi ra ngoài dự án"
	case !st.Mode().IsRegular():
		return "", false, filepath.ToSlash(rel) + " không phải file thường"
	case st.Mode().Perm()&0o200 == 0:
		return "", false, filepath.ToSlash(rel) + " chỉ đọc: bỏ quyền chỉ đọc rồi đồng bộ lại"
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", false, fmt.Sprintf("Không đọc được %s: %v", filepath.ToSlash(rel), err)
	}
	return string(raw), true, ""
}

func trackedReason(rel string) string {
	r := filepath.ToSlash(rel)
	return fmt.Sprintf("%s đang được git theo dõi: chạy `git rm --cached %s` rồi đồng bộ lại để không đưa ngữ cảnh của máy vào repo", r, r)
}

// singleBlock đọc khối của app trong file: lỗi dấu hay nhiều khối thì trả lý do bỏ qua.
func singleBlock(rel, cur string) (*Block, string) {
	blocks, err := ParseBlocks(cur)
	if err != nil {
		return nil, fmt.Sprintf("%s: %v. Sửa tay còn đúng một khối rồi đồng bộ lại", filepath.ToSlash(rel), err)
	}
	switch len(blocks) {
	case 0:
		return nil, ""
	case 1:
		return &blocks[0], ""
	}
	lines := make([]string, len(blocks))
	for i, b := range blocks {
		lines[i] = fmt.Sprint(b.Line)
	}
	return nil, fmt.Sprintf("%s có %d khối xdev-hive (dòng %s): xoá bớt còn một khối rồi đồng bộ lại",
		filepath.ToSlash(rel), len(blocks), strings.Join(lines, ", "))
}

func conflictOf(id TargetID, b *Block, source string) planned {
	return planned{id: id, status: StatusConflict, block: b,
		reason:   "Khối trong file đã bị sửa tay: chọn giữ bản trong file hay bản nguồn",
		conflict: &Conflict{File: LocalSection(b.Body), Source: source}}
}

// planEmbedded tính khối cho file mà người dùng cũng viết (CLAUDE.local.md, GEMINI.local.md): chỉ thay byte trong khối,
// hoặc thêm khối vào cuối file.
func planEmbedded(id TargetID, rel, cur string, exists bool, body, source string, force bool) planned {
	p := planned{id: id, status: StatusOK, sha: hashBody(body)}
	if !exists {
		p.created = true
		p.lead = strPtr("")
		p.writes = []write{{rel: rel, content: wrapBody(body, "\n") + "\n"}}
		p.excludes = []string{rel}
		return p
	}
	b, reason := singleBlock(rel, cur)
	if reason != "" {
		return skipped(id, reason)
	}
	eol := detectEOL(cur)
	var next string
	if b != nil {
		if b.Edited() && !force {
			return conflictOf(id, b, source)
		}
		p.block = b
		next = cur[:b.Start] + wrapBody(body, eol) + cur[b.End:]
	} else {
		var lead string
		next, lead = appendBlock(cur, wrapBody(body, eol), eol)
		p.lead = &lead
	}
	if next != cur {
		p.writes = []write{{rel: rel, content: next}}
		p.excludes = []string{rel}
	}
	return p
}

// planOwned tính file mà cả file thuộc app (gương Codex, rule Antigravity). File có sẵn mà không có khối của app là của
// người dùng: không đụng tới.
func planOwned(id TargetID, rel, cur string, exists bool, body, source string, force bool, build func(block string) string) planned {
	p := planned{id: id, status: StatusOK, sha: hashBody(body), created: !exists}
	if exists {
		b, reason := singleBlock(rel, cur)
		if reason != "" {
			return skipped(id, reason)
		}
		// Không có khối thì kể cả file app tạo cũng đã bị người dùng viết lại: không ghi đè.
		if b == nil {
			return skipped(id, filepath.ToSlash(rel)+" do người dùng tự viết: giữ nguyên, "+targetNames[id]+" không nhận ngữ cảnh dùng chung")
		}
		if b.Edited() && !force {
			return conflictOf(id, b, source)
		}
		p.block = b
		// Có khối của app thì file là của app, kể cả khi state.json đã mất.
		p.created = true
	}
	next := build(wrapBody(body, "\n"))
	if next != cur || !exists {
		p.writes = []write{{rel: rel, content: next}}
		p.excludes = []string{rel}
	}
	return p
}

func planAntigravity(folder string, body, source string, force bool) planned {
	rel := targetPath(Antigravity)
	cur, exists, reason := readTarget(folder, rel)
	if reason != "" {
		return skipped(Antigravity, reason)
	}
	// Thiếu frontmatter trigger: always_on thì Antigravity bỏ rule im lặng (research mục 1).
	p := planOwned(Antigravity, rel, cur, exists, body, source, force, func(block string) string {
		return "---\ntrigger: always_on\n---\n\n" + block + "\n"
	})
	for _, w := range p.writes {
		if len(w.content) > antigravityMax {
			return skipped(Antigravity, fmt.Sprintf("Khối dài %d byte, Antigravity cắt rule quá %d byte: rút gọn nguồn", len(w.content), antigravityMax))
		}
	}
	return p
}

// claudeImportsAgents: tạo CLAUDE.local.md ở thư mục chỉ có AGENTS.md làm Claude bỏ AGENTS.md (research mục 1), nên
// khối nhập lại nó.
func claudeImportsAgents(folder string) bool {
	for _, rel := range []string{"CLAUDE.md", filepath.Join(".claude", "CLAUDE.md")} {
		if _, err := os.Stat(filepath.Join(folder, rel)); err == nil {
			return false
		}
	}
	st, err := os.Stat(filepath.Join(folder, "AGENTS.md"))
	return err == nil && st.Mode().IsRegular()
}

// planGemini ghi GEMINI.local.md và thêm tên đó vào context.fileName của .gemini/settings.json, vì Gemini không tự đọc
// file cục bộ nào (research mục 1).
func planGemini(folder string, ts TargetState, body, source string, force bool) planned {
	if gitexclude.Tracked(folder, geminiSettings) {
		return skipped(Gemini, filepath.ToSlash(geminiSettings)+" đang được git theo dõi: app không sửa file chung của đội, Gemini không nhận ngữ cảnh dùng chung")
	}
	settings, sExists, reason := readTarget(folder, geminiSettings)
	if reason != "" {
		return skipped(Gemini, reason)
	}
	rel := targetPath(Gemini)
	if gitexclude.Tracked(folder, rel) {
		return skipped(Gemini, trackedReason(rel))
	}
	cur, exists, reason := readTarget(folder, rel)
	if reason != "" {
		return skipped(Gemini, reason)
	}
	p := planEmbedded(Gemini, rel, cur, exists, body, source, force)
	if p.status != StatusOK {
		return p
	}
	next, changed, err := addFileName([]byte(settings))
	if err != nil {
		return skipped(Gemini, fmt.Sprintf("%s: %v", filepath.ToSlash(geminiSettings), err))
	}
	extra := ts.Extra
	if changed {
		if extra == nil {
			extra = &GeminiExtra{Settings: filepath.ToSlash(geminiSettings), Added: geminiLocalName, Created: !sExists, Before: settings,
				WroteSha: hashBody(string(next))}
		} else {
			// Ghi lại lần nữa nghĩa là người dùng đã sửa file sau lần đầu: Before không còn đúng, tắt thì chỉ gỡ tên.
			cp := *extra
			cp.WroteSha = ""
			extra = &cp
		}
		p.writes = append(p.writes, write{rel: geminiSettings, content: string(next)})
		if !sExists {
			p.excludes = append(p.excludes, geminiSettings)
		}
	}
	p.extra = extra
	return p
}

// --- .gemini/settings.json giữ thứ tự khoá ---

type kv struct {
	key string
	val json.RawMessage
}

func parseObject(raw []byte) ([]kv, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil, fmt.Errorf("không phải JSON object, không sửa")
	}
	var items []kv
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, fmt.Errorf("JSON hỏng, không sửa: %w", err)
		}
		var val json.RawMessage
		if err := dec.Decode(&val); err != nil {
			return nil, fmt.Errorf("JSON hỏng, không sửa: %w", err)
		}
		items = append(items, kv{key: keyTok.(string), val: val})
	}
	if _, err := dec.Token(); err != nil {
		return nil, fmt.Errorf("JSON hỏng, không sửa: %w", err)
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, fmt.Errorf("còn dữ liệu sau JSON object, không sửa")
	}
	return items, nil
}

func renderObject(items []kv) []byte {
	if len(items) == 0 {
		return []byte("{}\n")
	}
	var buf bytes.Buffer
	buf.WriteString("{\n")
	for i, it := range items {
		key, _ := json.Marshal(it.key)
		var val bytes.Buffer
		if err := json.Indent(&val, it.val, "  ", "  "); err != nil {
			val.Reset()
			val.Write(it.val)
		}
		buf.WriteString("  " + string(key) + ": " + val.String())
		if i < len(items)-1 {
			buf.WriteString(",")
		}
		buf.WriteString("\n")
	}
	buf.WriteString("}\n")
	return buf.Bytes()
}

func compactObject(items []kv) json.RawMessage {
	var buf bytes.Buffer
	if err := json.Compact(&buf, renderObject(items)); err != nil {
		return json.RawMessage("{}")
	}
	return buf.Bytes()
}

func getKV(items []kv, key string) (json.RawMessage, bool) {
	for _, it := range items {
		if it.key == key {
			return it.val, true
		}
	}
	return nil, false
}

func setKV(items []kv, key string, val json.RawMessage) []kv {
	for i := range items {
		if items[i].key == key {
			items[i].val = val
			return items
		}
	}
	return append(items, kv{key: key, val: val})
}

func delKV(items []kv, key string) []kv {
	out := items[:0:0]
	for _, it := range items {
		if it.key != key {
			out = append(out, it)
		}
	}
	return out
}

// fileNames đọc context.fileName (chuỗi hoặc mảng chuỗi).
func fileNames(raw json.RawMessage) ([]string, error) {
	var one string
	if json.Unmarshal(raw, &one) == nil {
		return []string{one}, nil
	}
	var many []string
	if err := json.Unmarshal(raw, &many); err != nil {
		return nil, fmt.Errorf("context.fileName không phải chuỗi hay mảng chuỗi, không sửa")
	}
	return many, nil
}

// addFileName thêm GEMINI.local.md vào context.fileName. Chưa đặt thì giữ GEMINI.md mặc định của Gemini ở đầu.
func addFileName(raw []byte) ([]byte, bool, error) {
	items, err := parseObject(raw)
	if err != nil {
		return nil, false, err
	}
	var ctx []kv
	if v, ok := getKV(items, "context"); ok {
		if ctx, err = parseObject(v); err != nil {
			return nil, false, fmt.Errorf("context %v", err)
		}
	}
	names := []string{"GEMINI.md"}
	if v, ok := getKV(ctx, "fileName"); ok {
		if names, err = fileNames(v); err != nil {
			return nil, false, err
		}
	}
	for _, n := range names {
		if n == geminiLocalName {
			return raw, false, nil
		}
	}
	val, _ := json.Marshal(append(names, geminiLocalName))
	ctx = setKV(ctx, "fileName", val)
	items = setKV(items, "context", compactObject(ctx))
	return renderObject(items), true, nil
}

// removeFileName gỡ GEMINI.local.md khỏi context.fileName; khoá rỗng sau khi gỡ thì bỏ luôn. empty=true khi cả file chỉ
// còn {}.
func removeFileName(raw []byte) (out []byte, changed, empty bool, err error) {
	items, err := parseObject(raw)
	if err != nil {
		return nil, false, false, err
	}
	v, ok := getKV(items, "context")
	if !ok {
		return raw, false, len(items) == 0, nil
	}
	ctx, err := parseObject(v)
	if err != nil {
		return nil, false, false, err
	}
	fv, ok := getKV(ctx, "fileName")
	if !ok {
		return raw, false, false, nil
	}
	names, err := fileNames(fv)
	if err != nil {
		return nil, false, false, err
	}
	kept := names[:0:0]
	for _, n := range names {
		if n != geminiLocalName {
			kept = append(kept, n)
		}
	}
	if len(kept) == len(names) {
		return raw, false, false, nil
	}
	// Chỉ còn mặc định GEMINI.md là cái app đã thêm vào cùng, nên bỏ cả khoá.
	if len(kept) == 0 || len(kept) == 1 && kept[0] == "GEMINI.md" {
		ctx = delKV(ctx, "fileName")
	} else {
		val, _ := json.Marshal(kept)
		ctx = setKV(ctx, "fileName", val)
	}
	if len(ctx) == 0 {
		items = delKV(items, "context")
	} else {
		items = setKV(items, "context", compactObject(ctx))
	}
	return renderObject(items), true, len(items) == 0, nil
}
