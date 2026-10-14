// Package memstore quét memory cục bộ chỉ đọc; thao tác ghi được tách khỏi inventory.
package memstore

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/projects"
)

// Root nhận đường dẫn cấu hình tường minh để không vô tình quét gói mặc định của người dùng.
type Root struct {
	CLI     string `json:"cli"`
	Profile string `json:"profile"`
	Path    string `json:"path"`
}

type File struct {
	CLI         string    `json:"cli"`
	Profile     string    `json:"profile"`
	ProjectKey  string    `json:"projectKey,omitempty"`
	ProjectPath string    `json:"projectPath,omitempty"`
	Path        string    `json:"path"`
	Name        string    `json:"name"`
	Kind        string    `json:"kind"`
	Size        int64     `json:"size"`
	Tokens      int       `json:"tokens"`
	ModifiedAt  time.Time `json:"modifiedAt"`
	Flags       []Flag    `json:"flags"`
}

type Session struct {
	CLI           string   `json:"cli"`
	Profile       string   `json:"profile"`
	ProjectKey    string   `json:"projectKey"`
	ProjectPath   string   `json:"projectPath,omitempty"`
	SessionTokens int      `json:"sessionTokens"`
	Paths         []string `json:"paths"`
}

type Inventory struct {
	Files    []File    `json:"files"`
	Sessions []Session `json:"sessions"`
	Warnings []string  `json:"warnings"`
}

type scannedFile struct {
	File
	content   string
	memoryDir string
	resolved  string
}

type scanner struct {
	files    []scannedFile
	sessions []Session
	warnings []string
	seen     map[string]int
}

// Scan không tự khám phá HOME: bên gọi lấy roots từ accounts và projects từ danh sách repo local.
// Lỗi một nguồn được trả ở Warnings để các gói còn lại vẫn xem được.
func Scan(roots []Root, localProjects []projects.Project) Inventory {
	s := scanner{seen: make(map[string]int), files: []scannedFile{}, sessions: []Session{}, warnings: []string{}}
	for _, root := range roots {
		if root.Path == "" {
			s.warnings = append(s.warnings, "thiếu thư mục cấu hình của gói "+root.Profile)
			continue
		}
		root.Path = absolute(root.Path)
		if root.CLI != "claude" && root.CLI != "codex" && root.CLI != "gemini" {
			s.warnings = append(s.warnings, "chưa hỗ trợ quét memory cho CLI "+root.CLI)
			continue
		}
		s.scanRoot(root, localProjects)
	}
	applyFlags(s.files, time.Now())
	out := Inventory{Files: make([]File, len(s.files)), Sessions: s.sessions, Warnings: s.warnings}
	for i := range s.files {
		out.Files[i] = s.files[i].File
	}
	sort.Slice(out.Files, func(i, j int) bool {
		a, b := out.Files[i], out.Files[j]
		return a.CLI+"\x00"+a.ProjectKey+"\x00"+a.Profile+"\x00"+a.Path < b.CLI+"\x00"+b.ProjectKey+"\x00"+b.Profile+"\x00"+b.Path
	})
	sort.Slice(out.Sessions, func(i, j int) bool {
		a, b := out.Sessions[i], out.Sessions[j]
		return a.CLI+"\x00"+a.ProjectKey+"\x00"+a.Profile < b.CLI+"\x00"+b.ProjectKey+"\x00"+b.Profile
	})
	return out
}

// ProjectKey khớp thư mục projects của Claude, gồm cả dấu phân cách và ký tự ổ đĩa Windows.
func ProjectKey(folder string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			return r
		}
		return '-'
	}, folder)
}

func absolute(path string) string {
	if full, err := filepath.Abs(path); err == nil {
		return filepath.Clean(full)
	}
	return filepath.Clean(path)
}

