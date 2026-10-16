package procattr

import (
	"bufio"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

// Lệnh mới tạo thẳng bằng exec.Command lại bật cửa sổ console trên Windows; ngoại lệ có chủ đích ghi `procattr:allow`
// cùng dòng hoặc dòng trên kèm lý do.
func TestEveryCommandGoesThroughProcattr(t *testing.T) {
	root := filepath.Join("..", "..")
	var bad []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "testdata" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		prev := ""
		scanner := bufio.NewScanner(f)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for n := 1; scanner.Scan(); n++ {
			line := scanner.Text()
			direct := strings.Contains(line, "exec.Command(") || strings.Contains(line, "exec.CommandContext(")
			if direct && !strings.Contains(line, "procattr:allow") && !strings.Contains(prev, "procattr:allow") {
				bad = append(bad, filepath.ToSlash(path)+":"+strconv.Itoa(n))
			}
			prev = line
		}
		return scanner.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(bad) > 0 {
		t.Fatalf("dùng procattr.Command/CommandContext thay exec.Command:\n%s", strings.Join(bad, "\n"))
	}
}

func TestCommandRuns(t *testing.T) {
	name, args := "sh", []string{"-c", "echo ok"}
	if runtime.GOOS == "windows" {
		name, args = "cmd.exe", []string{"/C", "echo ok"}
	}
	out, err := Command(name, args...).Output()
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(out)) != "ok" {
		t.Fatalf("stdout = %q", out)
	}
}

func TestHideLeavesOtherSystemsUntouched(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows đặt cờ, xem procattr_windows_test.go")
	}
	if cmd := Command("true"); cmd.SysProcAttr != nil {
		t.Fatalf("SysProcAttr = %+v, muốn nil", cmd.SysProcAttr)
	}
}
