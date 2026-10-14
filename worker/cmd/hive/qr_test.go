package main

import (
	"strings"
	"testing"

	"rsc.io/qr"
)

// Đọc ngược hình đã vẽ thành lưới ô và so với mã gốc: mỗi ký tự là hai ô chồng nhau, có viền sáng qrQuiet ô.
func TestRenderQR(t *testing.T) {
	text := "https://hive.example.vn/remote/pair?m=mac-lan&p=pair-abc#s=" + strings.Repeat("x", 43)
	art, err := renderQR(text, false)
	if err != nil {
		t.Fatal(err)
	}
	code, _ := qr.Encode(text, qr.L)
	lines := strings.Split(strings.TrimSuffix(art, "\n"), "\n")
	side := code.Size + 2*qrQuiet
	if len(lines) != (side+1)/2 {
		t.Fatalf("%d dòng, cần %d", len(lines), (side+1)/2)
	}
	for row, line := range lines {
		cells := []rune(line)
		if len(cells) != side {
			t.Fatalf("dòng %d dài %d, cần %d", row, len(cells), side)
		}
		for col, ch := range cells {
			x, y := col-qrQuiet, 2*row-qrQuiet
			top, bottom := ch == '█' || ch == '▀', ch == '█' || ch == '▄'
			if top != !code.Black(x, y) || bottom != !code.Black(x, y+1) {
				t.Fatalf("ô (%d,%d) vẽ sai: %q", x, y, ch)
			}
		}
	}
	colored, _ := renderQR(text, true)
	if !strings.HasPrefix(colored, "\x1b[97;40m") || !strings.Contains(colored, "\x1b[0m\n") {
		t.Fatal("thiếu màu chữ trắng nền đen")
	}
}
