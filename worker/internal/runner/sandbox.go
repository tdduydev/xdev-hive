package runner

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"sort"
	"strconv"
	"strings"
	"time"
)

// SandboxConfig selects the one-shot container runtime used by runner hosts.
type SandboxConfig struct {
	DockerPath   string
	Image        string
	HostID       string
	EgressSocket string
	WorkerBinary string
	AllowRunc    bool
	CPUs         string
	Memory       string
	PIDs         int
}

func (s SandboxConfig) runtime() string {
	if s.AllowRunc {
		return "runc"
	}
	return "runsc"
}

func (s SandboxConfig) normalized() SandboxConfig {
	if s.DockerPath == "" {
		s.DockerPath = "docker"
	}
	if s.Image == "" {
		s.Image = "xdev-hive-runner:latest"
	}
	if s.CPUs == "" {
		s.CPUs = "2"
	}
	if s.Memory == "" {
		s.Memory = "4g"
	}
	if s.PIDs <= 0 {
		s.PIDs = 256
	}
	return s
}

// SandboxRunArgs builds strict container settings; the host worktree is the only writable bind mount.
func SandboxRunArgs(s SandboxConfig, runID, work, repoCache, image string, command []string, env map[string]string, uid, gid string) []string {
	s = s.normalized()
	if image == "" {
		image = s.Image
	}
	args := []string{"run", "--rm", "--name", sandboxName(runID), "--label", "hive.run=" + runID, "--runtime=" + s.runtime(), "--network=none", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=1g", "--mount", "type=bind,src=" + work + ",dst=/workspace", "--workdir=/workspace", "--cpus=" + s.CPUs, "--memory=" + s.Memory, "--pids-limit=" + strconv.Itoa(s.PIDs), "--user", uid + ":" + gid, "--cap-drop=ALL", "--security-opt=no-new-privileges"}
	if repoCache != "" {
		args = append(args, "--mount", "type=bind,src="+repoCache+",dst="+repoCache)
	}
	if s.HostID != "" {
		args = append(args, "--label", "hive.host="+s.HostID)
	}
	if s.EgressSocket != "" && s.WorkerBinary != "" {
		args = append(args, "--mount", "type=bind,src="+s.EgressSocket+",dst=/run/hive/egress.sock", "--mount", "type=bind,src="+s.WorkerBinary+",dst=/usr/local/bin/hive-worker,readonly")
	}
	containerEnv := sandboxEnv(env, s)
	for _, key := range sortedKeys(containerEnv) {
		args = append(args, "--env", key)
	}
	args = append(args, image)
	if s.EgressSocket != "" && s.WorkerBinary != "" {
		args = append(args, "/usr/local/bin/hive-worker", "sandbox-init", "--socket", "/run/hive/egress.sock", "--")
	}
	return append(args, command...)
}

func (r Runner) sandboxCommand(job Job, work string, command []string) (*exec.Cmd, error) {
	if r.Sandbox == nil {
		return nil, errors.New("sandbox chưa được cấu hình")
	}
	s := r.Sandbox.normalized()
	if s.AllowRunc {
		fmt.Fprintf(os.Stderr, "CẢNH BÁO: run %s đang dùng runc, không có cách ly gVisor.\n", job.RunID)
	}
	uid, gid, err := hostIdentity()
	if err != nil {
		return nil, err
	}
	env := sandboxCLIEnv(job)
	args := SandboxRunArgs(s, job.RunID, work, job.repoCache, job.EnvironmentImage, command, env, uid, gid)
	cmd := exec.Command(s.DockerPath, args...)
	cmd.Dir = work
	cmd.Env = mergeEnv(os.Environ(), sandboxEnv(env, s))
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd, nil
}

func (r Runner) runSandboxSetup(ctx context.Context, job Job, work string) error {
	s := r.Sandbox.normalized()
	uid, gid, err := hostIdentity()
	if err != nil {
		return err
	}
	args := SandboxRunArgs(s, job.RunID, work, job.repoCache, job.EnvironmentImage, []string{"sh", "-lc", job.SetupScript}, mergeMap(job.Env, job.SetupEnv), uid, gid)
	cmd := exec.CommandContext(ctx, s.DockerPath, args...)
	cmd.Env = mergeEnv(os.Environ(), sandboxEnv(mergeMap(job.Env, job.SetupEnv), s))
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("chạy setup trong container: %w", err)
	}
	return nil
}

func sandboxEnv(env map[string]string, s SandboxConfig) map[string]string {
	containerEnv := map[string]string{"HOME": "/tmp", "TMPDIR": "/tmp"}
	for key, value := range env {
		containerEnv[key] = value
	}
	if s.EgressSocket != "" && s.WorkerBinary != "" {
		containerEnv["HTTP_PROXY"] = "http://127.0.0.1:3128"
		containerEnv["HTTPS_PROXY"] = "http://127.0.0.1:3128"
		containerEnv["http_proxy"] = containerEnv["HTTP_PROXY"]
		containerEnv["https_proxy"] = containerEnv["HTTPS_PROXY"]
		containerEnv["NO_PROXY"] = "127.0.0.1,localhost"
		containerEnv["no_proxy"] = containerEnv["NO_PROXY"]
	}
	return containerEnv
}

func sandboxCLIEnv(job Job) map[string]string {
	env := map[string]string{}
	for k, v := range job.Env {
		env[k] = v
	}
	// Host credentials are read only from explicit runner-host variables; personal CLI config is never mounted.
	credentials := map[string]string{
		"claude": "ANTHROPIC_API_KEY", "codex": "OPENAI_API_KEY", "gemini": "GEMINI_API_KEY",
	}
	if key := credentials[job.CLI]; key != "" {
		if value := os.Getenv("HIVE_HOST_" + strings.ToUpper(job.CLI) + "_API_KEY"); value != "" {
			env[key] = value
		}
	}
	return env
}

func (r Runner) removeSandbox(ctx context.Context, runID string) {
	if r.Sandbox == nil {
		return
	}
	s := r.Sandbox.normalized()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, s.DockerPath, "rm", "--force", sandboxName(runID))
	_ = cmd.Run()
}

// ReapSandboxOrphans removes interrupted run containers left by a killed runner host.
func ReapSandboxOrphans(ctx context.Context, s SandboxConfig) error {
	s = s.normalized()
	filter := "label=hive.run"
	if s.HostID != "" {
		filter = "label=hive.host=" + s.HostID
	}
	cmd := exec.CommandContext(ctx, s.DockerPath, "ps", "--all", "--quiet", "--filter", filter)
	out, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("liệt kê container cũ: %w", err)
	}
	ids := strings.Fields(string(out))
	if len(ids) == 0 {
		return nil
	}
	args := append([]string{"rm", "--force"}, ids...)
	if err := exec.CommandContext(ctx, s.DockerPath, args...).Run(); err != nil {
		return fmt.Errorf("dọn container cũ: %w", err)
	}
	return nil
}

func hostIdentity() (string, string, error) {
	current, err := user.Current()
	if err != nil {
		return "", "", err
	}
	uid, err := strconv.Atoi(current.Uid)
	if err != nil || uid == 0 {
		return "", "", errors.New("runner host phải chạy bằng người dùng không phải root")
	}
	if _, err := strconv.Atoi(current.Gid); err != nil {
		return "", "", fmt.Errorf("GID của host không hợp lệ: %w", err)
	}
	return current.Uid, current.Gid, nil
}

func sandboxName(runID string) string {
	name := "hive-" + safeName(runID)
	if len(name) > 60 {
		name = name[:60]
	}
	return name
}

func sortedKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
