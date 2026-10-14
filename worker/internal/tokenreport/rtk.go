package tokenreport

import (
	"context"
	"encoding/json"
	"os/exec"
	"time"
)

// RTKFunc trả JSON của `rtk gain --format json`. Tách ra để test không gọi RTK thật.
type RTKFunc func(ctx context.Context) ([]byte, error)

// execRTK gọi thẳng file chạy, không qua shell, nên chạy được cả trên Windows.
func execRTK(ctx context.Context) ([]byte, error) {
	path, err := exec.LookPath("rtk")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, path, "gain", "--format", "json").Output()
}

// rtkGain trả nil khi không có RTK hoặc output không phải JSON: báo cáo vẫn ra, chỉ thiếu mục này.
func rtkGain(ctx context.Context, fn RTKFunc) json.RawMessage {
	out, err := fn(ctx)
	if err != nil || !json.Valid(out) {
		return nil
	}
	var buf json.RawMessage
	if json.Unmarshal(out, &buf) != nil {
		return nil
	}
	return buf
}
