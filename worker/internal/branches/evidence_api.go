package branches

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/gitexec"
	"github.com/tdduydev/xdev-hive/worker/internal/gitgroups"
)

// apiTimeout giới hạn cả lượt đọc PR/MR của một repo: máy chủ chậm không được ăn hết thời gian của bước đọc repo,
// vì lỗi API chỉ làm mất bằng chứng API chứ không làm hỏng lượt quét.
const apiTimeout = 30 * time.Second

// apiSource là bằng chứng GitHub/GitLab của một lượt quét (plan.md mục 7, FR-030): kết nối Git tại máy của spec 016
// (gitgroups.json cạnh worker.json) và token app đưa qua HIVE_GIT_TOKENS, chỉ cho host trùng origin của repo quét.
type apiSource struct {
	hosts   []gitgroups.Host
	tokens  map[string]string
	loadErr string

	mu sync.Mutex
	// hostMu tuần tự lời gọi của cùng một kết nối: repo quét song song mà token sai thì chỉ một lời gọi nhận 401.
	hostMu map[string]*sync.Mutex
	// authErr là lỗi 401/403 đã gặp trong lượt: GitLab khoá IP khi sai liên tiếp nên không gọi lại (plan.md mục 7).
	authErr map[string]string
}

// loadAPI đọc nguồn bằng chứng API một lần cho cả lượt quét. Không có token thì trả nil: app chỉ đưa token cho host
// trùng origin, thiếu token là người dùng không có kết nối dùng được và quét chỉ dùng bằng chứng git.
func (e Env) loadAPI() *apiSource {
	raw := strings.TrimSpace(os.Getenv(gitexec.TokensEnv))
	if raw == "" {
		return nil
	}
	a := &apiSource{hostMu: map[string]*sync.Mutex{}, authErr: map[string]string{}}
	if err := json.Unmarshal([]byte(raw), &a.tokens); err != nil {
		// Không đưa lỗi của json ra: thông báo có thể trích một đoạn của biến.
		a.loadErr = "biến HIVE_GIT_TOKENS không phải JSON {id: token}"
		return a
	}
	c, err := gitgroups.Load(gitgroups.DefaultPath(filepath.Join(e.ConfigDir, "worker.json")))
	if err != nil {
		a.loadErr = err.Error()
		return a
	}
	a.hosts = c.Hosts
	return a
}

// apiRepo là repo trên máy chủ ứng với origin của thư mục quét.
type apiRepo struct {
	host  gitgroups.Host
	token string
	path  string
}

// match tìm kết nối có token cùng host với origin (chỉ so host, không so cổng, như matching_hosts của Rust) và đường
// dẫn repo trên máy chủ.
func (a *apiSource) match(origin string) (apiRepo, bool) {
	host, p := remoteHostPath(origin)
	if host == "" || p == "" {
		return apiRepo{}, false
	}
	for _, h := range a.hosts {
		tok := a.tokens[h.ID]
		u, err := url.Parse(h.URL)
		if tok == "" || err != nil || !strings.EqualFold(u.Hostname(), host) {
			continue
		}
		// GitLab cài dưới đường dẫn con (https://example.invalid/gitlab): URL HTTPS của repo có đoạn đó, API thì không.
		if prefix := strings.Trim(u.Path, "/"); prefix != "" && len(p) > len(prefix) &&
			strings.EqualFold(p[:len(prefix)+1], prefix+"/") {
			p = p[len(prefix)+1:]
		}
		return apiRepo{host: h, token: tok, path: p}, true
	}
	return apiRepo{}, false
}

