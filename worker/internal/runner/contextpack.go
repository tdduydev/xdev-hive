package runner

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
)

// Context pack: worker dựng sẵn danh sách file liên quan tới task trước khi chạy CLI. Số đo trên máy dev: 73% chi phí
// run worker nằm trước lần sửa file đầu, trung bình ~13 lệnh Bash dò repo; model hầu như không tự gọi tool tìm theo
// ngữ nghĩa (arXiv 2608.13568), nên kết quả phải được tiêm sẵn vào ngữ cảnh thay vì chỉ cài tool.
const (
	// contextPackTimeout: dựng pack chỉ để tiết kiệm, không được làm run chậm đáng kể; quá giờ thì chạy không có pack.
	contextPackTimeout = 20 * time.Second
	// contextPackMaxChars ~4k token (code và đường dẫn ~3,5 ký tự một token).
	contextPackMaxChars = 14000
	contextPackMaxFiles = 18
	// packMinScore: file chỉ khớp một từ khoá phổ biến không đáng đưa vào ngữ cảnh.
	packMinScore = 1.5
	// packHistory là số commit gần nhất đọc để tìm file hay đổi cùng nhau; commit đổi quá packBulkCommit file (đổi tên
	// hàng loạt, format) không nói gì về liên quan.
	packHistory     = 300
	packBulkCommit  = 40
	packMaxTerms    = 12
	packSigsPerFile = 6
	// packFileReadMax: chỉ đọc đầu file lớn để rút khai báo.
	packFileReadMax = 512 << 10
)

// contextPack là kết quả dựng; Text rỗng là không có gì đáng tiêm.
type contextPack struct {
	Files []packFile
	Text  string
}

type packFile struct {
	Path    string
	Score   float64
	Reasons []string
	Sigs    []packSig
}

type packSig struct {
	Line int
	Text string
}

// packTerms là từ khoá rút từ task: đường dẫn, symbol (camelCase, snake_case, trong `...`) và từ thường.
type packTerms struct {
	Paths    []string
	Symbols  []string
	Keywords []string
}

var (
	packPathRe   = regexp.MustCompile(`(?:[A-Za-z0-9_.@-]+/)+[A-Za-z0-9_.@\[\]-]*|[A-Za-z0-9_-]+\.(?:go|ts|tsx|js|jsx|mjs|cjs|py|rs|java|kt|rb|php|cs|c|h|cc|cpp|hpp|swift|sql|md|json|ya?ml|toml|sh|css|scss|html|vue|svelte)\b`)
	packTickRe   = regexp.MustCompile("`([^`\n]{2,80})`")
	packIdentRe  = regexp.MustCompile(`[A-Za-z_][A-Za-z0-9_]*`)
	packCamelRe  = regexp.MustCompile(`[a-z0-9][A-Z]|[A-Z]{2}[a-z]`)
	packURLRe    = regexp.MustCompile(`https?://\S+`)
	packStopword = map[string]bool{}
)

func init() {
	// Từ tiếng Anh thường gặp trong mô tả task và từ tiếng Việt viết không dấu trùng chữ ASCII: grep chúng chỉ ra nhiễu.
	for _, w := range strings.Fields(`the this that these those with without from into onto when then than there their
		what which while where will would should could have has had been being make made makes using used uses use
		also only just more most some such each other about after before over under again further once here very
		can cannot must need needs add adds added update updates updated change changes changed remove removes fix fixes
		fixed file files code test tests new old run runs task tasks page show shows like line lines text value values
		data type types true false null none true todo note docs doc main branch commit push pull merge review
		plan step steps item items list user users thing work works done same make sure into chay dung trong khong nhung
		theo cung neu thi nhu phai duoc hoac hien them trang lenh viec nay khi dang muon sau truoc tren duoi giua noi
		phan cach mot hai cac nhieu luon chua xong`) {
		packStopword[w] = true
	}
}

