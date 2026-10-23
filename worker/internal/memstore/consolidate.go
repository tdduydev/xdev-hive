package memstore

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// MergeProposal là một nhóm file chủ đề nói cùng chuyện, kèm bản gộp. Chưa ghi gì: app hiện diff rồi mới gọi `memory
// merge` cho từng nhóm (nguồn vào thùng rác, chỉ mục và liên kết được sửa theo).
type MergeProposal struct {
	Sources []string `json:"sources"`
	Target  string   `json:"target"`
	Reason  string   `json:"reason"`
	// Before là nội dung các nguồn nối lại, theo thứ tự Sources, để app so diff với Content.
	Before       string `json:"before"`
	Content      string `json:"content"`
	TokensBefore int    `json:"tokensBefore"`
	TokensAfter  int    `json:"tokensAfter"`
	NewLines     []int  `json:"newLines"`
}

type Consolidation struct {
	Merges     []MergeProposal `json:"merges"`
	TokensUsed int             `json:"tokensUsed"`
	Warnings   []string        `json:"warnings"`
}

// Consolidate nhờ Claude đánh giá các file memory của một thư mục và đề xuất nhóm nào nên gộp. Hints là các cặp file mà
// cờ trùng lặp đã thấy, đưa vào prompt làm gợi ý. Chạy chỉ đọc như Compress. MEMORY.md không bao giờ là nguồn hay đích:
// Merge tự sửa chỉ mục.
func Consolidate(ctx context.Context, opts CompressOptions, hints [][2]string) (Consolidation, error) {
	var files []string
	for _, p := range opts.Files {
		if filepath.Base(p) != "MEMORY.md" {
			files = append(files, p)
		}
	}
	if len(files) < 2 {
		return Consolidation{}, errors.New("cần ít nhất hai file chủ đề để gộp")
	}
	work, sources, err := stageFiles(files)
	if err != nil {
		return Consolidation{}, err
	}
	defer os.RemoveAll(work)
	names := map[string]string{}
	for _, s := range sources {
		names[s.path] = s.name
	}
	var hinted [][2]string
	for _, h := range hints {
		if names[h[0]] != "" && names[h[1]] != "" {
			hinted = append(hinted, [2]string{names[h[0]], names[h[1]]})
		}
	}
	result, used, err := askClaude(ctx, opts, work, consolidatePrompt(sourceNames(sources), hinted))
	if err != nil {
		return Consolidation{}, err
	}
	out := Consolidation{Merges: []MergeProposal{}, Warnings: []string{}, TokensUsed: used}
	var answer struct {
		Merges []struct {
			Sources []string `json:"sources"`
			Target  string   `json:"target"`
			Reason  string   `json:"reason"`
			Content string   `json:"content"`
		} `json:"merges"`
	}
	if err := json.Unmarshal([]byte(extractJSON(result)), &answer); err != nil {
		return out, errors.New("claude không trả về JSON đề xuất hợp lệ")
	}
	find := func(name string) *source {
		for i := range sources {
			if sources[i].name == name || sources[i].path == name {
				return &sources[i]
			}
		}
		return nil
	}
	// Một file chỉ được nằm trong một nhóm: gộp nhóm sau sẽ không còn thấy file mà nhóm trước đã chuyển vào thùng rác.
	taken := map[string]bool{}
	known := knownLines(sources)
	for _, m := range answer.Merges {
		var group []*source
		valid := true
		for _, name := range m.Sources {
			src := find(name)
			if src == nil || taken[src.path] {
				out.Warnings = append(out.Warnings, "Bỏ qua nhóm có file lạ hoặc đã thuộc nhóm khác: "+strings.Join(m.Sources, ", "))
				valid = false
				break
			}
			if !containsSource(group, src) {
				group = append(group, src)
			}
		}
		if !valid {
			continue
		}
		target := find(m.Target)
		switch {
		case len(group) < 2:
			out.Warnings = append(out.Warnings, "Bỏ qua nhóm chỉ có một file: "+strings.Join(m.Sources, ", "))
			continue
		case target == nil || !containsSource(group, target):
			// Đích là một trong các nguồn để giữ tên file và dòng chỉ mục đã có, không đẻ thêm file mới.
			out.Warnings = append(out.Warnings, "Bỏ qua nhóm có file đích không thuộc nhóm: "+m.Target)
			continue
		case strings.TrimSpace(m.Content) == "":
			out.Warnings = append(out.Warnings, "Bỏ qua nhóm có bản gộp rỗng: "+strings.Join(m.Sources, ", "))
			continue
		}
		p := MergeProposal{Target: target.path, Reason: strings.TrimSpace(m.Reason), Content: m.Content}
		var parts []string
		for _, src := range group {
			taken[src.path] = true
			p.Sources = append(p.Sources, src.path)
			parts = append(parts, src.content)
			p.TokensBefore += EstimateTokens(src.content)
		}
		p.Before = strings.Join(parts, "\n\n")
		p.TokensAfter = EstimateTokens(m.Content)
		p.NewLines = unsourcedLines(m.Content, known)
		out.Merges = append(out.Merges, p)
	}
	return out, nil
}

func containsSource(list []*source, s *source) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func consolidatePrompt(names []string, hints [][2]string) string {
	var b strings.Builder
	b.WriteString("Bạn đang dọn memory của một CLI lập trình: tìm các file chủ đề nói cùng một chuyện hoặc chồng lấn nhiều, rồi gộp mỗi nhóm thành một file.\n")
	b.WriteString("Các file nằm trong thư mục làm việc hiện tại, đọc bằng tool Read:\n")
	for _, n := range names {
		b.WriteString("- " + n + "\n")
	}
	if len(hints) > 0 {
		b.WriteString("\nCác cặp máy đoán là gần giống nhau (chỉ là gợi ý, tự đọc để đánh giá):\n")
		for _, h := range hints {
			b.WriteString("- " + h[0] + " ~ " + h[1] + "\n")
		}
	}
	b.WriteString("\nQuy tắc:\n")
	b.WriteString("- Chỉ gộp file thật sự cùng chủ đề. File khác chủ đề thì để nguyên, dù ngắn.\n")
	b.WriteString("- Bản gộp giữ mọi sự thật, quy ước và đường dẫn còn dùng được của các nguồn; bỏ ý lặp. Không bịa thêm ý mới.\n")
	b.WriteString("- Giữ ngôn ngữ, định dạng markdown và frontmatter (nếu có) của file đích; cập nhật description cho đúng nội dung gộp.\n")
	b.WriteString("- target phải là một trong sources. Mỗi file chỉ thuộc một nhóm. Không sửa file bằng tool, không chạy lệnh.\n")
	b.WriteString("- Không có gì đáng gộp thì trả {\"merges\":[]}.\n")
	b.WriteString("\nTrả lời DUY NHẤT một đối tượng JSON, không kèm giải thích:\n")
	b.WriteString(`{"merges":[{"sources":["<tên file>","<tên file>"],"target":"<một trong sources>","reason":"<vì sao gộp, một câu>","content":"<nội dung đầy đủ của file đích sau khi gộp>"}]}` + "\n")
	return b.String()
}
