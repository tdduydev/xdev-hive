// Package procattr tạo tiến trình con không bật cửa sổ console. Worker chạy dưới app desktop hay tác vụ nền không có
// console riêng, nên Windows cấp cho mỗi lệnh console con (git, claude, docker, cmd…) một cửa sổ mới nếu không đặt cờ.
package procattr

import (
	"context"
	"os/exec"
)

// Command như exec.Command, đã gọi Hide.
func Command(name string, arg ...string) *exec.Cmd {
	cmd := exec.Command(name, arg...) // procattr:allow
	Hide(cmd)
	return cmd
}

// CommandContext như exec.CommandContext, đã gọi Hide.
func CommandContext(ctx context.Context, name string, arg ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, arg...) // procattr:allow
	Hide(cmd)
	return cmd
}