// extractPackTerms rút từ khoá từ tiêu đề, mô tả và kế hoạch của task. Chữ có dấu tiếng Việt không bao giờ là tên
// trong code nên chỉ lấy từ ASCII.
func extractPackTerms(text string) packTerms {
	text = packURLRe.ReplaceAllString(text, " ")
	var t packTerms
	seen := map[string]bool{}
	add := func(list *[]string, s string) {
		k := strings.ToLower(s)
		if s == "" || seen[k] {
			return
		}
		seen[k] = true
		*list = append(*list, s)
	}
	for _, p := range packPathRe.FindAllString(text, -1) {
		p = strings.Trim(strings.TrimPrefix(p, "./"), "/.")
		if p == "" || strings.Contains(p, "..") || len(p) < 3 {
			continue
		}
		add(&t.Paths, p)
	}
	ticked := map[string]bool{}
	for _, m := range packTickRe.FindAllStringSubmatch(text, -1) {
		for _, id := range packIdentRe.FindAllString(m[1], -1) {
			ticked[id] = true
		}
	}
	rest := packPathRe.ReplaceAllString(text, " ")
	for _, id := range packIdentRe.FindAllString(rest, -1) {
		if len(id) < 4 || packStopword[strings.ToLower(id)] {
			continue
		}
		if ticked[id] || strings.Contains(strings.Trim(id, "_"), "_") || packCamelRe.MatchString(id) {
			add(&t.Symbols, id)
		}
	}
	for _, id := range packIdentRe.FindAllString(rest, -1) {
		if len(id) < 4 || packStopword[strings.ToLower(id)] || !isASCIIWord(id) {
			continue
		}
		k := strings.ToLower(id)
		// "setting" và "settings" khớp cùng file; giữ một.
		if seen[strings.TrimSuffix(k, "s")] || seen[k+"s"] {
			continue
		}
		add(&t.Keywords, k)
	}
	// Từ dài thường đặc trưng hơn; giữ thứ tự xuất hiện khi bằng nhau.
	sort.SliceStable(t.Keywords, func(i, j int) bool { return len(t.Keywords[i]) > len(t.Keywords[j]) })
	return t
}

func isASCIIWord(s string) bool {
	for _, r := range s {
		if r > unicode.MaxASCII {
			return false
		}
	}
	return true
}

// packNoisy là file sinh ra hoặc dữ liệu: khớp từ khoá nào cũng có nhưng agent không cần đọc.
func packNoisy(p string) bool {
	base := path.Base(p)
	switch base {
	case "go.sum", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "bun.lockb", "poetry.lock", "openapi.json":
		return true
	}
	for _, s := range []string{".min.js", ".min.css", ".map", ".snap", ".svg", ".png", ".jpg", ".ico", ".lock", ".pb.go", "_snapshot.json"} {
		if strings.HasSuffix(base, s) {
			return true
		}
	}
	for _, d := range []string{"vendor/", "node_modules/", "dist/", "/meta/", "testdata/", "fixtures/"} {
		if strings.HasPrefix(p, d) || strings.Contains(p, "/"+d) {
			return true
		}
	}
	return false
}

// packScorer cộng điểm cho file theo từng tín hiệu và giữ lý do để agent biết vì sao file có mặt.
type packScorer struct {
	files  []string
	set    map[string]bool
	score  map[string]float64
	reason map[string][]string
}

func (s *packScorer) add(f string, w float64, why string) {
	if !s.set[f] || w <= 0 {
		return
	}
	s.score[f] += w
	for _, r := range s.reason[f] {
		if r == why {
			return
		}
	}
	if len(s.reason[f]) < 3 {
		s.reason[f] = append(s.reason[f], why)
	}
}

