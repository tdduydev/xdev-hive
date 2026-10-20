package branches

import (
	"os"
	"slices"
	"strings"
	"testing"
)

func TestSettingsDefaults(t *testing.T) {
	env := testEnv(t)
	s, err := Settings(env)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(s.Patterns, []string{"ai/*", "claude/*"}) || !slices.Contains(s.Rebuildable, "node_modules") ||
		!slices.Equal(s.Defaults.Patterns, s.Patterns) || s.Path != SettingsPath(env.ConfigDir) {
		t.Fatalf("%+v", s)
	}
	if _, err := os.Stat(s.Path); !os.IsNotExist(err) {
		t.Fatalf("settings không được tạo file: %v", err)
	}
}

func TestSetSettingsRoundTrip(t *testing.T) {
	env := testEnv(t)
	got, err := SetSettings(env, &SettingsInput{Patterns: []string{"ai/*", "tmp/*"}, Rebuildable: []string{}})
	if err != nil {
		t.Fatal(err)
	}
	// Mảng rỗng là lựa chọn của người dùng, đọc lại vẫn rỗng chứ không về mặc định.
	if !slices.Equal(got.Patterns, []string{"ai/*", "tmp/*"}) || len(got.Rebuildable) != 0 || got.Rebuildable == nil {
		t.Fatalf("%+v", got)
	}
	again, _ := Settings(env)
	if !slices.Equal(again.Patterns, got.Patterns) || len(again.Rebuildable) != 0 {
		t.Fatalf("đọc lại: %+v", again)
	}
	if !slices.Contains(again.Defaults.Rebuildable, "node_modules") {
		t.Fatalf("mặc định phải giữ: %+v", again.Defaults)
	}
}

func TestSettingsCorruptFileKept(t *testing.T) {
	env := testEnv(t)
	path := SettingsPath(env.ConfigDir)
	if err := os.WriteFile(path, []byte("{hỏng"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, _ := Settings(env)
	if !slices.Equal(s.Patterns, DefaultPatterns()) {
		t.Fatalf("%+v", s)
	}
	if b, _ := os.ReadFile(path); string(b) != "{hỏng" {
		t.Fatalf("file hỏng bị ghi đè: %q", b)
	}
}

func TestSetSettingsInvalid(t *testing.T) {
	many := make([]string, 51)
	for i := range many {
		many[i] = "ai/*"
	}
	ok := []string{"node_modules"}
	cases := map[string]*SettingsInput{
		"nil":              nil,
		"thiếu patterns":   {Rebuildable: ok},
		"thiếu rebuild":    {Patterns: []string{"ai/*"}},
		"mục rỗng":         {Patterns: []string{" "}, Rebuildable: ok},
		"quá nhiều":        {Patterns: many, Rebuildable: ok},
		"quá dài":          {Patterns: []string{strings.Repeat("a", 201)}, Rebuildable: ok},
		"ký tự điều khiển": {Patterns: []string{"ai/\n*"}, Rebuildable: ok},
		"có dấu /":         {Patterns: ok, Rebuildable: []string{"apps/web/node_modules"}},
		"có dấu \\":        {Patterns: ok, Rebuildable: []string{`a\b`}},
		"..":               {Patterns: ok, Rebuildable: []string{".."}},
	}
	for name, in := range cases {
		env := testEnv(t)
		got, err := SetSettings(env, in)
		if got != nil || err == nil || err.Code != CodeInvalidSettings || err.Detail == "" {
			t.Errorf("%s: %+v %+v", name, got, err)
		}
		if _, serr := os.Stat(SettingsPath(env.ConfigDir)); !os.IsNotExist(serr) {
			t.Errorf("%s: lỗi mà vẫn ghi file", name)
		}
	}
}
