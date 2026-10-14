//go:build windows

package pty

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Supported: Windows có ConPTY (10 1809 trở lên).
var Supported = windows.NewLazySystemDLL("kernel32.dll").NewProc("CreatePseudoConsole").Find() == nil

// conpty giữ pseudo console, hai đầu pipe phía worker và job chứa cây tiến trình.
type conpty struct {
	in  *os.File // phím: worker ghi, console đọc
	out *os.File // output: console ghi, worker đọc
	cmd *exec.Cmd

	// mu giữ hpc và job: Resize hay KillGroup sau khi đã đóng sẽ dùng handle đã giải phóng (HPCON là con trỏ).
	mu     sync.Mutex
	hpc    windows.Handle
	job    windows.Handle
	closed bool
}

// sessions tra conpty theo cmd cho HangupGroup và KillGroup, vốn chỉ nhận *exec.Cmd như bản Unix.
var sessions sync.Map

// Start chạy cmd trong ConPTY cỡ cols×rows. syscall.SysProcAttr không có chỗ cho pseudo console nên tự gọi
// CreateProcess rồi gán cmd.Process để cmd.Wait dùng được như sau cmd.Start.
func Start(cmd *exec.Cmd, cols, rows int) (Terminal, error) {
	if !Supported {
		return nil, ErrUnsupported
	}
	if cmd.Err != nil {
		return nil, cmd.Err
	}
	if cmd.Process != nil {
		return nil, errors.New("pty: cmd đã chạy")
	}
	var ptyIn, inW, outR, ptyOut windows.Handle
	if err := windows.CreatePipe(&ptyIn, &inW, nil, 0); err != nil {
		return nil, fmt.Errorf("tạo pipe nhập: %w", err)
	}
	if err := windows.CreatePipe(&outR, &ptyOut, nil, 0); err != nil {
		closeHandles(ptyIn, inW)
		return nil, fmt.Errorf("tạo pipe xuất: %w", err)
	}
	t := &conpty{in: os.NewFile(uintptr(inW), "conpty-in"), out: os.NewFile(uintptr(outR), "conpty-out"), cmd: cmd}
	// Console giữ bản sao của hai đầu này; đóng bản của worker để output EOF được khi console đóng.
	defer closeHandles(ptyIn, ptyOut)
	if err := windows.CreatePseudoConsole(coord(cols, rows), ptyIn, ptyOut, 0, &t.hpc); err != nil {
		_ = t.in.Close()
		_ = t.out.Close()
		return nil, fmt.Errorf("tạo ConPTY: %w", err)
	}
	pi, err := t.spawn(cmd)
	if err != nil {
		_ = t.Close()
		return nil, err
	}
	// Job có KILL_ON_JOB_CLOSE: tiến trình con của CLI (lệnh Bash của agent, máy chủ callback) vào cùng job, KillGroup
	// dừng được cả cây như nhóm tiến trình trên Unix. Không tạo được job thì vẫn chạy, KillGroup chỉ dừng tiến trình chính.
	t.job = newKillJob()
	if t.job != 0 && windows.AssignProcessToJobObject(t.job, pi.Process) != nil {
		_ = windows.CloseHandle(t.job)
		t.job = 0
	}
	if _, err := windows.ResumeThread(pi.Thread); err != nil {
		_ = windows.TerminateProcess(pi.Process, 1)
		closeHandles(pi.Thread, pi.Process)
		_ = t.Close()
		return nil, fmt.Errorf("chạy tiến trình: %w", err)
	}
	_ = windows.CloseHandle(pi.Thread)
	p, err := os.FindProcess(int(pi.ProcessId))
	if err != nil {
		_ = windows.TerminateProcess(pi.Process, 1)
		_ = windows.CloseHandle(pi.Process)
		_ = t.Close()
		return nil, err
	}
	cmd.Process = p
	sessions.Store(cmd, t)
	go func() {
		// ConPTY không tự đóng output khi tiến trình thoát; đóng console để Read nhận EOF như PTY Unix khi hết người giữ.
		_, _ = windows.WaitForSingleObject(pi.Process, windows.INFINITE)
		_ = windows.CloseHandle(pi.Process)
		t.closeConsole()
	}()
	return t, nil
}