// buildContextPack dựng pack cho worktree work. query là tiêu đề + mô tả (+ kế hoạch) của task; codegraph là file chạy
// codegraph đã dựng chỉ mục cho worktree (rỗng là không có); commands là mục lệnh build/test đã rút (rỗng là bỏ).
func buildContextPack(ctx context.Context, work, query, codegraph string, commands []string) (*contextPack, error) {
	terms := extractPackTerms(query)
	if len(terms.Paths)+len(terms.Symbols)+len(terms.Keywords) == 0 {
		return &contextPack{}, nil
	}
	out, err := gitOutput(ctx, work, "ls-files", "-z")
	if err != nil {
		return nil, err
	}
	s := &packScorer{set: map[string]bool{}, score: map[string]float64{}, reason: map[string][]string{}}
	for _, f := range strings.Split(out, "\x00") {
		if f != "" && !packNoisy(f) {
			s.files = append(s.files, f)
			s.set[f] = true
		}
	}
	if len(s.files) == 0 {
		return &contextPack{}, nil
	}
	scoreMentions(s, terms)
	scoreGrep(ctx, s, work, terms)
	if codegraph != "" {
		scoreCodeGraph(ctx, s, work, codegraph, terms)
	}
	scoreCoChange(ctx, s, work)
	ranked := rankPack(s)
	for i := range ranked {
		ranked[i].Sigs = fileSignatures(filepath.Join(work, filepath.FromSlash(ranked[i].Path)), terms)
	}
	text, kept := renderPack(ranked, commands, contextPackMaxChars)
	return &contextPack{Files: ranked[:kept], Text: text}, nil
}

// scoreMentions: đường dẫn nhắc thẳng trong task là tín hiệu mạnh nhất; tên file trùng symbol hay từ khoá cũng vậy.
func scoreMentions(s *packScorer, t packTerms) {
	for _, p := range t.Paths {
		if s.set[p] {
			s.add(p, 10, "nhắc trong task")
			continue
		}
		var under []string
		for _, f := range s.files {
			if strings.HasSuffix(f, "/"+p) {
				s.add(f, 8, "nhắc trong task")
			} else if strings.HasPrefix(f, p+"/") || strings.Contains(f, "/"+p+"/") {
				under = append(under, f)
			}
		}
		// Thư mục lớn: chia điểm để thư mục không lấn át file khớp từ khoá.
		for _, f := range under {
			s.add(f, math.Max(0.5, 3/math.Sqrt(float64(len(under)))), "trong "+p+"/")
		}
	}
	names := append(append([]string(nil), t.Symbols...), t.Keywords...)
	for _, f := range s.files {
		stem := strings.ToLower(strings.TrimSuffix(path.Base(f), path.Ext(f)))
		stem = strings.TrimSuffix(strings.TrimSuffix(stem, "_test"), ".test")
		flat := strings.NewReplacer("-", "", "_", "", ".", "").Replace(stem)
		for _, n := range names {
			n = strings.ToLower(n)
			if flat == strings.NewReplacer("-", "", "_", "").Replace(n) || len(n) >= 5 && strings.Contains(stem, n) {
				s.add(f, 3, "tên file khớp `"+n+"`")
			}
		}
	}
}

// scoreGrep tìm file chứa từ khoá bằng git grep (có sẵn ở mọi máy có git, kể cả Windows; chỉ file đã theo dõi). Từ
// khớp quá nhiều file gần như không phân biệt được nên nhận ít điểm, quá 20% repo thì bỏ.
func scoreGrep(ctx context.Context, s *packScorer, work string, t packTerms) {
	type term struct {
		word   string
		symbol bool
	}
	var list []term
	for _, w := range t.Symbols {
		list = append(list, term{w, true})
	}
	for _, w := range t.Keywords {
		list = append(list, term{w, false})
	}
	if len(list) > packMaxTerms {
		list = list[:packMaxTerms]
	}
	limit := max(30, len(s.files)/5)
	for _, tm := range list {
		args := []string{"grep", "-l", "-z", "-I", "-F", "-w", "--no-color"}
		if !tm.symbol {
			args = append(args, "-i")
		}
		out, err := gitOutput(ctx, work, append(args, "-e", tm.word)...)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			continue
		}
		var hits []string
		for _, f := range strings.Split(out, "\x00") {
			if f = strings.TrimSpace(f); s.set[f] {
				hits = append(hits, f)
			}
		}
		if len(hits) == 0 || len(hits) > limit {
			continue
		}
		// Symbol chỉ có ở một file gần như chắc chắn là chỗ cần sửa (đủ làm gốc cho file đổi cùng); từ thường yếu hơn.
		w := 3.0
		if tm.symbol {
			w = 6
		}
		w /= math.Log2(1 + float64(len(hits)))
		for _, f := range hits {
			s.add(f, w, "chứa `"+tm.word+"`")
		}
	}
}

