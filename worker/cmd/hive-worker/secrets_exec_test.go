package main

import (
	"bytes"
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestSecretsExecEnvAndArgv(t *testing.T) {
	cfg := secretsEnv(t)
	value := "giá-trị-'\"-$\nnguyên-vẹn"
	if r := secretsCall(t, valueJSON(value), "set", "--config", cfg, "--name", "DEMO_CREDENTIAL"); r.code != 0 {
		t.Fatal("không tạo được bí mật giả")
	}
	if r := secretsCall(t, "", "assign", "--config", cfg, "--name", "DEMO_CREDENTIAL", "--project", appLocalID); r.code != 0 {
		t.Fatal("không gán được")
	}
	old := secretsExecLaunch
	t.Cleanup(func() { secretsExecLaunch = old })
	secretsExecLaunch = func(argv, env []string, stdin io.Reader, stdout, stderr io.Writer) int {
		for _, arg := range argv {
			if strings.Contains(arg, value) {
				t.Fatal("giá trị nằm trong argv")
			}
		}
		cmd := exec.Command(os.Args[0], "-test.run=^TestSecretsExecChild$")
		cmd.Env = append(env, "HIVE_SECRETS_EXEC_CHILD=1")
		cmd.Stdout = stdout
		cmd.Stderr = stderr
		if cmd.Run() != nil {
			return 21
		}
		return 0
	}
	var out, stderr bytes.Buffer
	if code := runSecretsExec([]string{"--config", cfg, "--project", appLocalID, "--kind", "terminal", "--cli", "claude", "--", "claude"}, strings.NewReader(""), &out, &stderr); code != 0 {
		t.Fatal("tiến trình con không nhận đúng env")
	}
	if strings.Contains(out.String(), value) || strings.Contains(stderr.String(), value) {
		t.Fatal("exec in giá trị")
	}
}

func TestSecretsExecChild(t *testing.T) {
	if os.Getenv("HIVE_SECRETS_EXEC_CHILD") != "1" {
		return
	}
	if os.Getenv("DEMO_CREDENTIAL") != "giá-trị-'\"-$\nnguyên-vẹn" {
		os.Exit(22)
	}
}

func TestSecretsExecMissingStoreDoesNotLaunch(t *testing.T) {
	cfg := secretsEnv(t)
	if r := secretsCall(t, valueJSON(fakeValue), "set", "--config", cfg, "--name", "DEMO_CREDENTIAL"); r.code != 0 {
		t.Fatal("không tạo được")
	}
	if r := secretsCall(t, "", "assign", "--config", cfg, "--name", "DEMO_CREDENTIAL", "--project", appLocalID); r.code != 0 {
		t.Fatal("không gán được")
	}
	if secretsStore().Delete("DEMO_CREDENTIAL") != nil {
		t.Fatal("không xoá kho giả")
	}
	old := secretsExecLaunch
	t.Cleanup(func() { secretsExecLaunch = old })
	secretsExecLaunch = func([]string, []string, io.Reader, io.Writer, io.Writer) int {
		t.Fatal("kho thiếu vẫn tạo tiến trình")
		return 0
	}
	var out, stderr bytes.Buffer
	if code := runSecretsExec([]string{"--config", cfg, "--project", appLocalID, "--kind", "terminal", "--", "shell"}, strings.NewReader("\n"), &out, &stderr); code != 78 {
		t.Fatal("sai mã thoát kho lỗi")
	}
}