func (t *conpty) spawn(cmd *exec.Cmd) (*windows.ProcessInformation, error) {
	attrs, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return nil, err
	}
	defer attrs.Delete()
	// Giá trị của thuộc tính là chính HPCON chứ không phải con trỏ tới nó; đọc qua con trỏ để go vet không coi là đổi
	// uintptr sang unsafe.Pointer sai cách.
	if err := attrs.Update(windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, *(*unsafe.Pointer)(unsafe.Pointer(&t.hpc)),
		unsafe.Sizeof(t.hpc)); err != nil {
		return nil, err
	}
	si := &windows.StartupInfoEx{ProcThreadAttributeList: attrs.List()}
	si.Cb = uint32(unsafe.Sizeof(*si))
	// Worker chạy nền thường có stdio chuyển vào file log; không đặt STARTF_USESTDHANDLES thì tiến trình con nhận các
	// handle đó và ghi ra log thay vì vào ConPTY.
	si.Flags = windows.STARTF_USESTDHANDLES
	si.StdInput, si.StdOutput, si.StdErr = windows.InvalidHandle, windows.InvalidHandle, windows.InvalidHandle

	app, err := windows.UTF16PtrFromString(cmd.Path)
	if err != nil {
		return nil, err
	}
	line := windows.ComposeCommandLine(cmd.Args)
	if cmd.SysProcAttr != nil && cmd.SysProcAttr.CmdLine != "" {
		line = cmd.SysProcAttr.CmdLine
	}
	cmdLine, err := windows.UTF16PtrFromString(line)
	if err != nil {
		return nil, err
	}
	var dir *uint16
	if cmd.Dir != "" {
		if dir, err = windows.UTF16PtrFromString(cmd.Dir); err != nil {
			return nil, err
		}
	}
	env, err := envBlock(cmd.Environ())
	if err != nil {
		return nil, err
	}
	pi := new(windows.ProcessInformation)
	flags := uint32(windows.EXTENDED_STARTUPINFO_PRESENT | windows.CREATE_UNICODE_ENVIRONMENT | windows.CREATE_SUSPENDED)
	if err := windows.CreateProcess(app, cmdLine, nil, nil, false, flags, &env[0], dir, &si.StartupInfo, pi); err != nil {
		return nil, &os.PathError{Op: "CreateProcess", Path: cmd.Path, Err: err}
	}
	return pi, nil
}

// envBlock là khối biến môi trường UTF-16 "K=V\0...\0\0" CreateProcess cần.
func envBlock(env []string) ([]uint16, error) {
	var b []uint16
	for _, kv := range env {
		if strings.IndexByte(kv, 0) >= 0 {
			return nil, fmt.Errorf("biến môi trường có ký tự NUL: %q", kv)
		}
		b = append(b, windows.StringToUTF16(kv)...)
	}
	if len(b) == 0 {
		b = append(b, 0)
	}
	return append(b, 0), nil
}

func newKillJob() windows.Handle {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		_ = windows.CloseHandle(job)
		return 0
	}
	return job
}

func coord(cols, rows int) windows.Coord {
	clamp := func(v int) int16 { return int16(min(max(v, 1), 0x7fff)) }
	return windows.Coord{X: clamp(cols), Y: clamp(rows)}
}

func closeHandles(hs ...windows.Handle) {
	for _, h := range hs {
		if h != 0 {
			_ = windows.CloseHandle(h)
		}
	}
}

func (t *conpty) Read(p []byte) (int, error)  { return t.out.Read(p) }
func (t *conpty) Write(p []byte) (int, error) { return t.in.Write(p) }

func (t *conpty) Resize(cols, rows int) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return os.ErrClosed
	}
	return windows.ResizePseudoConsole(t.hpc, coord(cols, rows))
}

// closeConsole đóng pseudo console một lần: console báo CTRL_CLOSE_EVENT cho các tiến trình còn gắn rồi đóng output.
// Windows cũ chặn ClosePseudoConsole tới khi output được đọc hết, nên chỉ gọi khi đang có người đọc hoặc đã đóng out.
func (t *conpty) closeConsole() {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return
	}
	t.closed = true
	t.mu.Unlock()
	windows.ClosePseudoConsole(t.hpc)
}

// Close đóng đầu đọc trước (huỷ Read đang chờ, để ClosePseudoConsole không chờ ai đọc), rồi console, rồi job: job có
// KILL_ON_JOB_CLOSE nên tiến trình còn sót trong cây cũng dừng.
func (t *conpty) Close() error {
	err := t.out.Close()
	_ = t.in.Close()
	t.closeConsole()
	if t.cmd != nil {
		sessions.CompareAndDelete(t.cmd, t)
	}
	t.mu.Lock()
	if t.job != 0 {
		_ = windows.CloseHandle(t.job)
		t.job = 0
	}
	t.mu.Unlock()
	return err
}

func (t *conpty) terminateJob() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.job != 0 && windows.TerminateJobObject(t.job, 1) == nil
}

// HangupGroup đóng pseudo console, như đóng cửa sổ terminal: tiến trình nhận CTRL_CLOSE_EVENT để tự dọn rồi thoát.
func HangupGroup(cmd *exec.Cmd) {
	if v, ok := sessions.Load(cmd); ok {
		v.(*conpty).closeConsole()
		return
	}
	KillGroup(cmd)
}

// KillGroup dừng cả cây tiến trình trong job của cmd; không có job thì dừng tiến trình chính.
func KillGroup(cmd *exec.Cmd) {
	if v, ok := sessions.Load(cmd); ok && v.(*conpty).terminateJob() {
		return
	}
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