func (s *scanner) scanRoot(root Root, localProjects []projects.Project) {
	instruction := map[string]string{"claude": "CLAUDE.md", "codex": "AGENTS.md", "gemini": "GEMINI.md"}[root.CLI]
	global := s.add(root, "", "", filepath.Join(root.Path, instruction), "instruction", "")
	if root.CLI == "codex" {
		s.add(root, "", "", filepath.Join(root.Path, "memories_1.sqlite"), "database", "")
	}
	known := make(map[string]string)
	for _, project := range localProjects {
		if project.Folder == "" {
			continue
		}
		folder := absolute(project.Folder)
		known[ProjectKey(folder)] = folder
		// /var và /private/var trên macOS có thể cùng chỉ một dự án.
		if resolved, err := filepath.EvalSymlinks(folder); err == nil {
			known[ProjectKey(resolved)] = folder
		}
	}
	memory := make(map[string]string)
	if root.CLI == "claude" {
		base := filepath.Join(root.Path, "projects")
		entries, err := os.ReadDir(base)
		if err != nil && !os.IsNotExist(err) {
			s.warnings = append(s.warnings, fmt.Sprintf("không đọc được thư mục memory %s: %v", base, err))
		}
		for _, entry := range entries {
			key := entry.Name()
			dir := filepath.Join(base, key, "memory")
			if st, err := os.Stat(dir); err == nil && st.IsDir() {
				memory[key] = dir
			}
		}
	}
	// Một repo có thể có khoá cũ dùng đường dẫn trước khi giải liên kết.
	keys := make(map[string]string)
	for key := range memory {
		keys[key] = known[key]
	}
	for _, project := range localProjects {
		if project.Folder == "" {
			continue
		}
		folder := absolute(project.Folder)
		matched := false
		for _, path := range keys {
			if path == folder {
				matched = true
				break
			}
		}
		if !matched {
			keys[ProjectKey(folder)] = folder
		}
	}
	ordered := make([]string, 0, len(keys))
	for key := range keys {
		ordered = append(ordered, key)
	}
	sort.Strings(ordered)
	for _, key := range ordered {
		folder := keys[key]
		session := Session{CLI: root.CLI, Profile: root.Profile, ProjectKey: key, ProjectPath: folder, Paths: []string{}}
		included := make(map[string]bool)
		include := func(i int) {
			if i >= 0 && !included[s.files[i].Path] {
				included[s.files[i].Path] = true
				session.Paths = append(session.Paths, s.files[i].Path)
				session.SessionTokens += s.files[i].Tokens
			}
		}
		include(global)
		if dir := memory[key]; dir != "" {
			entries, err := os.ReadDir(dir)
			if err != nil {
				s.warnings = append(s.warnings, fmt.Sprintf("không đọc được thư mục memory %s: %v", dir, err))
			}
			for _, entry := range entries {
				if !entry.IsDir() && strings.EqualFold(filepath.Ext(entry.Name()), ".md") {
					i := s.add(root, key, folder, filepath.Join(dir, entry.Name()), "memory", dir)
					if entry.Name() == "MEMORY.md" {
						include(i)
					}
				}
			}
		}
		if folder != "" {
			for dir := folder; ; dir = filepath.Dir(dir) {
				include(s.add(root, key, folder, filepath.Join(dir, instruction), "instruction", ""))
				if root.CLI == "claude" {
					include(s.add(root, key, folder, filepath.Join(dir, ".claude", "CLAUDE.md"), "instruction", ""))
					// Claude inventory vẫn hiện AGENTS.md, nhưng không giả định CLI tự nạp file này.
					s.add(root, key, folder, filepath.Join(dir, "AGENTS.md"), "instruction", "")
				}
				if filepath.Dir(dir) == dir {
					break
				}
			}
		}
		sort.Strings(session.Paths)
		s.sessions = append(s.sessions, session)
	}
}

func (s *scanner) add(root Root, key, folder, path, kind, memoryDir string) int {
	path = absolute(path)
	id := root.CLI + "\x00" + root.Profile + "\x00" + key + "\x00" + path
	if i, ok := s.seen[id]; ok {
		return i
	}
	st, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return -1
	}
	if err != nil {
		s.warnings = append(s.warnings, fmt.Sprintf("không đọc được thông tin file %s: %v", path, err))
		return -1
	}
	f := scannedFile{File: File{CLI: root.CLI, Profile: root.Profile, ProjectKey: key, ProjectPath: folder,
		Path: path, Name: filepath.Base(path), Kind: kind, Size: st.Size(), ModifiedAt: st.ModTime(), Flags: []Flag{}}, memoryDir: memoryDir}
	if st.Mode()&os.ModeSymlink != 0 {
		st, err = os.Stat(path)
		if os.IsNotExist(err) {
			f.flag(BrokenLink, "liên kết file không còn đích", path)
		} else if err != nil {
			s.warnings = append(s.warnings, fmt.Sprintf("không đọc được liên kết %s: %v", path, err))
			return -1
		} else {
			f.Size, f.ModifiedAt = st.Size(), st.ModTime()
		}
	}
	if err == nil && !st.Mode().IsRegular() {
		return -1
	}
	if err == nil && kind != "database" {
		content, readErr := os.ReadFile(path)
		if readErr != nil {
			s.warnings = append(s.warnings, fmt.Sprintf("không đọc được file %s: %v", path, readErr))
			return -1
		}
		f.content = string(content)
		f.Tokens = EstimateTokens(f.content)
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		f.resolved = resolved
	}
	s.seen[id] = len(s.files)
	s.files = append(s.files, f)
	return len(s.files) - 1
}
