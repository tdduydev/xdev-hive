package branches

import (
	"context"
	"strconv"
	"strings"
)

// Loại bằng chứng (Evidence.kind).
const (
	EvidenceMergedGit = "mergedGit"
	EvidenceMergedAPI = "mergedApi"
	EvidenceClosedAPI = "closedApi"
	EvidenceNone      = "none"
)

// Lý do không có bằng chứng (Evidence.note của kind none).
const (
	NoteNotMerged       = "notMerged"
	NoteNoOwnCommits    = "noOwnCommits"
	NoteOlderThanWindow = "olderThanWindow"
	NoteNoDefaultBranch = "noDefaultBranch"
	NotePROpen          = "prOpen"
)

// Evidence là bằng chứng nhánh đã vào nhánh mặc định (plan.md mục 5 bước 4, mục 7).
type Evidence struct {
	Kind     string `json:"kind"`
	Onto     string `json:"onto,omitempty"`
	Provider string `json:"provider,omitempty"`
	Number   int    `json:"number,omitempty"`
	URL      string `json:"url,omitempty"`
	Note     string `json:"note,omitempty"`
}

// firstParentWindow là số commit first-parent của nhánh mặc định được đọc (plan.md mục 5 bước 4): đủ cho vài năm
// merge, mà rev-list vẫn nhanh trên repo lớn. Là biến để test thu nhỏ cửa sổ thay vì dựng 5000 commit.
var firstParentWindow = 5000

// tipEvidence là bằng chứng git của một đỉnh, kèm inDefault (đỉnh là tổ tiên của nhánh mặc định) mà FR-027 cần cả khi
// không có bằng chứng (nhánh chưa có commit riêng vẫn an toàn khi fetch lỗi).
type tipEvidence struct {
	Evidence
	inDefault bool
}

// GitEvidence đọc bằng chứng git cho các đỉnh nhánh so với defaultRef (tên ref đầy đủ, vd. refs/remotes/origin/main).
// tips là mã đầy đủ; không nhận tên nhánh vì tên ngắn trỏ vào tag cùng tên trước nhánh (FR-021).
func GitEvidence(ctx context.Context, env Env, folder, defaultRef string, tips []string) (map[string]Evidence, *Error) {
	all, err := env.gitEvidence(ctx, folder, defaultRef, tips)
	if err != nil {
		return nil, gitFailure(err)
	}
	out := make(map[string]Evidence, len(all))
	for tip, ev := range all {
		out[tip] = ev.Evidence
	}
	return out, nil
}

// gitEvidence xếp từng đỉnh T theo plan.md mục 5 bước 4:
//   - T không là tổ tiên của nhánh mặc định: chưa vào;
//   - T nằm trên chuỗi first-parent: nhánh chưa có commit riêng hay merge tiến nhanh, không phân biệt được với nhánh mới
//     tạo nên không coi là bằng chứng;
//   - T là tổ tiên của commit cũ nhất trong cửa sổ: cũ hơn cửa sổ, không biết vào bằng merge commit hay tiến nhanh;
//   - còn lại: vào qua merge commit.
func (e Env) gitEvidence(ctx context.Context, dir, defaultRef string, tips []string) (map[string]tipEvidence, error) {
	out := make(map[string]tipEvidence, len(tips))
	if defaultRef == "" {
		for _, t := range tips {
			out[t] = tipEvidence{Evidence: Evidence{Kind: EvidenceNone, Note: NoteNoDefaultBranch}}
		}
		return out, nil
	}
	if len(tips) == 0 {
		return out, nil
	}
	fpOut, err := e.read(ctx, dir, "rev-list", "--first-parent", "--max-count="+strconv.Itoa(firstParentWindow),
		"--end-of-options", defaultRef, "--")
	if err != nil {
		return nil, err
	}
	fp := map[string]bool{}
	oldest := ""
	lines := 0
	for l := range strings.SplitSeq(fpOut, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			fp[l] = true
			oldest = l
			lines++
		}
	}
	inDefault, err := e.ancestors(ctx, dir, defaultRef, tips)
	if err != nil {
		return nil, err
	}
	// Cửa sổ chưa đầy là đã đọc hết lịch sử first-parent: không có commit nào cũ hơn cửa sổ.
	var old map[string]bool
	if lines >= firstParentWindow {
		var merged []string
		for _, t := range tips {
			if inDefault[t] && !fp[t] {
				merged = append(merged, t)
			}
		}
		if old, err = e.ancestors(ctx, dir, oldest, merged); err != nil {
			return nil, err
		}
	}
	onto := shortRef(defaultRef)
	for _, t := range tips {
		ev := tipEvidence{inDefault: inDefault[t]}
		switch {
		case !inDefault[t]:
			ev.Evidence = Evidence{Kind: EvidenceNone, Note: NoteNotMerged}
		case fp[t]:
			ev.Evidence = Evidence{Kind: EvidenceNone, Note: NoteNoOwnCommits}
		case old[t]:
			ev.Evidence = Evidence{Kind: EvidenceNone, Note: NoteOlderThanWindow}
		default:
			ev.Evidence = Evidence{Kind: EvidenceMergedGit, Onto: onto}
		}
		out[t] = ev
	}
	return out, nil
}

// ancestors trả các đỉnh trong tips là tổ tiên của base (kể cả bằng base). Đỉnh của nhánh local xét chung bằng một
// lần for-each-ref --merged thay vì một tiến trình git mỗi nhánh (repo máy dev có cả trăm nhánh ai/*); đỉnh khác mới
// hỏi riêng.
func (e Env) ancestors(ctx context.Context, dir, base string, tips []string) (map[string]bool, error) {
	out := map[string]bool{}
	if len(tips) == 0 {
		return out, nil
	}
	heads, err := e.read(ctx, dir, "for-each-ref", "--format=%(objectname)", "refs/heads")
	if err != nil {
		return nil, err
	}
	merged, err := e.read(ctx, dir, "for-each-ref", "--merged="+base, "--format=%(objectname)", "refs/heads")
	if err != nil {
		return nil, err
	}
	isHead, isMerged := lineSet(heads), lineSet(merged)
	for _, t := range tips {
		switch {
		case isMerged[t]:
			out[t] = true
		case isHead[t]:
			out[t] = false
		default:
			// rev-list đếm commit của T không có trong base: 0 là tổ tiên. merge-base --is-ancestor trả mã 1 không kèm
			// stderr, không phân biệt được với lỗi thật qua gitexec.
			n, err := e.read(ctx, dir, "rev-list", "--count", "--end-of-options", t, "^"+base, "--")
			if err != nil {
				return nil, err
			}
			out[t] = strings.TrimSpace(n) == "0"
		}
	}
	return out, nil
}

func lineSet(s string) map[string]bool {
	m := map[string]bool{}
	for l := range strings.SplitSeq(s, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			m[l] = true
		}
	}
	return m
}
