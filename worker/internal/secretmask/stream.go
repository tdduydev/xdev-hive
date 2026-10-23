package secretmask

import (
	"io"
	"slices"
	"sync"
)

// Writer che luồng ghi vào w (FR-032). Giá trị có thể bị cắt giữa hai lần ghi, nên đuôi có thể là phần đầu của một dạng
// được giữ lại tới lần ghi sau; Flush nhả nó khi hết luồng. Writer cũng nhớ byte thô vừa gửi (tail) để dạng bắt đầu
// trong phần đã gửi và kết thúc ở lần sau vẫn bị che phần còn lại.
type Writer struct {
	m     *Masker
	w     io.Writer
	mu    sync.Mutex
	held  []byte
	tail  []byte
	found []int
}

// Writer bọc w. Bên gọi phải Flush khi hết luồng, nếu không đuôi đang giữ bị mất.
func (m *Masker) Writer(w io.Writer) *Writer { return &Writer{m: m, w: w} }

// Write trả len(p) khi ghi được, dù số byte ra w khác đi vì mặt nạ.
func (w *Writer) Write(p []byte) (int, error) {
	if w.m.Empty() {
		return w.w.Write(p)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	buf := append(w.held, p...)
	w.held = nil
	if err := w.emit(buf, true); err != nil {
		return 0, err
	}
	return len(p), nil
}

// Flush nhả phần đang giữ. Gọi được nhiều lần.
func (w *Writer) Flush() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	buf := w.held
	w.held = nil
	if len(buf) == 0 {
		return nil
	}
	return w.emit(buf, false)
}

// Found trả chỉ số các giá trị đã bị che từ đầu luồng (FR-037).
func (w *Writer) Found() []int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return slices.Clone(w.found)
}

// Holding cho terminal biết còn đuôi phải nhả khi không có output mới.
func (w *Writer) Holding() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.held) > 0
}

func (w *Writer) emit(buf []byte, hold bool) error {
	cut := len(buf)
	if hold {
		cut = w.m.holdFrom(buf)
	}
	combined := append(slices.Clone(w.tail), buf...)
	masked, hits := w.m.mark(combined, len(w.tail))
	if len(hits) > 0 {
		w.found = append(w.found, hits...)
		slices.Sort(w.found)
		w.found = slices.Compact(w.found)
	}
	w.held = slices.Clone(buf[cut:])
	out := buf[:cut]
	if slices.Contains(masked[:cut], true) {
		out = w.m.render(out, masked[:cut])
	}
	w.tail = append(w.tail, buf[:cut]...)
	if n := w.m.maxLen - 1; len(w.tail) > n {
		w.tail = slices.Clone(w.tail[len(w.tail)-n:])
	}
	if len(out) == 0 {
		return nil
	}
	_, err := w.w.Write(out)
	return err
}