// scoreCodeGraph hỏi chỉ mục CodeGraph (`codegraph query <symbol> --json`). Không đọc được kết quả thì thôi: pack vẫn
// có các tín hiệu khác.
func scoreCodeGraph(ctx context.Context, s *packScorer, work, bin string, t packTerms) {
	terms := t.Symbols
	if len(terms) > 4 {
		terms = terms[:4]
	}
	for _, term := range terms {
		cmd := exec.CommandContext(ctx, bin, "query", term, "--limit", "10", "--json")
		cmd.Dir = work
		cmd.Env = mergeEnv(os.Environ(), codegraphEnv)
		out, err := cmd.Output()
		if err != nil {
			continue
		}
		var v any
		if json.Unmarshal(out, &v) != nil {
			continue
		}
		for _, p := range jsonPaths(v, nil) {
			if filepath.IsAbs(p) {
				rel, err := filepath.Rel(work, p)
				if err != nil {
					continue
				}
				p = rel
			}
			s.add(filepath.ToSlash(p), 2.5, "codegraph: `"+term+"`")
		}
	}
}

// jsonPaths gom giá trị chuỗi của các khoá trông như đường dẫn file trong JSON của CodeGraph (định dạng chưa cố định).
func jsonPaths(v any, out []string) []string {
	switch x := v.(type) {
	case map[string]any:
		for k, val := range x {
			if str, ok := val.(string); ok {
				switch strings.ToLower(k) {
				case "file", "filepath", "file_path", "path", "relativepath":
					out = append(out, str)
				}
				continue
			}
			out = jsonPaths(val, out)
		}
	case []any:
		for _, val := range x {
			out = jsonPaths(val, out)
		}
	}
	return out
}

// scoreCoChange: file hay được sửa cùng commit với các file dẫn đầu thường phải sửa theo (test, schema, contract).
func scoreCoChange(ctx context.Context, s *packScorer, work string) {
	var seeds []string
	for _, f := range topFiles(s, 5) {
		if s.score[f] >= 3 {
			seeds = append(seeds, f)
		}
	}
	if len(seeds) == 0 {
		return
	}
	out, err := gitOutput(ctx, work, "-c", "core.quotepath=off", "log", "-n", fmt.Sprint(packHistory), "--no-merges", "--name-only", "--format=%x00")
	if err != nil {
		return
	}
	var commits [][]string
	for _, block := range strings.Split(out, "\x00") {
		var files []string
		for _, f := range strings.Split(block, "\n") {
			if f = strings.TrimSpace(f); f != "" {
				files = append(files, f)
			}
		}
		if len(files) > 1 && len(files) <= packBulkCommit {
			commits = append(commits, files)
		}
	}
	for _, seed := range seeds {
		together := map[string]int{}
		n := 0
		for _, c := range commits {
			if !containsString(c, seed) {
				continue
			}
			n++
			for _, f := range c {
				if f != seed {
					together[f]++
				}
			}
		}
		for f, c := range together {
			// Một lần đổi cùng trong lịch sử dài là ngẫu nhiên; cần lặp lại hoặc lịch sử của seed ngắn.
			if c >= 2 || n <= 2 {
				s.add(f, 4*float64(c)/float64(n+1), "hay đổi cùng "+path.Base(seed))
			}
		}
	}
}

