package main

import (
	"strings"

	"rsc.io/qr"
)

// qrQuiet là viền sáng quanh mã (tính bằng ô). Chuẩn đòi 4 ô, nhưng ứng dụng camera đọc được với 2 và mã vừa màn hình
// terminal 80x24 hơn.
const qrQuiet = 2

// renderQR vẽ mã QR bằng nửa khối Unicode, mỗi dòng chữ là hai hàng ô. color đặt chữ trắng nền đen để mã đọc được trên
// cả terminal nền sáng (không có màu thì ô sáng là ký tự khối, chỉ đúng trên terminal nền tối, kiểu phổ biến).
func renderQR(text string, color bool) (string, error) {
	code, err := qr.Encode(text, qr.L)
	if err != nil {
		return "", err
	}
	light := func(x, y int) bool { return !code.Black(x, y) }
	var b strings.Builder
	for y := -qrQuiet; y < code.Size+qrQuiet; y += 2 {
		if color {
			b.WriteString("\x1b[97;40m")
		}
		for x := -qrQuiet; x < code.Size+qrQuiet; x++ {
			top, bottom := light(x, y), light(x, y+1)
			switch {
			case top && bottom:
				b.WriteString("█")
			case top:
				b.WriteString("▀")
			case bottom:
				b.WriteString("▄")
			default:
				b.WriteByte(' ')
			}
		}
		if color {
			b.WriteString("\x1b[0m")
		}
		b.WriteByte('\n')
	}
	return b.String(), nil
}
