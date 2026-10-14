package optimizer

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

const userConfig = `model = "gpt-5.5"
approval_policy = "on-request"

[profiles.fast]
model = "gpt-5.5-mini"

# >>> xdev-hive >>>
[mcp_servers.xdev-hive]
command = "/Applications/xDev Hive.app/hive-worker"
args = ["mcp"]
# <<< xdev-hive <<<
`

func codexProfile(t *testing.T, o *Optimizer) (Profile, string) {
	t.Helper()
	p := profile(t, o, "codex-2")
	if p.CLI != "codex" {
		t.Fatalf("đoán CLI theo tên gói: %+v", p)
	}
	return p, filepath.Join(p.Dir, "config.toml")
}

func TestCodexEnableThenDisableIsByteExact(t *testing.T) {
	cases := map[string]string{
		"with mcp block": userConfig,
		"crlf":           strings.ReplaceAll(userConfig, "\n", "\r\n"),
		"no newline":     `model = "o3"`,
		"only tables":    "[mcp_servers.a]\ncommand = \"a\"\n",
	}
	for name, original := range cases {
		t.Run(name, func(t *testing.T) {
			o, _ := fakeHome(t)
			p, path := codexProfile(t, o)
			write(t, path, original)
			res, err := o.Enable(p, "balanced", preset("80"), Options{})
			if err != nil {
				t.Fatal(err)
			}
			got := readString(t, path)
			if !strings.HasPrefix(got, codexBegin) {
				t.Fatalf("khối phải ở đầu file để khoá là khoá cấp gốc:\n%s", got)
			}
			if !strings.Contains(got, "tool_output_token_limit = 8000") || !strings.Contains(got, "model_auto_compact_token_limit = 150000") {
				t.Fatalf("thiếu khoá:\n%s", got)
			}
			if _, err := parseTOML([]byte(got)); err != nil {
				t.Fatalf("file sau khi bật không đọc lại được: %v", err)
			}
			if len(res.Added) != 2 {
				t.Fatalf("added: %v", res.Added)
			}
			if _, err := o.Disable(p); err != nil {
				t.Fatal(err)
			}
			if got := readString(t, path); got != original {
				t.Fatalf("tắt không trả về đúng file gốc:\n%q", got)
			}
		})
	}
}

func TestCodexExistingKeyNotDuplicated(t *testing.T) {
	o, _ := fakeHome(t)
	p, path := codexProfile(t, o)
	original := "tool_output_token_limit = 4000 # tự đặt\n\n[profiles.deep]\nmodel_auto_compact_token_limit = 300000\n"
	write(t, path, original)
	res, err := o.Enable(p, "balanced", preset("80"), Options{})
	if err != nil {
		t.Fatal(err)
	}
	got := readString(t, path)
	if n := strings.Count(got, "tool_output_token_limit"); n != 1 {
		t.Fatalf("khoá bị thêm trùng (%d lần):\n%s", n, got)
	}
	// Khoá trong [profiles.deep] là khoá khác, khoá cấp gốc vẫn được thêm.
	if !strings.Contains(got, "model_auto_compact_token_limit = 150000") {
		t.Fatalf("thiếu khoá cấp gốc:\n%s", got)
	}
	if len(res.Warnings) != 1 || res.Warnings[0].Key != "codex.tool_output_token_limit" || res.Warnings[0].Kind != "user_set" {
		t.Fatalf("warnings: %+v", res.Warnings)
	}
	if _, err := o.Disable(p); err != nil {
		t.Fatal(err)
	}
	if readString(t, path) != original {
		t.Fatal("tắt không trả về file gốc")
	}
}

func TestCodexUserChangedBlockKeyKept(t *testing.T) {
	o, _ := fakeHome(t)
	p, path := codexProfile(t, o)
	write(t, path, userConfig)
	if _, err := o.Enable(p, "balanced", preset("80"), Options{}); err != nil {
		t.Fatal(err)
	}
	write(t, path, strings.Replace(readString(t, path), "tool_output_token_limit = 8000", "tool_output_token_limit = 9000", 1))
	res, err := o.Disable(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Warnings) != 1 || res.Warnings[0].Kind != "user_changed" {
		t.Fatalf("warnings: %+v", res.Warnings)
	}
	if got := readString(t, path); got != "tool_output_token_limit = 9000\n"+userConfig {
		t.Fatalf("chỉ được gỡ dấu khối và khoá Hive chưa đổi:\n%s", got)
	}
}

func TestCodexInvalidTOMLNotWritten(t *testing.T) {
	for name, broken := range map[string]string{
		"not a key":          "model = \"o3\"\nthis is not toml\n",
		"open string":        "model = \"o3\n",
		"open array":         "args = [\n  \"a\",\n",
		"bad header":         "[profiles\nmodel = 1\n",
		"half block":         codexBegin + "\ntool_output_token_limit = 1\n",
		"empty value":        "model =\n",
		"close without open": "a = 1]\n",
	} {
		t.Run(name, func(t *testing.T) {
			o, _ := fakeHome(t)
			p, path := codexProfile(t, o)
			write(t, path, broken)
			if _, err := o.Enable(p, "balanced", preset("80"), Options{}); !errors.Is(err, ErrInvalidConfig) {
				t.Fatalf("TOML hỏng phải báo lỗi: %v", err)
			}
			if readString(t, path) != broken {
				t.Fatal("TOML hỏng thì không được ghi")
			}
		})
	}
}

func TestParseTOMLTopKeys(t *testing.T) {
	src := `a = 1
dotted.key = "x"
"quoted" = 2
text = """
[not_a_table]
b = 3
"""
list = [
  [1, 2],
  "]",
]
inline = { c = 4 }
lit = 'it''s'
[table]
d = 5
[[arr]]
e = 6
`
	f, err := parseTOML([]byte(src))
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"a", "dotted", "quoted", "text", "list", "inline", "lit"} {
		if !f.topKeys[k] {
			t.Errorf("thiếu khoá cấp gốc %s", k)
		}
	}
	for _, k := range []string{"b", "c", "d", "e", "not_a_table"} {
		if f.topKeys[k] {
			t.Errorf("%s không phải khoá cấp gốc", k)
		}
	}
}

func TestCodexLevelChangeKeepsSingleBlock(t *testing.T) {
	o, _ := fakeHome(t)
	p, path := codexProfile(t, o)
	write(t, path, userConfig)
	if _, err := o.Enable(p, "balanced", preset("80"), Options{}); err != nil {
		t.Fatal(err)
	}
	agg := preset("70")
	agg.Codex = map[string]string{"tool_output_token_limit": "6000", "model_auto_compact_token_limit": "120000"}
	if _, err := o.Enable(p, "aggressive", agg, Options{}); err != nil {
		t.Fatal(err)
	}
	got := readString(t, path)
	if strings.Count(got, codexBegin) != 1 || !strings.Contains(got, "tool_output_token_limit = 6000") || strings.Contains(got, "8000") {
		t.Fatalf("đổi mức phải thay khối cũ:\n%s", got)
	}
	if _, err := o.Disable(p); err != nil {
		t.Fatal(err)
	}
	if readString(t, path) != userConfig {
		t.Fatal("tắt sau khi đổi mức không trả về file gốc")
	}
}

func TestTOMLValue(t *testing.T) {
	for in, want := range map[string]string{"8000": "8000", "true": "true", "low": `"low"`, `"low"`: `"low"`, "1.5": "1.5"} {
		if got := tomlValue(in); got != want {
			t.Errorf("tomlValue(%q) = %q, mong đợi %q", in, got, want)
		}
	}
}
