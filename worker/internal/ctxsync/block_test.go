package ctxsync

import (
	"strings"
	"testing"
)

func TestRenderParseRoundTrip(t *testing.T) {
	block := RenderBlock("Lệnh test: go test ./...\n", []HubItem{{Content: "Dùng pnpm"}, {Content: "Hai\ndòng"}}, BlockOptions{ImportAgents: true})
	blocks, err := ParseBlocks("# Của tôi\n\n" + block + "\nsau\n")
	if err != nil || len(blocks) != 1 {
		t.Fatalf("blocks = %+v, err = %v", blocks, err)
	}
	b := blocks[0]
	if b.Edited() {
		t.Fatalf("khối mới mà Edited: sha=%s actual=%s", b.Sha, b.Actual)
	}
	want := "@AGENTS.md\n\n## Tại máy\n\nLệnh test: go test ./...\n\n## Từ hub\n\n- Dùng pnpm\n- Hai\n  dòng"
	if b.Body != want {
		t.Fatalf("body = %q\nwant %q", b.Body, want)
	}
	if !strings.HasPrefix(block, "<!-- xdev-hive:context v1 sha=") || !strings.HasSuffix(block, closeMarker) {
		t.Fatalf("block = %q", block)
	}
	if got := LocalSection(b.Body); got != "Lệnh test: go test ./..." {
		t.Fatalf("LocalSection = %q", got)
	}
}

func TestParseDetectsEdit(t *testing.T) {
	block := RenderBlock("a", nil, BlockOptions{})
	edited := strings.Replace(block, "\na\n", "\nb\n", 1)
	blocks, err := ParseBlocks(edited)
	if err != nil || len(blocks) != 1 || !blocks[0].Edited() {
		t.Fatalf("blocks = %+v, err = %v", blocks, err)
	}
}

func TestParseEmptyBody(t *testing.T) {
	block := RenderBlock("", nil, BlockOptions{})
	blocks, err := ParseBlocks(block)
	if err != nil || len(blocks) != 1 || blocks[0].Body != "" || blocks[0].Edited() {
		t.Fatalf("blocks = %+v, err = %v", blocks, err)
	}
}

func TestParseErrors(t *testing.T) {
	open := "<!-- xdev-hive:context v1 sha=0123456789ab -->"
	cases := map[string]string{
		"không đóng":  "x\n" + open + "\nabc\n",
		"đóng lạc":    "x\n" + closeMarker + "\n",
		"mở hai lần":  open + "\n" + open + "\n" + closeMarker + "\n",
		"dấu sai":     "<!-- xdev-hive:context v2 sha=zz -->\n",
		"sha quá dài": "<!-- xdev-hive:context v1 sha=0123456789abcd -->\n" + closeMarker,
	}
	for name, text := range cases {
		if _, err := ParseBlocks(text); err == nil {
			t.Errorf("%s: muốn lỗi", name)
		}
	}
	two := RenderBlock("a", nil, BlockOptions{}) + "\n\n" + RenderBlock("b", nil, BlockOptions{})
	blocks, err := ParseBlocks(two)
	if err != nil || len(blocks) != 2 || blocks[1].Line != 7 {
		t.Fatalf("blocks = %+v, err = %v", blocks, err)
	}
}

func TestSpliceKeepsBytesOutsideBlock(t *testing.T) {
	cases := map[string]string{
		"rỗng":              "",
		"có xuống dòng":     "# Của tôi\nchữ\n",
		"không xuống dòng":  "# Của tôi\nchữ",
		"CRLF":              "# Của tôi\r\nchữ\r\n",
		"CRLF không cuối":   "# Của tôi\r\nchữ",
		"BOM":               bom + "# Của tôi\n",
		"chỉ BOM":           bom,
		"dòng trống cuối":   "a\n\n\n",
		"chú thích HTML":    "<!-- của người dùng -->\n",
		"giống dấu nửa vời": "xdev-hive:context là tên khối\n",
	}
	for name, orig := range cases {
		eol := detectEOL(orig)
		withBlock, lead := appendBlock(orig, RenderBlock("một", nil, BlockOptions{EOL: eol}), eol)
		blocks, err := ParseBlocks(withBlock)
		if err != nil || len(blocks) != 1 || blocks[0].Edited() {
			t.Fatalf("%s: blocks = %+v, err = %v", name, blocks, err)
		}
		if eol == "\r\n" && strings.Contains(strings.ReplaceAll(withBlock, "\r\n", ""), "\n") {
			t.Fatalf("%s: trộn LF vào file CRLF: %q", name, withBlock)
		}
		b := blocks[0]
		updated := withBlock[:b.Start] + RenderBlock("hai\nba", nil, BlockOptions{EOL: eol}) + withBlock[b.End:]
		blocks, err = ParseBlocks(updated)
		if err != nil || len(blocks) != 1 {
			t.Fatalf("%s: sau khi sửa: %+v, %v", name, blocks, err)
		}
		if updated[:blocks[0].Start] != withBlock[:b.Start] || updated[blocks[0].End:] != withBlock[b.End:] {
			t.Fatalf("%s: byte ngoài khối đổi", name)
		}
		if got := removeBlock(updated, blocks[0], lead); got != orig {
			t.Fatalf("%s: gỡ khối = %q, muốn %q", name, got, orig)
		}
	}
}

func TestBlockAtEndWithoutNewline(t *testing.T) {
	text := "đầu\n\n" + RenderBlock("x", nil, BlockOptions{})
	blocks, err := ParseBlocks(text)
	if err != nil || len(blocks) != 1 || blocks[0].End != len(text) {
		t.Fatalf("blocks = %+v, err = %v", blocks, err)
	}
	if got := removeBlock(text, blocks[0], "\n"); got != "đầu\n" {
		t.Fatalf("gỡ = %q", got)
	}
}

func TestBlockAfterBOMOnFirstLine(t *testing.T) {
	text := bom + RenderBlock("x", nil, BlockOptions{}) + "\nsau\n"
	blocks, err := ParseBlocks(text)
	if err != nil || len(blocks) != 1 || blocks[0].Start != len(bom) {
		t.Fatalf("blocks = %+v, err = %v", blocks, err)
	}
}

func TestLocalSection(t *testing.T) {
	cases := map[string]string{
		"## Tại máy\n\nabc\n\n## Từ hub\n\n- x": "abc",
		"## Từ hub\n\n- x":                      "",
		"chữ không có tiêu đề":                  "chữ không có tiêu đề",
		"@AGENTS.md\n\n## Tại máy\n\nabc":       "abc",
	}
	for body, want := range cases {
		if got := LocalSection(body); got != want {
			t.Errorf("LocalSection(%q) = %q, muốn %q", body, got, want)
		}
	}
}
