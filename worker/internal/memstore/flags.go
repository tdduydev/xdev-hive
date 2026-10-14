package memstore

import (
	"context"
	"errors"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
)

const (
	Duplicate  = "duplicate"
	Stale      = "stale"
	BrokenLink = "broken-link"
	Orphan     = "orphan"
	OverLimit  = "over-limit"

	MemoryTokenLimit      = 1500
	InstructionTokenLimit = 2000
	MaxGitGreps           = 8
)

type Flag struct {
	Code    string   `json:"code"`
	Message string   `json:"message"`
	Related []string `json:"related"`
}

func (f *scannedFile) flag(code, message string, related ...string) {
	for i := range f.Flags {
		if f.Flags[i].Code == code {
			for _, value := range related {
				if !contains(f.Flags[i].Related, value) {
					f.Flags[i].Related = append(f.Flags[i].Related, value)
				}
			}
			return
		}
	}
	f.Flags = append(f.Flags, Flag{Code: code, Message: message, Related: append([]string{}, related...)})
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func applyFlags(files []scannedFile, now time.Time) {
	indices := make(map[string]string)
	for _, f := range files {
		if f.memoryDir != "" && f.Name == "MEMORY.md" {
			indices[f.memoryDir] = f.content
		}
	}
	shingles := make([]map[string]struct{}, len(files))
	repos := make(map[string]*repoProbe)
	for i := range files {
		f := &files[i]
		if f.Kind == "database" {
			continue
		}
		if now.Sub(f.ModifiedAt) > 30*24*time.Hour {
			f.flag(Stale, "file quá 30 ngày hoặc tham chiếu không còn trong repo")
		}
		limit := 0
		switch f.Name {
		case "MEMORY.md":
			limit = MemoryTokenLimit
		case "CLAUDE.md":
			limit = InstructionTokenLimit
		}
		if limit > 0 && f.Tokens > limit {
			f.flag(OverLimit, "token ước tính vượt trần nạp của file")
		}
		for _, target := range linkTargets(f.content) {
			if path, ok := localTarget(f.Path, target); ok {
				if _, err := os.Stat(path); os.IsNotExist(err) {
					f.flag(BrokenLink, "liên kết không còn đích", target)
				}
			}
		}
		if f.memoryDir != "" && f.Name != "MEMORY.md" && !indexContains(indices[f.memoryDir], f.Path) {
			f.flag(Orphan, "file không được nhắc trong MEMORY.md")
		}
		if f.ProjectPath != "" {
			refs := codeReferences(f.content)
			if len(refs) > 0 {
				repo, ok := repos[f.ProjectPath]
				if !ok {
					repo = newRepoProbe(f.ProjectPath)
					repos[f.ProjectPath] = repo
				}
				for _, ref := range refs {
					if ref.path {
						if path, ok := localTarget(f.Path, ref.value); ok {
							if _, err := os.Stat(path); err == nil {
								continue
							}
						}
					}
					if repo.missing(ref) {
						f.flag(Stale, "file quá 30 ngày hoặc tham chiếu không còn trong repo", ref.value)
					}
				}
			}
		}
		shingles[i] = wordShingles(f.content)
	}
	for i := range files {
		for j := i + 1; j < len(files); j++ {
			a, b := &files[i], &files[j]
			// Instruction dùng chung trên đĩa không phải hai bản memory cần gộp.
			if a.Kind == "database" || b.Kind == "database" || a.CLI != b.CLI || a.Profile == b.Profile ||
				a.ProjectKey != b.ProjectKey || a.Path == b.Path || a.resolved != "" && a.resolved == b.resolved {
				continue
			}
			if a.Name == b.Name || jaccard(shingles[i], shingles[j]) >= 0.6 {
				a.flag(Duplicate, "trùng tên hoặc nội dung gần giống ở gói khác", b.Path)
				b.flag(Duplicate, "trùng tên hoặc nội dung gần giống ở gói khác", a.Path)
			}
		}
	}
	for i := range files {
		sort.Slice(files[i].Flags, func(a, b int) bool { return files[i].Flags[a].Code < files[i].Flags[b].Code })
		for j := range files[i].Flags {
			sort.Strings(files[i].Flags[j].Related)
		}
	}
}

var (
	inlineLink = regexp.MustCompile(`!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+[^)]+)?\)`)
	wikiLink   = regexp.MustCompile(`\[\[([^\]\n]+)\]\]`)
	linkDef    = regexp.MustCompile(`(?m)^\s{0,3}\[[^\]\n]+\]:\s*(<[^>\n]+>|\S+)`)
	codeSpan   = regexp.MustCompile("`([^`\\n]+)`")
	symbolName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*(?:\(\))?$`)
	camelName  = regexp.MustCompile(`[a-z][A-Z]`)
)

func linkTargets(content string) []string {
	var targets []string
	for _, pattern := range []*regexp.Regexp{inlineLink, linkDef} {
		for _, match := range pattern.FindAllStringSubmatch(content, -1) {
			targets = append(targets, strings.Trim(match[1], "<>"))
		}
	}
	for _, match := range wikiLink.FindAllStringSubmatch(content, -1) {
		target := strings.SplitN(match[1], "|", 2)[0]
		target = strings.SplitN(target, "#", 2)[0]
		if target != "" && filepath.Ext(target) == "" {
			target += ".md"
		}
		targets = append(targets, target)
	}
	return targets
}

func localTarget(source, target string) (string, bool) {
	target = strings.TrimSpace(target)
	if target == "" || strings.HasPrefix(target, "#") || strings.HasPrefix(target, "//") {
		return "", false
	}
	// Ổ đĩa Windows chứa dấu ':' nhưng không phải URL scheme.
	if parsed, err := url.Parse(target); err == nil && parsed.Scheme != "" && !filepath.IsAbs(target) {
		return "", false
	}
	target = strings.SplitN(strings.SplitN(target, "#", 2)[0], "?", 2)[0]
	if decoded, err := url.PathUnescape(target); err == nil {
		target = decoded
	}
	target = filepath.FromSlash(target)
	if filepath.IsAbs(target) {
		return filepath.Clean(target), true
	}
	return filepath.Join(filepath.Dir(source), target), true
}

func indexContains(content, file string) bool {
	for _, target := range linkTargets(content) {
		if path, ok := localTarget(filepath.Join(filepath.Dir(file), "MEMORY.md"), target); ok && path == file {
			return true
		}
	}
	// Chỉ mục Claude cũng thường liệt kê tên file dưới dạng inline code hoặc chữ thường.
	for _, word := range strings.Fields(content) {
		if strings.Trim(word, "`*[](),;:\"'") == filepath.Base(file) {
			return true
		}
	}
	return false
}

