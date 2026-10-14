package optimizer

import (
	"bytes"
	"encoding/json"
	"fmt"
	"runtime"
	"slices"
	"sort"
	"strconv"
	"strings"
)

// parseSettings đọc settings.json thành object có thứ tự. File chưa có hay rỗng là object rỗng.
func parseSettings(old snapshot) (*object, jsonStyle, error) {
	if !old.exists || len(bytes.TrimSpace(old.data)) == 0 {
		return newObject(), jsonStyle{indent: "  ", newline: true}, nil
	}
	v, err := parseJSON(old.data)
	if err != nil {
		return nil, jsonStyle{}, fmt.Errorf("%w: settings.json: %v", ErrInvalidConfig, err)
	}
	root, ok := v.(*object)
	if !ok {
		return nil, jsonStyle{}, fmt.Errorf("%w: settings.json không phải object JSON", ErrInvalidConfig)
	}
	return root, styleOf(old.data), nil
}

// childObject lấy root[key] là object. Có mà không phải object thì là file hỏng theo cách Claude Code không đọc được,
// Hive không sửa.
func childObject(root *object, key string) (*object, bool, error) {
	v, ok := root.get(key)
	if !ok {
		return nil, false, nil
	}
	o, isObj := v.(*object)
	if !isObj {
		return nil, true, fmt.Errorf("%w: settings.json: %q không phải object", ErrInvalidConfig, key)
	}
	return o, true, nil
}

func (o *Optimizer) enableClaude(old snapshot, prev, entry *Entry, preset Preset) ([]byte, []string, []Warning, error) {
	root, style, err := parseSettings(old)
	if err != nil {
		return nil, nil, nil, err
	}
	if prev != nil {
		// Đổi mức: gỡ phần của mức cũ rồi áp mức mới. Khoá người dùng đã đổi vẫn ở lại và được báo là "người dùng đặt"
		// ở dưới.
		if _, _, err := undoClaude(root, prev); err != nil {
			return nil, nil, nil, err
		}
		entry.CreatedEnv, entry.CreatedHooks = prev.CreatedEnv, prev.CreatedHooks
		entry.CreatedEvents = slices.Clone(prev.CreatedEvents)
	}
	var added []string
	var warnings []Warning

	if len(preset.Env) > 0 {
		env, ok, err := childObject(root, "env")
		if err != nil {
			return nil, nil, nil, err
		}
		if !ok {
			env = newObject()
			root.set("env", env)
			entry.CreatedEnv = true
		}
		keys := make([]string, 0, len(preset.Env))
		for k := range preset.Env {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if cur, ok := env.get(k); ok {
				entry.UserSet = append(entry.UserSet, k)
				warnings = append(warnings, Warning{Key: "env." + k, Kind: "user_set",
					Message: fmt.Sprintf("env.%s do người dùng đặt (%s), giữ nguyên", k, compactJSON(cur))})
				continue
			}
			env.set(k, preset.Env[k])
			entry.Env = append(entry.Env, KeyValue{Key: k, Value: preset.Env[k]})
			added = append(added, "env."+k)
		}
	}

	if len(preset.Hooks) > 0 {
		hooks, ok, err := childObject(root, "hooks")
		if err != nil {
			return nil, nil, nil, err
		}
		if !ok {
			hooks = newObject()
			root.set("hooks", hooks)
			entry.CreatedHooks = true
		}
		for _, h := range preset.Hooks {
			inner, ok := o.hookJSON(h, preset.ShellHooks)
			if !ok {
				warnings = append(warnings, Warning{Key: "hooks." + h.Event, Kind: "skipped",
					Message: "Windows cần Claude Code chạy được hook dạng exec, bỏ hook " + strings.Join(h.Args, " ")})
				continue
			}
			list, err := eventList(hooks, h.Event)
			if err != nil {
				return nil, nil, nil, err
			}
			if _, exists := hooks.get(h.Event); !exists && !slices.Contains(entry.CreatedEvents, h.Event) {
				entry.CreatedEvents = append(entry.CreatedEvents, h.Event)
			}
			raw := compactJSON(inner)
			if containsHook(list, raw) {
				continue
			}
			group := newObject()
			if h.Matcher != "" {
				group.set("matcher", h.Matcher)
			}
			group.set("hooks", []any{inner})
			hooks.set(h.Event, append(list, group))
			entry.Hooks = append(entry.Hooks, HookRecord{Event: h.Event, Matcher: h.Matcher, Hook: raw})
			added = append(added, "hooks."+h.Event)
		}
		if hooks.empty() && entry.CreatedHooks {
			root.del("hooks")
		}
	}
	return encodeJSON(root, style), added, warnings, nil
}

func eventList(hooks *object, event string) ([]any, error) {
	v, ok := hooks.get(event)
	if !ok {
		return nil, nil
	}
	list, isList := v.([]any)
	if !isList {
		return nil, fmt.Errorf("%w: settings.json: hooks.%s không phải mảng", ErrInvalidConfig, event)
	}
	return list, nil
}

// innerHooks là các hook trong một nhóm {matcher, hooks: [...]}.
func innerHooks(group any) ([]any, *object) {
	g, ok := group.(*object)
	if !ok {
		return nil, nil
	}
	v, _ := g.get("hooks")
	list, _ := v.([]any)
	return list, g
}

func containsHook(list []any, raw string) bool {
	for _, group := range list {
		inner, _ := innerHooks(group)
		for _, h := range inner {
			if compactJSON(h) == raw {
				return true
			}
		}
	}
	return false
}