func containsString(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func topFiles(s *packScorer, n int) []string {
	var list []string
	for f := range s.score {
		list = append(list, f)
	}
	sort.Slice(list, func(i, j int) bool {
		if s.score[list[i]] != s.score[list[j]] {
			return s.score[list[i]] > s.score[list[j]]
		}
		return list[i] < list[j]
	})
	if len(list) > n {
		list = list[:n]
	}
	return list
}

func rankPack(s *packScorer) []packFile {
	var out []packFile
	for _, f := range topFiles(s, contextPackMaxFiles) {
		if s.score[f] < packMinScore {
			break
		}
		out = append(out, packFile{Path: f, Score: s.score[f], Reasons: s.reason[f]})
	}
	return out
}

// Khai báo chính theo đuôi file. Không có tree-sitter trong module Go của worker, nên dùng regex theo dòng: đủ cho
// khai báo cấp đầu file, là phần agent cần để chọn đoạn đọc.
var packSigRes = map[string]*regexp.Regexp{
	".go":    regexp.MustCompile(`^(func|type)\s`),
	".ts":    regexp.MustCompile(`^export\s+(default\s+)?(declare\s+)?(async\s+)?(function|class|const|let|interface|type|enum|abstract\s+class)\b`),
	".py":    regexp.MustCompile(`^(async\s+)?(def|class)\s`),
	".rs":    regexp.MustCompile(`^\s*(pub(\([a-z]+\))?\s+)?(async\s+)?(fn|struct|enum|trait|impl|mod)\b`),
	".java":  regexp.MustCompile(`^\s*(public|protected|internal|open)\s+[^=;]*(class|interface|enum|record|fun|\()`),
	".rb":    regexp.MustCompile(`^\s*(def|class|module)\s`),
	".php":   regexp.MustCompile(`^\s*((public|protected|private|static|abstract|final)\s+)*(function|class|interface|trait)\s`),
	".swift": regexp.MustCompile(`^\s*((public|open|internal)\s+)?(func|class|struct|enum|protocol|extension)\s`),
	".sql":   regexp.MustCompile(`(?i)^\s*(create|alter)\s`),
	".md":    regexp.MustCompile(`^#{1,3}\s`),
}

func sigRe(p string) *regexp.Regexp {
	switch ext := strings.ToLower(filepath.Ext(p)); ext {
	case ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte":
		return packSigRes[".ts"]
	case ".kt", ".cs":
		return packSigRes[".java"]
	default:
		return packSigRes[ext]
	}
}

// fileSignatures lấy tối đa packSigsPerFile khai báo, ưu tiên dòng chứa từ khoá của task, giữ thứ tự trong file.
func fileSignatures(file string, t packTerms) []packSig {
	re := sigRe(file)
	if re == nil {
		return nil
	}
	f, err := os.Open(file)
	if err != nil {
		return nil
	}
	defer f.Close()
	words := append(append([]string(nil), t.Symbols...), t.Keywords...)
	var hit, other []packSig
	sc := bufio.NewScanner(io.LimitReader(f, packFileReadMax))
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for n := 1; sc.Scan(); n++ {
		line := sc.Text()
		if !re.MatchString(line) {
			continue
		}
		text := strings.TrimSpace(strings.TrimRight(strings.TrimSpace(line), "{"))
		if len(text) > 140 {
			text = text[:137] + "…"
		}
		sig := packSig{Line: n, Text: text}
		lower := strings.ToLower(line)
		matched := false
		for _, w := range words {
			if strings.Contains(lower, strings.ToLower(w)) {
				matched = true
				break
			}
		}
		if matched {
			hit = append(hit, sig)
		} else {
			other = append(other, sig)
		}
	}
	out := hit
	if len(out) > packSigsPerFile {
		out = out[:packSigsPerFile]
	}
	for _, s := range other {
		if len(out) >= packSigsPerFile {
			break
		}
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Line < out[j].Line })
	return out
}

