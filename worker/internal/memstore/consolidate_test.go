package memstore

import (
	"context"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestConsolidateProposesGroupsWithoutWriting(t *testing.T) {
	root := t.TempDir()
	index := filepath.Join(root, "MEMORY.md")
	a := filepath.Join(root, "deploy.md")
	b := filepath.Join(root, "release.md")
	c := filepath.Join(root, "style.md")
	writeFixture(t, index, "- [Deploy](deploy.md)\n- [Release](release.md)\n- [Style](style.md)\n")
	writeFixture(t, a, "deploy bằng pnpm\n")
	writeFixture(t, b, "release qua nhánh release\ndeploy bằng pnpm\n")
	writeFixture(t, c, "viết comment giải thích vì sao\n")
	answer := `{"merges":[` +
		`{"sources":["01-deploy.md","02-release.md"],"target":"01-deploy.md","reason":"cùng chủ đề phát hành","content":"deploy bằng pnpm\nrelease qua nhánh release\nchạy CI trước\n"},` +
		`{"sources":["02-release.md","03-style.md"],"target":"03-style.md","reason":"x","content":"x"},` +
		`{"sources":["03-style.md"],"target":"03-style.md","reason":"x","content":"x"},` +
		`{"sources":["00-MEMORY.md","03-style.md"],"target":"03-style.md","reason":"x","content":"x"}]}`
	command, dir := fakeClaude(t, answer, false, map[string]int{"input_tokens": 50, "output_tokens": 10})

	got, err := Consolidate(context.Background(), CompressOptions{Command: command, Files: []string{index, a, b, c}}, [][2]string{{a, b}, {a, index}})
	if err != nil {
		t.Fatal(err)
	}
	// Nhóm thứ hai đụng file đã thuộc nhóm đầu, nhóm thứ ba chỉ một file, nhóm cuối có MEMORY.md (không được gửi đi).
	if got.TokensUsed != 60 || len(got.Merges) != 1 || len(got.Warnings) != 3 {
		t.Fatalf("result = %+v", got)
	}
	m := got.Merges[0]
	if !reflect.DeepEqual(m.Sources, []string{a, b}) || m.Target != a || m.Reason != "cùng chủ đề phát hành" {
		t.Fatalf("merge = %+v", m)
	}
	if m.Before != "deploy bằng pnpm\n\n\nrelease qua nhánh release\ndeploy bằng pnpm\n" || !reflect.DeepEqual(m.NewLines, []int{3}) {
		t.Fatalf("before = %q, newLines = %v", m.Before, m.NewLines)
	}
	if readText(t, a) != "deploy bằng pnpm\n" || readText(t, b) != "release qua nhánh release\ndeploy bằng pnpm\n" {
		t.Fatal("consolidate wrote to the real files")
	}
	prompt := readText(t, filepath.Join(dir, "stdin.txt"))
	if strings.Contains(prompt, "MEMORY.md") || !strings.Contains(prompt, "01-deploy.md ~ 02-release.md") {
		t.Fatalf("prompt = %s", prompt)
	}
}

func TestConsolidateNeedsTwoTopicFiles(t *testing.T) {
	root := t.TempDir()
	index := filepath.Join(root, "MEMORY.md")
	a := filepath.Join(root, "deploy.md")
	writeFixture(t, index, "- [Deploy](deploy.md)\n")
	writeFixture(t, a, "deploy\n")
	if _, err := Consolidate(context.Background(), CompressOptions{Command: "claude", Files: []string{index, a}}, nil); err == nil {
		t.Fatal("want error with a single topic file")
	}
}