// remoteHostPath tách host (chữ thường, không cổng) và đường dẫn repo (giữ hoa thường, bỏ .git) của URL remote:
// https://…, ssh://… hay dạng scp git@host:đường/dẫn. Đường dẫn trên máy thì không có host.
func remoteHostPath(remote string) (string, string) {
	s := strings.TrimSpace(remote)
	var host, p string
	if strings.Contains(s, "://") {
		u, err := url.Parse(s)
		if err != nil || u.Scheme == "file" {
			return "", ""
		}
		host, p = u.Hostname(), u.Path
	} else {
		// "C:\..." của Windows là đường dẫn, không phải máy chủ một chữ.
		i := strings.Index(s, ":")
		if i <= 1 || strings.ContainsAny(s[:i], `/\`) {
			return "", ""
		}
		host, p = s[:i], s[i+1:]
		if at := strings.LastIndex(host, "@"); at >= 0 {
			host = host[at+1:]
		}
	}
	p = strings.TrimSuffix(strings.Trim(p, "/"), ".git")
	return strings.ToLower(host), p
}

// lock giữ khoá của một kết nối, trả hàm mở khoá.
func (a *apiSource) lock(id string) func() {
	a.mu.Lock()
	m := a.hostMu[id]
	if m == nil {
		m = &sync.Mutex{}
		a.hostMu[id] = m
	}
	a.mu.Unlock()
	m.Lock()
	return m.Unlock
}

// list đọc PR/MR của repo, trả lỗi đã viết cho người dùng. Lỗi xác thực ghi lại để repo sau cùng kết nối không gọi
// nữa.
func (a *apiSource) list(ctx context.Context, r apiRepo) ([]gitgroups.PullRequest, string) {
	defer a.lock(r.host.ID)()
	if msg, ok := a.authErr[r.host.ID]; ok {
		return nil, msg
	}
	c := gitgroups.Client{Host: r.host, Token: r.token}
	var prs []gitgroups.PullRequest
	var err error
	if r.host.Kind == gitgroups.KindGitHub {
		prs, err = c.ListPulls(ctx, r.path)
	} else {
		prs, err = c.ListMergeRequests(ctx, r.path)
	}
	if err == nil {
		return prs, ""
	}
	// Lỗi mạng của net/http có URL, không có header; vẫn che token phòng máy chủ lạ đưa token vào thông báo.
	msg := strings.ReplaceAll(err.Error(), r.token, "***")
	var api *gitgroups.APIError
	if errors.As(err, &api) && (api.Status == http.StatusUnauthorized || api.Status == http.StatusForbidden) {
		a.authErr[r.host.ID] = msg
	}
	return nil, msg
}

// apiEvidence điền bằng chứng API cho các nhánh chưa có bằng chứng git (plan.md mục 7), lấy PR/MR cập nhật mới nhất
// của từng nhánh. Nhánh có PR mới nhất đang mở bị đánh dấu prOpen kể cả khi đã có bằng chứng git (FR-020). Trả câu lỗi
// cho ScanRepo.apiError; lỗi API không làm hỏng lượt quét, repo dùng bằng chứng git.
func (e Env) apiEvidence(ctx context.Context, a *apiSource, folder string, items []*scanItem, progress Emit) string {
	need := false
	for _, it := range items {
		if it.ev.Kind == EvidenceNone {
			need = true
		}
	}
	if a == nil || !need {
		return ""
	}
	if a.loadErr != "" {
		return apiErrorText(a.loadErr)
	}
	origin, _ := e.read(ctx, folder, "config", "--get", "remote.origin.url")
	r, ok := a.match(strings.TrimSpace(origin))
	if !ok {
		return ""
	}
	progress(Event{Type: EventProgress, Step: StepAPI})
	actx, cancel := context.WithTimeout(ctx, apiTimeout)
	prs, msg := a.list(actx, r)
	cancel()
	if msg != "" {
		return apiErrorText(msg)
	}
	latest := map[string]gitgroups.PullRequest{}
	for _, pr := range prs {
		// Máy chủ đã trả theo thời điểm cập nhật giảm dần; so lại để không phụ thuộc thứ tự đó.
		if cur, ok := latest[pr.Branch]; !ok || pr.UpdatedAt.After(cur.UpdatedAt) {
			latest[pr.Branch] = pr
		}
	}
	for _, it := range items {
		pr, ok := latest[it.branch.Name]
		if !ok {
			continue
		}
		ref := Evidence{Provider: r.host.Kind, Number: pr.Number, URL: pr.URL}
		if pr.State == gitgroups.PROpen {
			it.prOpen = prLabel(ref)
			if it.ev.Kind == EvidenceNone {
				ref.Kind, ref.Note = EvidenceNone, NotePROpen
				it.ev.Evidence = ref
			}
			continue
		}
		if it.ev.Kind != EvidenceNone {
			continue
		}
		switch pr.State {
		case gitgroups.PRMerged:
			// PR merge ở mã cũ hơn đỉnh hiện tại: commit sau đó chưa vào nhánh mặc định.
			if e.contains(ctx, folder, pr.HeadSHA, it.branch.Tip) {
				ref.Kind = EvidenceMergedAPI
				it.ev.Evidence = ref
			} else {
				ref.Kind, ref.Note = EvidenceNone, NoteNotMerged
				it.ev.Evidence = ref
				it.apiNote = prLabel(ref) + " đã merge nhưng nhánh có commit mới hơn."
				if pr.HeadSHA == "" {
					it.apiNote = prLabel(ref) + " đã merge nhưng máy chủ không trả mã đỉnh để đối chiếu."
				}
			}
		case gitgroups.PRClosed:
			// FR-026: chỉ nhận khi nhánh cùng tên trên origin còn giữ mọi commit của nhánh trên máy.
			if e.contains(ctx, folder, e.remoteTip(ctx, folder, "origin", it.branch.Name), it.branch.Tip) {
				ref.Kind = EvidenceClosedAPI
				it.ev.Evidence = ref
			} else {
				ref.Kind, ref.Note = EvidenceNone, NoteNotMerged
				it.ev.Evidence = ref
				it.apiNote = prLabel(ref) + " đã đóng không merge, nhánh trên origin không còn giữ các commit này."
			}
		}
	}
	return ""
}

func apiErrorText(reason string) string { return "Không đọc được PR/MR: " + reason }

func prLabel(ev Evidence) string {
	if ev.Provider == gitgroups.KindGitLab {
		return "MR !" + strconv.Itoa(ev.Number)
	}
	return "PR #" + strconv.Itoa(ev.Number)
}

// contains: tip bằng sha hoặc là tổ tiên của sha. sha lấy từ máy chủ hay ref remote, nên kiểm dạng mã và có trên máy
// trước khi đưa vào lệnh git; không kiểm được thì coi là không chứa.
func (e Env) contains(ctx context.Context, dir, sha, tip string) bool {
	if !isOID(sha) {
		return false
	}
	if sha == tip {
		return true
	}
	if _, err := e.read(ctx, dir, "cat-file", "-e", sha+"^{commit}"); err != nil {
		return false
	}
	anc, err := e.ancestors(ctx, dir, sha, []string{tip})
	return err == nil && anc[tip]
}

// remoteTip là mã của refs/remotes/<remote>/<nhánh> trên máy (đã fetch --prune trong lượt), rỗng khi không có.
// for-each-ref khớp mẫu theo cả thư mục con nên chỉ nhận dòng đúng tên.
func (e Env) remoteTip(ctx context.Context, dir, remote, branch string) string {
	ref := "refs/remotes/" + remote + "/" + branch
	out, err := e.read(ctx, dir, "for-each-ref", "--format=%(refname) %(objectname)", ref)
	if err != nil {
		return ""
	}
	for line := range strings.SplitSeq(out, "\n") {
		if name, sha, ok := strings.Cut(strings.TrimSpace(line), " "); ok && name == ref {
			return sha
		}
	}
	return ""
}