// renderPack viết pack trong giới hạn maxChars: bỏ khai báo của file cuối bảng trước, rồi mới bỏ file. Trả văn bản và
// số file giữ lại.
func renderPack(files []packFile, commands []string, maxChars int) (string, int) {
	if len(files) == 0 {
		return "", 0
	}
	head := "# Context pack của run\n\n" +
		"Worker xDev Hive dựng sẵn danh sách file có thể liên quan tới task, xếp theo mức liên quan (đường dẫn và symbol " +
		"nhắc trong task, file hay đổi cùng trong git log, tìm theo từ khoá). Đọc các file này trước, theo đoạn quanh " +
		"các dòng ghi bên dưới; cần thêm thì tìm trong thư mục cụ thể thay vì dò cả repo. Danh sách có thể thiếu hoặc thừa.\n\n## File\n"
	var cmds string
	if len(commands) > 0 {
		cmds = "\n## Lệnh build/test\n"
		for _, c := range commands {
			cmds += "- `" + c + "`\n"
		}
	}
	sigs := make([]int, len(files))
	for i := range files {
		sigs[i] = len(files[i].Sigs)
	}
	n := len(files)
	for {
		var b strings.Builder
		b.WriteString(head)
		for i := 0; i < n; i++ {
			f := files[i]
			fmt.Fprintf(&b, "- `%s`", f.Path)
			if len(f.Reasons) > 0 {
				b.WriteString(" — " + strings.Join(f.Reasons, "; "))
			}
			b.WriteString("\n")
			for _, s := range f.Sigs[:sigs[i]] {
				fmt.Fprintf(&b, "  - L%d `%s`\n", s.Line, strings.ReplaceAll(s.Text, "`", "'"))
			}
		}
		b.WriteString(cmds)
		if b.Len() <= maxChars || n == 1 {
			return b.String(), n
		}
		// Cắt khai báo của file xếp sau cùng còn khai báo, hết thì bỏ file cuối.
		cut := false
		for i := n - 1; i >= 0; i-- {
			if sigs[i] > 0 {
				sigs[i] = 0
				cut = true
				break
			}
		}
		if !cut {
			n--
		}
	}
}

// buildCommands rút lệnh build/test từ file cấu hình ở gốc repo, chỉ dùng khi dự án chưa có brief (brief đã nằm trong
// prompt và có mục lệnh riêng, lặp lại chỉ tốn token).
func buildCommands(work string) []string {
	var out []string
	if b, err := os.ReadFile(filepath.Join(work, "package.json")); err == nil {
		var pkg struct {
			Scripts map[string]string `json:"scripts"`
		}
		if json.Unmarshal(b, &pkg) == nil {
			pm := "npm run"
			switch {
			case fileExists(filepath.Join(work, "pnpm-lock.yaml")):
				pm = "pnpm"
			case fileExists(filepath.Join(work, "yarn.lock")):
				pm = "yarn"
			case fileExists(filepath.Join(work, "bun.lockb")), fileExists(filepath.Join(work, "bun.lock")):
				pm = "bun run"
			}
			for _, k := range []string{"check", "lint", "typecheck", "test", "build"} {
				if _, ok := pkg.Scripts[k]; ok {
					out = append(out, pm+" "+k)
				}
			}
		}
	}
	if fileExists(filepath.Join(work, "go.mod")) {
		out = append(out, "gofmt -l .", "go vet ./...", "go test ./...")
	}
	if fileExists(filepath.Join(work, "Cargo.toml")) {
		out = append(out, "cargo test")
	}
	if fileExists(filepath.Join(work, "pyproject.toml")) {
		out = append(out, "pytest")
	}
	if b, err := os.ReadFile(filepath.Join(work, "Makefile")); err == nil {
		for _, k := range []string{"check", "lint", "test", "build"} {
			if regexp.MustCompile(`(?m)^` + k + `\s*:`).Match(b) {
				out = append(out, "make "+k)
			}
		}
	}
	return out
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// packQuery là phần task trong prompt: hub mới gửi spec.taskText; hub cũ thì lấy phần sau dải "---" cuối mà hub đặt
// giữa brief và nội dung task.
func packQuery(job Job) string {
	if job.TaskText != "" {
		return job.TaskText
	}
	if i := strings.LastIndex(job.Prompt, "\n---\n"); i >= 0 {
		return job.Prompt[i+5:]
	}
	return job.Prompt
}