// hookJSON dựng một hook của Claude Code. Dạng exec (command + args) không qua shell nên đường dẫn có dấu cách hay
// Windows không cần bọc. Dạng shell cho CLI cũ kiểm file trước khi chạy: app bị gỡ thì hook thoát 0, phiên vẫn chạy.
func (o *Optimizer) hookJSON(h Hook, shell bool) (*object, bool) {
	cmd := h.Command
	if cmd == "" {
		cmd = o.LinkPath()
	}
	timeout := h.Timeout
	if timeout <= 0 {
		timeout = defaultHookTimeout
	}
	inner := newObject()
	inner.set("type", "command")
	if shell {
		if runtime.GOOS == "windows" {
			return nil, false
		}
		line := shellQuote(cmd)
		for _, a := range h.Args {
			line += " " + shellQuote(a)
		}
		if h.Command == "" {
			line = "[ -x " + shellQuote(cmd) + " ] && exec " + line + " || exit 0"
		}
		inner.set("command", line)
	} else {
		inner.set("command", cmd)
		args := make([]any, len(h.Args))
		for i, a := range h.Args {
			args[i] = a
		}
		inner.set("args", args)
	}
	inner.set("timeout", json.Number(strconv.Itoa(timeout)))
	return inner, true
}

func shellQuote(s string) string {
	if s != "" && strings.Trim(s, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./=") == "" {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// isHiveHook nhận ra hook cục bộ của Hive bằng tên hive-worker và đối số --local, không dựa vào vị trí trong mảng:
// người dùng hay CLI có thể đã xếp lại.
func isHiveHook(h any) bool {
	o, ok := h.(*object)
	if !ok {
		return false
	}
	cv, _ := o.get("command")
	cmd, _ := cv.(string)
	av, _ := o.get("args")
	args, _ := av.([]any)
	if args != nil {
		base := cmd[strings.LastIndexAny(cmd, `/\`)+1:]
		base = strings.TrimSuffix(strings.ToLower(base), ".exe")
		return base == "hive-worker" && slices.Contains(args, any("--local"))
	}
	return strings.Contains(cmd, "hive-worker") && strings.Contains(cmd, " --local")
}

// undoClaude gỡ phần Hive đã thêm khỏi root. entry nil (manifest mất) thì chỉ gỡ được hook nhận ra bằng dấu.
func undoClaude(root *object, entry *Entry) ([]string, []Warning, error) {
	var removed []string
	var warnings []Warning
	if entry != nil && len(entry.Env) > 0 {
		env, _, err := childObject(root, "env")
		if err != nil {
			return nil, nil, err
		}
		for _, kv := range entry.Env {
			var cur any
			ok := false
			if env != nil {
				cur, ok = env.get(kv.Key)
			}
			switch {
			case !ok:
				warnings = append(warnings, Warning{Key: "env." + kv.Key, Kind: "user_removed",
					Message: fmt.Sprintf("env.%s đã bị người dùng xoá", kv.Key)})
			case cur == any(kv.Value):
				env.del(kv.Key)
				removed = append(removed, "env."+kv.Key)
			default:
				warnings = append(warnings, Warning{Key: "env." + kv.Key, Kind: "user_changed",
					Message: fmt.Sprintf("env.%s người dùng đã đổi thành %s sau khi bật, giữ nguyên", kv.Key, compactJSON(cur))})
			}
		}
		if env != nil && env.empty() && entry.CreatedEnv {
			root.del("env")
		}
	}

	hooks, _, err := childObject(root, "hooks")
	if err != nil {
		return nil, nil, err
	}
	if hooks == nil {
		return removed, warnings, nil
	}
	recorded := map[string]bool{}
	if entry != nil {
		for _, h := range entry.Hooks {
			recorded[h.Event+"\x00"+h.Hook] = false
		}
	}
	anyDropped := false
	for _, event := range slices.Clone(hooks.keys) {
		list, isList := hooks.vals[event].([]any)
		if !isList {
			continue
		}
		var kept []any
		dropped := false
		for _, group := range list {
			inner, g := innerHooks(group)
			if g == nil || len(inner) == 0 {
				kept = append(kept, group)
				continue
			}
			var left []any
			for _, h := range inner {
				key := event + "\x00" + compactJSON(h)
				if _, ours := recorded[key]; ours || isHiveHook(h) {
					recorded[key] = true
					dropped = true
					removed = append(removed, "hooks."+event)
					continue
				}
				left = append(left, h)
			}
			if len(left) == 0 {
				continue
			}
			if len(left) != len(inner) {
				g.set("hooks", left)
			}
			kept = append(kept, group)
		}
		if !dropped {
			continue
		}
		anyDropped = true
		created := entry == nil || slices.Contains(entry.CreatedEvents, event)
		if len(kept) == 0 && created {
			hooks.del(event)
		} else {
			if kept == nil {
				kept = []any{}
			}
			hooks.set(event, kept)
		}
	}
	if entry != nil {
		for _, h := range entry.Hooks {
			if !recorded[h.Event+"\x00"+h.Hook] {
				warnings = append(warnings, Warning{Key: "hooks." + h.Event, Kind: "user_changed",
					Message: fmt.Sprintf("hook %s của Hive đã bị người dùng sửa hoặc xoá", h.Event)})
			}
		}
	}
	if anyDropped && hooks.empty() && (entry == nil || entry.CreatedHooks) {
		root.del("hooks")
	}
	return removed, warnings, nil
}

func disableClaude(old snapshot, entry *Entry) ([]byte, bool, []string, []Warning, error) {
	if !old.exists {
		return nil, false, nil, nil, nil
	}
	root, style, err := parseSettings(old)
	if err != nil {
		return nil, false, nil, nil, err
	}
	removed, warnings, err := undoClaude(root, entry)
	if err != nil {
		return nil, false, nil, nil, err
	}
	if root.empty() && entry != nil && !entry.Existed {
		return nil, true, removed, warnings, nil
	}
	return encodeJSON(root, style), false, removed, warnings, nil
}
