#!/usr/bin/env python3
# Thêm/sửa một việc trong jobs.json dưới khoá file (nhiều tiến trình cùng ghi làm mất việc).
# Dùng: add-job.py <VIỆC> <worktree> <model> <tier>; tier = heavy|medium|light, model ghi vào jobs.json như đã nhập.
import fcntl
import json
import os
import sys

A = os.path.join(os.path.expanduser(os.environ.get("FLEET_DIR", "~/.xdev-hive/fleet")), "agents")
os.makedirs(A, exist_ok=True)
job, wt, model, tier = sys.argv[1:5]
with open(os.path.join(A, "jobs.lock"), "w") as lk:
    fcntl.flock(lk, fcntl.LOCK_EX)
    p = os.path.join(A, "jobs.json")
    j = json.load(open(p)) if os.path.exists(p) else {}
    j[job] = {"wt": wt, "perf": 0, "status": "queued", "model": model, "effort": "high", "tier": tier}
    with open(p, "w") as f:
        json.dump(j, f, indent=1, ensure_ascii=False)
