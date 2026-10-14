package tokenreport

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type MemoryInventory struct {
	Dirs               int   `json:"dirs"`
	ProjectsWithMemory int   `json:"projectsWithMemory"`
	Files              int   `json:"files"`
	Bytes              int64 `json:"bytes"`
	IndexBytes         int   `json:"indexBytes"`
	Dead               int   `json:"dead"`
	Stale              int   `json:"stale"`
	Orphan             int   `json:"orphan"`
	Duplicated         int   `json:"duplicated"`
}

type CodexMemory struct {
	Account    string `json:"account"`
	AgentsMd   int64  `json:"agentsMd"`
	MemoriesDb int64  `json:"memoriesDb"`
}

type OtherMemory struct {
	Codex    []CodexMemory `json:"codex"`
	GeminiMd int64         `json:"geminiMd"`
}

var (
	memName     = regexp.MustCompile(`(?m)^name:\s*(.+)$`)
	memFileLink = regexp.MustCompile(`\]\(([^)]+\.md)\)`)
	memSlugLink = regexp.MustCompile(`\[\[([^\]]+)\]\]`)
)

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func mdNames(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".md") {
			out = append(out, e.Name())
		}
	}
	return out
}

// memoryInventory kiểm memory trên đĩa: số file, cỡ, MEMORY.md, link chết, file cũ, tên trùng giữa các gói.
func memoryInventory(roots []root, now time.Time) MemoryInventory {
	type memDir struct{ account, project, dir string }
	var dirs []memDir
	for _, r := range roots {
		projects, err := os.ReadDir(r.dir)
		if err != nil {
			continue
		}
		for _, p := range projects {
			dir := filepath.Join(r.dir, p.Name(), "memory")
			if len(mdNames(dir)) > 0 {
				dirs = append(dirs, memDir{r.account, p.Name(), dir})
			}
		}
	}
	inv := MemoryInventory{Dirs: len(dirs)}
	byName := map[string]map[string]bool{}
	projects := map[string]bool{}
	for _, d := range dirs {
		projects[d.project] = true
		names := mdNames(d.dir)
		slugs := map[string]bool{}
		for _, f := range names {
			p := filepath.Join(d.dir, f)
			st, err := os.Stat(p)
			if err != nil {
				continue
			}
			inv.Files++
			inv.Bytes += st.Size()
			if now.Sub(st.ModTime()) > 30*24*time.Hour {
				inv.Stale++
			}
			if body, err := os.ReadFile(p); err == nil {
				if m := memName.FindSubmatch(body); m != nil {
					slugs[strings.TrimSpace(string(m[1]))] = true
				}
			}
			key := d.project + "/" + f
			if byName[key] == nil {
				byName[key] = map[string]bool{}
			}
			byName[key][d.account] = true
		}
		var index string
		if body, err := os.ReadFile(filepath.Join(d.dir, "MEMORY.md")); err == nil {
			index = string(body)
		}
		inv.IndexBytes += jsLen(index)
		for _, f := range names {
			if f != "MEMORY.md" && !strings.Contains(index, f) {
				inv.Orphan++
			}
		}
		for _, f := range names {
			body, err := os.ReadFile(filepath.Join(d.dir, f))
			if err != nil {
				continue
			}
			for _, m := range memFileLink.FindAllSubmatch(body, -1) {
				if !exists(filepath.Join(d.dir, string(m[1]))) {
					inv.Dead++
				}
			}
			for _, m := range memSlugLink.FindAllSubmatch(body, -1) {
				slug := string(m[1])
				if !slugs[slug] && !exists(filepath.Join(d.dir, slug+".md")) {
					inv.Dead++
				}
			}
		}
	}
	for _, accounts := range byName {
		if len(accounts) > 1 {
			inv.Duplicated++
		}
	}
	inv.ProjectsWithMemory = len(projects)
	return inv
}

func fileSize(p string) int64 {
	if st, err := os.Stat(p); err == nil {
		return st.Size()
	}
	return 0
}

func otherMemory(codexHomes []root, home string) OtherMemory {
	out := OtherMemory{Codex: []CodexMemory{}}
	for _, h := range codexHomes {
		out.Codex = append(out.Codex, CodexMemory{
			Account:    h.account,
			AgentsMd:   fileSize(filepath.Join(h.home, "AGENTS.md")),
			MemoriesDb: fileSize(filepath.Join(h.home, "memories_1.sqlite")),
		})
	}
	out.GeminiMd = fileSize(filepath.Join(home, ".gemini", "GEMINI.md"))
	return out
}
