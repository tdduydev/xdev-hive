package ctxsync

import (
	"os"
	"path/filepath"
	"strings"
)

// Codex đọc AGENTS.override.md THAY cho AGENTS.md cùng thư mục, không cộng thêm (research mục 1). Vì vậy file đích của
// Codex là bản gương: AGENTS.md của repo rồi tới khối. Phần ngoài khối là của app; AGENTS.md đổi thì gương cũ (stale) và
// lần đồng bộ sau dựng lại.

const agentsFile = "AGENTS.md"

// agentsMirror đọc AGENTS.md để chép vào gương; sha rỗng khi repo không có AGENTS.md.
func agentsMirror(folder string) (text string, m Mirror) {
	m.Path = agentsFile
	raw, err := os.ReadFile(filepath.Join(folder, agentsFile))
	if err != nil {
		return "", m
	}
	return string(raw), Mirror{Path: agentsFile, Sha: hashBody(string(raw))}
}

// buildMirror ghép AGENTS.md và khối, theo kiểu xuống dòng của AGENTS.md.
func buildMirror(agents, block string) string {
	eol := detectEOL(agents)
	block = strings.ReplaceAll(block, "\n", eol)
	rest := strings.TrimPrefix(agents, bom)
	sep := ""
	switch {
	case rest == "":
	case strings.HasSuffix(rest, "\n"):
		sep = eol
	default:
		sep = eol + eol
	}
	return agents + sep + block + eol
}

func planCodex(folder string, body, source string, force bool) planned {
	rel := targetPath(Codex)
	cur, exists, reason := readTarget(folder, rel)
	if reason != "" {
		return skipped(Codex, reason)
	}
	agents, mirror := agentsMirror(folder)
	p := planOwned(Codex, rel, cur, exists, body, source, force, func(block string) string {
		return buildMirror(agents, block)
	})
	if p.status == StatusOK {
		p.mirror = &mirror
	}
	return p
}
