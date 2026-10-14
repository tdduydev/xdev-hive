package runner

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Context pack cho phiên tương tác (`hive-worker hook prompt --local`, US7 của specs/015-client-token-optimizer): cùng
// buildContextPack với run, tiêm qua additionalContext của UserPromptSubmit. Chỉ ở prompt đầu tiên của phiên: đó là lúc
// model chưa đọc gì và dò repo nhiều nhất; tiêm lại ở mỗi prompt sẽ tốn token hơn phần tiết kiệm được.
const (
	// localPackMarker có trong thư mục phiên là phiên đã qua prompt đầu.
	localPackMarker = "prompt.seen"
	// localPackMaxChars giữ cùng ngân sách với pack của run, tính cả dòng ghi chú đặt trước.
	localPackMaxChars = contextPackMaxChars
)

// localPackTimeout ngắn hơn của run (20 giây) vì người dùng đang chờ câu trả lời đầu tiên; quá giờ thì prompt đi tiếp
// không có pack. Biến để test rút ngắn.
var localPackTimeout = 5 * time.Second

// localPrompt trả additionalContext cho prompt đầu tiên của phiên, nil với mọi prompt sau hay khi không dựng được pack.
func localPrompt(dir string, in localHookInput) any {
	prompt := strings.TrimSpace(in.Prompt)
	// Lệnh gạch chéo (/model, /clear…) không mô tả việc cần làm; prompt thật đến sau vẫn được tính là prompt đầu.
	if prompt == "" || strings.HasPrefix(prompt, "/") {
		return nil
	}
	// Đánh dấu trước khi dựng: lần này lỗi hay quá giờ thì prompt sau cũng không dựng lại, để không lần nào chờ thêm.
	f, err := os.OpenFile(filepath.Join(dir, localPackMarker), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return nil
	}
	_ = f.Close()
	text := localContextPack(in.Cwd, prompt, localPackTimeout)
	if text == "" {
		return nil
	}
	return map[string]any{"hookSpecificOutput": map[string]any{
		"hookEventName":     "UserPromptSubmit",
		"additionalContext": text,
	}}
}

