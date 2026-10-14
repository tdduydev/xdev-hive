package runner

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExtractPackTerms(t *testing.T) {
	got := extractPackTerms("Sửa `LoginHandler` trong apps/hub/src/auth.ts và worker/internal/runner/ khi session_store trả lỗi; " +
		"xem https://example.com/a/b.go. Thêm retryCount cho middleware, không dùng helper chung.")
	want := map[string][]string{
		"paths":    {"apps/hub/src/auth.ts", "worker/internal/runner"},
		"symbols":  {"LoginHandler", "session_store", "retryCount"},
		"keywords": {"middleware", "helper"},
	}
	has := func(list []string, v string) bool { return containsString(list, v) }
	for _, p := range want["paths"] {
		if !has(got.Paths, p) {
			t.Fatalf("thiếu đường dẫn %q trong %v", p, got.Paths)
		}
	}
	for _, s := range want["symbols"] {
		if !has(got.Symbols, s) {
			t.Fatalf("thiếu symbol %q trong %v", s, got.Symbols)
		}
	}
	for _, k := range want["keywords"] {
		if !has(got.Keywords, k) {
			t.Fatalf("thiếu từ khoá %q trong %v", k, got.Keywords)
		}
	}
	for _, p := range got.Paths {
		if strings.Contains(p, "example.com") {
			t.Fatalf("URL lọt vào đường dẫn: %v", got.Paths)
		}
	}
	// Từ tiếng Việt và từ phổ biến không thành từ khoá.
	for _, k := range got.Keywords {
		if k == "khong" || k == "dung" || k == "trong" {
			t.Fatalf("từ khoá nhiễu %q", k)
		}
	}
}

// packRepo dựng repo git có lịch sử: store.go hay đổi cùng login.go, noise.go không liên quan.
func packRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	must(t, "git", "init", "-q", dir)
	write := func(name, body string) {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	commit := func(msg string) {
		must(t, "git", "-C", dir, "add", "-A")
		must(t, "git", "-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", msg)
	}
	write("auth/login.go", "package auth\n\n// LoginHandler xử lý đăng nhập.\nfunc LoginHandler() error { return nil }\n\ntype Claims struct{}\n")
	write("session/store.go", "package session\n\nfunc Get(id string) string { return id }\n")
	write("misc/noise.go", "package misc\n\nfunc Noise() {}\n")
	write("go.sum", "LoginHandler\n")
	commit("base")
	for i := range 3 {
		write("auth/login.go", "package auth\n\n// LoginHandler xử lý đăng nhập.\nfunc LoginHandler() error { return nil }\n\ntype Claims struct{}\n// v"+string(rune('a'+i))+"\n")
		write("session/store.go", "package session\n\nfunc Get(id string) string { return id }\n// v"+string(rune('a'+i))+"\n")
		commit("đổi cùng")
	}
	write("misc/noise.go", "package misc\n\nfunc Noise() {}\n// x\n")
	commit("khác")
	return dir
}

func TestBuildContextPackRanksMentionedAndCoChanged(t *testing.T) {
	dir := packRepo(t)
	pack, err := buildContextPack(context.Background(), dir, "Sửa LoginHandler trả 500 khi phiên hết hạn", "", []string{"go test ./..."})
	if err != nil {
		t.Fatal(err)
	}
	if len(pack.Files) < 2 || pack.Files[0].Path != "auth/login.go" {
		t.Fatalf("xếp hạng = %+v", pack.Files)
	}
	var store *packFile
	for i, f := range pack.Files {
		switch f.Path {
		case "session/store.go":
			store = &pack.Files[i]
		case "misc/noise.go", "go.sum":
			t.Fatalf("file không liên quan trong pack: %+v", pack.Files)
		}
	}
	if store == nil || !strings.Contains(strings.Join(store.Reasons, ";"), "hay đổi cùng login.go") {
		t.Fatalf("thiếu file đổi cùng: %+v", pack.Files)
	}
	for _, want := range []string{"`auth/login.go`", "L4 `func LoginHandler() error", "## Lệnh build/test", "`go test ./...`"} {
		if !strings.Contains(pack.Text, want) {
			t.Fatalf("pack thiếu %q:\n%s", want, pack.Text)
		}
	}
}

func TestBuildContextPackNoTermsIsEmpty(t *testing.T) {
	pack, err := buildContextPack(context.Background(), packRepo(t), "sửa lỗi giúp", "", nil)
	if err != nil || pack.Text != "" || len(pack.Files) != 0 {
		t.Fatalf("pack = %+v, %v", pack, err)
	}
}

// Pack vượt ngân sách thì bỏ khai báo của file cuối bảng trước, rồi mới bỏ file; không bao giờ quá maxChars.
func TestRenderPackStaysWithinBudget(t *testing.T) {
	var files []packFile
	for i := range 30 {
		f := packFile{Path: strings.Repeat("d/", 5) + "file" + string(rune('a'+i%26)) + ".go", Reasons: []string{"chứa `x`"}}
		for j := range 6 {
			f.Sigs = append(f.Sigs, packSig{Line: j + 1, Text: "func " + strings.Repeat("Long", 20) + "()"})
		}
		files = append(files, f)
	}
	full, n := renderPack(files, []string{"make test"}, 1<<20)
	if n != 30 {
		t.Fatalf("giữ %d file", n)
	}
	text, kept := renderPack(files, []string{"make test"}, 4000)
	if len(text) > 4000 || kept == 0 || len(text) >= len(full) {
		t.Fatalf("len = %d, giữ %d file", len(text), kept)
	}
	// File đầu bảng giữ khai báo lâu nhất.
	if !strings.Contains(text, "  - L1 `func Long") || !strings.HasSuffix(text, "- `make test`\n") {
		t.Fatalf("pack:\n%s", text)
	}
}

func TestPackQueryFallsBackToPromptAfterSeparator(t *testing.T) {
	if got := packQuery(Job{TaskText: "task", Prompt: "brief\n---\nkhác"}); got != "task" {
		t.Fatal(got)
	}
	if got := packQuery(Job{Prompt: "# Brief\nx\n---\nmột\n\n---\n\nSửa LoginHandler"}); got != "\nSửa LoginHandler" {
		t.Fatalf("%q", got)
	}
}

func TestBuildCommands(t *testing.T) {
	dir := t.TempDir()
	mustDir(t, dir, "package.json", `{"scripts":{"test":"vitest","build":"vite build","dev":"vite"}}`)
	mustDir(t, dir, "pnpm-lock.yaml", "")
	mustDir(t, dir, "go.mod", "module x\n")
	got := strings.Join(buildCommands(dir), "|")
	if got != "pnpm test|pnpm build|gofmt -l .|go vet ./...|go test ./..." {
		t.Fatal(got)
	}
}

func TestFileSignaturesPreferTaskTerms(t *testing.T) {
	dir := t.TempDir()
	var b strings.Builder
	b.WriteString("export const a = 1;\n")
	for i := range 10 {
		b.WriteString("export function other" + string(rune('A'+i)) + "() {}\n")
	}
	b.WriteString("export async function loadSession(id: string) {\n")
	mustDir(t, dir, "x.ts", b.String())
	sigs := fileSignatures(filepath.Join(dir, "x.ts"), packTerms{Symbols: []string{"loadSession"}})
	if len(sigs) != packSigsPerFile || sigs[len(sigs)-1].Text != "export async function loadSession(id: string)" || sigs[len(sigs)-1].Line != 12 {
		t.Fatalf("%+v", sigs)
	}
}