func wordShingles(content string) map[string]struct{} {
	words := strings.FieldsFunc(strings.ToLower(content), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsNumber(r) })
	set := make(map[string]struct{})
	for i := 0; i+5 <= len(words); i++ {
		set[strings.Join(words[i:i+5], " ")] = struct{}{}
	}
	return set
}

func jaccard(a, b map[string]struct{}) float64 {
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	intersection := 0
	for key := range a {
		if _, ok := b[key]; ok {
			intersection++
		}
	}
	return float64(intersection) / float64(len(a)+len(b)-intersection)
}

type reference struct {
	value string
	path  bool
}

func codeReferences(content string) []reference {
	var refs []reference
	seen := make(map[string]bool)
	for _, match := range codeSpan.FindAllStringSubmatch(content, -1) {
		value := strings.TrimSpace(match[1])
		isPath := strings.ContainsAny(value, "/\\") || knownExtension(filepath.Ext(value))
		isSymbol := symbolName.MatchString(value) && (strings.HasSuffix(value, "()") || camelName.MatchString(value))
		if value == "" || strings.ContainsAny(value, " \t:*?<>|=") || strings.Contains(value, "://") || (!isPath && !isSymbol) || seen[value] {
			continue
		}
		seen[value] = true
		refs = append(refs, reference{value: strings.TrimSuffix(value, "()"), path: isPath})
	}
	return refs
}

func knownExtension(ext string) bool {
	switch ext {
	case ".go", ".ts", ".tsx", ".js", ".jsx", ".rs", ".py", ".java", ".json", ".toml", ".yaml", ".yml", ".sql", ".sh", ".md":
		return true
	}
	return false
}

type repoProbe struct {
	folder   string
	tracked  map[string]bool
	valid    bool
	greps    int
	cache    map[string]bool
	deadline time.Time
	run      func(...string) ([]byte, error)
}

func newRepoProbe(folder string) *repoProbe {
	p := &repoProbe{folder: folder, tracked: make(map[string]bool), cache: make(map[string]bool), deadline: time.Now().Add(800 * time.Millisecond)}
	p.run = func(args ...string) ([]byte, error) {
		timeout := min(400*time.Millisecond, time.Until(p.deadline))
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		command := exec.CommandContext(ctx, "git", args...)
		command.Dir = folder
		return command.Output()
	}
	if out, err := p.run("ls-files", "-z", "--cached"); err == nil {
		p.valid = true
		for _, name := range strings.Split(string(out), "\x00") {
			if name != "" {
				p.tracked[filepath.Clean(filepath.FromSlash(name))] = true
			}
		}
	}
	return p
}

func (p *repoProbe) missing(ref reference) bool {
	if !p.valid {
		return false
	}
	if ref.path {
		path := filepath.Clean(filepath.FromSlash(ref.value))
		if filepath.IsAbs(path) {
			if relative, err := filepath.Rel(p.folder, path); err == nil {
				path = relative
			}
		}
		if path == ".." || strings.HasPrefix(path, ".."+string(filepath.Separator)) {
			return false
		}
		if p.tracked[path] {
			return false
		}
		// Memory và file mới chưa git add vẫn là tham chiếu hợp lệ trên máy.
		if _, err := os.Stat(filepath.Join(p.folder, path)); err == nil || !os.IsNotExist(err) {
			return false
		}
		return true
	}
	if missing, ok := p.cache[ref.value]; ok {
		return missing
	}
	if p.greps >= MaxGitGreps || !p.deadline.IsZero() && time.Now().After(p.deadline) {
		return false
	}
	p.greps++
	_, err := p.run("grep", "-q", "-F", "-w", "-e", ref.value, "--")
	var exit *exec.ExitError
	// Timeout, thiếu git và repo lỗi không đủ bằng chứng để gắn cờ cũ.
	missing := errors.As(err, &exit) && exit.ExitCode() == 1
	p.cache[ref.value] = missing
	return missing
}