// localContextPack dựng pack trong timeout, trả rỗng khi quá giờ. Không chờ goroutine dựng xong: hook thoát ngay sau
// đó nên git và codegraph đang chạy dở bị huỷ theo ctx.
func localContextPack(cwd, prompt string, timeout time.Duration) string {
	if cwd == "" || !filepath.IsAbs(cwd) {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	done := make(chan string, 1)
	go func() { done <- buildLocalPack(ctx, cwd, prompt) }()
	select {
	case text := <-done:
		if ctx.Err() != nil {
			return ""
		}
		return text
	case <-ctx.Done():
		return ""
	}
}

func buildLocalPack(ctx context.Context, cwd, prompt string) string {
	out, err := gitOutput(ctx, cwd, "rev-parse", "--show-toplevel")
	if err != nil {
		return ""
	}
	root := filepath.Clean(strings.TrimSpace(out))
	if root == "." || root == "" {
		return ""
	}
	var commands []string
	// Claude Code tự nạp CLAUDE.md, thường đã có lệnh build/test; lặp lại chỉ tốn token, như brief ở run.
	if !fileExists(filepath.Join(root, "CLAUDE.md")) && !fileExists(filepath.Join(root, ".claude", "CLAUDE.md")) {
		commands = buildCommands(root)
	}
	pack, err := buildContextPack(ctx, root, prompt, localCodeGraph(ctx, root), commands)
	if err != nil || pack.Text == "" {
		return ""
	}
	// Phiên có thể mở ở thư mục con, còn đường dẫn trong pack tính từ gốc repo.
	note := "[xdev-hive] Context pack dựng từ prompt đầu tiên của phiên; đường dẫn tính từ gốc repo `" + root + "`.\n\n"
	text, _ := renderPack(pack.Files, commands, localPackMaxChars-len(note))
	if text == "" {
		return ""
	}
	return note + text
}

// localCodeGraph trả file chạy codegraph khi máy có và repo có chỉ mục: chỉ mục sẵn trong repo (người dùng tự dựng,
// hoặc phiên trước đã chép), không thì bản bền worker đã dựng trong DataDir/codegraph/<sha>. Không dựng mới: dựng lần
// đầu mất hơn 10 giây, quá ngân sách của prompt.
func localCodeGraph(ctx context.Context, root string) string {
	cfg, err := ToolConfigFromEnv(CodeGraphEnv)
	if err != nil {
		return ""
	}
	bin, err := resolveTool(cfg, "codegraph")
	if err != nil || bin == "" {
		return ""
	}
	if fileExists(filepath.Join(root, codegraphDir, "codegraph.db")) {
		return bin
	}
	stored := storedCodeGraph(ctx, root)
	if stored == "" || seedCodeGraph(root, stored) != nil {
		return ""
	}
	return bin
}

// storedCodeGraph tìm chỉ mục worker đã dựng cho repo này. Worker đặt tên theo repo URL của dự án trên hub, có thể khác
// dạng với remote của bản clone người dùng (ssh hay https, có hay không .git), nên thử mọi dạng của mọi remote.
func storedCodeGraph(ctx context.Context, root string) string {
	dataDir, err := os.UserCacheDir()
	if err != nil {
		return ""
	}
	base := filepath.Join(dataDir, "xdev-hive", "worker", "codegraph")
	if _, err := os.Stat(base); err != nil {
		return ""
	}
	out, _ := gitOutput(ctx, root, "config", "--get-regexp", `^remote\..*\.url$`)
	urls := []string{root}
	for _, line := range strings.Split(out, "\n") {
		if _, url, ok := strings.Cut(strings.TrimSpace(line), " "); ok {
			urls = append(urls, repoURLForms(strings.TrimSpace(url))...)
		}
	}
	for _, u := range urls {
		sum := sha256.Sum256([]byte(u))
		dir := filepath.Join(base, hex.EncodeToString(sum[:8]))
		if fileExists(filepath.Join(dir, "codegraph.db")) {
			return dir
		}
	}
	return ""
}

// repoURLForms trả url và các dạng tương đương: có/không đuôi .git, ssh (git@host:path) và https.
func repoURLForms(url string) []string {
	if url == "" {
		return nil
	}
	path := strings.TrimSuffix(url, ".git")
	var host, rest string
	switch {
	case strings.HasPrefix(path, "https://"):
		host, rest, _ = strings.Cut(strings.TrimPrefix(path, "https://"), "/")
	case strings.HasPrefix(path, "ssh://git@"):
		host, rest, _ = strings.Cut(strings.TrimPrefix(path, "ssh://git@"), "/")
	case strings.HasPrefix(path, "git@"):
		host, rest, _ = strings.Cut(strings.TrimPrefix(path, "git@"), ":")
	}
	out := []string{url}
	add := func(s string) {
		for _, v := range []string{s, s + ".git"} {
			if !containsString(out, v) {
				out = append(out, v)
			}
		}
	}
	add(path)
	if host != "" && rest != "" {
		add("https://" + host + "/" + rest)
		add("git@" + host + ":" + rest)
	}
	return out
}

// seedCodeGraph chép chỉ mục bền vào <repo>/.codegraph, chỗ duy nhất codegraph đọc. Loại khỏi git trước như worker làm
// với worktree; codegraph.db được đổi tên vào chỗ sau cùng, để hook bị ngắt giữa chừng không để lại chỉ mục chép dở mà
// phiên sau tưởng là đủ.
func seedCodeGraph(root, stored string) error {
	if err := appendExclude(root, codegraphDir+"/"); err != nil {
		return err
	}
	local := filepath.Join(root, codegraphDir)
	if err := os.MkdirAll(local, 0o700); err != nil {
		return err
	}
	for _, name := range codegraphFiles {
		dst := filepath.Join(local, name)
		if name == "codegraph.db" {
			dst += ".hive-tmp"
		}
		if err := copyFile(filepath.Join(stored, name), dst); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	db := filepath.Join(local, "codegraph.db")
	if err := os.Rename(db+".hive-tmp", db); err != nil {
		_ = os.Remove(db + ".hive-tmp")
		return err
	}
	return nil
}
