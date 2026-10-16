#!/usr/bin/env python3
"""Điều phối agent theo quota: mỗi chu kỳ đo quota phiên 5 giờ và tuần của từng tài khoản (Claude và Codex), tính số agent
mỗi tài khoản chịu được tới lúc reset, chuyển agent khỏi tài khoản sắp cạn và khởi động việc trong hàng trên tài khoản còn chỗ.

jobs.json: {"<việc>": {"wt": "<worktree>", "perf": 0|1, "account": "claude-N"|"codex-N"|null, "status": "running"|"queued"|"done",
                       "model": ..., "effort": ..., "tier": "heavy"|"medium"|"light" (tuỳ chọn)}}

Chia việc theo tier: heavy chỉ Claude Opus; medium Claude Sonnet hoặc Codex (effort high); light ưu tiên Codex (effort medium).
Không ghi tier thì suy từ model: opus -> heavy, sonnet high -> medium, còn lại -> light.
"""
import datetime as dt
import json
import math
import os
import re
import signal
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
FLEET_DIR = os.path.expanduser(os.environ.get("FLEET_DIR", "~/.xdev-hive/fleet"))
A = os.path.join(FLEET_DIR, "agents")
os.makedirs(A, exist_ok=True)
JOBS = os.path.join(A, "jobs.json")
if not os.path.exists(JOBS):
    with open(JOBS, "w") as f:
        f.write("{}")
LOG = os.path.join(A, "supervisor.log")
STATUS = os.path.join(A, "status.txt")


def discover_accounts():
    root = os.path.expanduser("~/.xdev-hive/accounts")
    found = sorted(d for d in os.listdir(root) if re.fullmatch(r"(claude|codex)-\d+", d)) if os.path.isdir(root) else []
    # codex-1 dùng CODEX_HOME mặc định (~/.codex), không có thư mục trong accounts.
    if "codex-1" not in found and os.path.isdir(os.path.expanduser("~/.codex")):
        found.append("codex-1")
    return found


def env_list(name):
    return [a for a in os.environ.get(name, "").replace(",", " ").split() if a]


# AGENT_ACCOUNTS="claude-4,claude-5,codex-1": tài khoản nhận việc (không đặt thì lấy hết thư mục trong ~/.xdev-hive/accounts).
# Phiên điều phối và tài khoản người dùng đang dùng cho việc khác phải bỏ ra khỏi danh sách này.
# Tài khoản codex gói free (cửa sổ 30 ngày, model nhỏ) chỉ nhận việc light.
ACCOUNTS = env_list("AGENT_ACCOUNTS") or discover_accounts()
RETIRED = env_list("AGENT_RETIRED")  # agent còn chạy trên các tài khoản này thì chuyển đi
SAFETY = 8  # % phiên chừa lại
WEEK_STOP = 98  # tuần từ mức này trở lên thì bỏ tài khoản (chừa chút cho việc tay của người dùng)
FREE_STOP = 90  # gói free chỉ có cửa sổ tháng, bỏ khi dùng từ mức này
BURN = float(os.environ.get("AGENT_BURN", "11"))  # % phiên mỗi agent Opus mỗi giờ (ước tính, cập nhật theo đo)
# Codex Plus: chưa có số đo thật, ước tính theo cỡ cửa sổ 5 giờ; chỉnh theo status.txt sau vài ngày chạy.
BURN_CODEX = float(os.environ.get("AGENT_BURN_CODEX", "12"))  # % phiên mỗi agent Codex effort high mỗi giờ
# Sonnet tốn ít quota hơn Opus nhiều; hệ số ước tính, chỉnh theo số đo thật.
MODEL_WEIGHT = {"claude-opus-5-5": 1.0, "claude-sonnet-5-5": 0.5, "claude-haiku-5-5": 0.2}
CODEX_WEIGHT = {"high": 1.0, "medium": 0.6}
MAX_RUNNING = int(os.environ.get("AGENT_MAX", "6"))  # máy 8 CPU/16 GB chỉ chịu được chừng này agent build/test cùng lúc
INTERVAL = int(os.environ.get("AGENT_INTERVAL", "600"))
TIERS = ("heavy", "medium", "light")


def log(msg):
    line = f"{dt.datetime.now():%H:%M} {msg}"
    print(line, flush=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")


def is_codex(acct):
    return acct.startswith("codex-")


def parse_reset(text):
    """'Oct 13 at 4:10pm (Asia/Saigon)' hoặc 'Oct 13 at 4pm' -> datetime giờ máy (bỏ phần múi giờ trong ngoặc)."""
    m = re.match(r"([A-Z][a-z]{2}) (\d+) at (\d+)(?::(\d+))?(am|pm)", text or "")
    if not m:
        return None
    mon, day, h, mi, ap = m.groups()
    h = int(h) % 12 + (12 if ap == "pm" else 0)
    now = dt.datetime.now()
    month = dt.datetime.strptime(mon, "%b").month
    when = dt.datetime(now.year, month, int(day), h, int(mi or 0))
    return when if when > now - dt.timedelta(days=200) else when.replace(year=now.year + 1)


def claude_quota(acct):
    env = dict(os.environ, CLAUDE_CONFIG_DIR=os.path.expanduser(f"~/.xdev-hive/accounts/{acct}"))
    try:
        out = subprocess.run(
            ["claude", "-p", "/usage", "--output-format", "json", "--setting-sources", "user",
             "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'],
            env=env, capture_output=True, text=True, timeout=120, stdin=subprocess.DEVNULL, cwd=A,
        )
        text = json.loads(out.stdout).get("result") or ""
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}

    def grab(key):
        m = re.search(key + r": (\d+)% used(?: · resets (.*))?", text)
        return (int(m.group(1)), parse_reset((m.group(2) or "").strip())) if m else (None, None)

    s, sr = grab("Current session")
    w, wr = grab(r"Current week \(all models\)")
    return {"session": s, "session_reset": sr, "week": w, "week_reset": wr}


def codex_home(acct):
    return os.path.expanduser("~/.codex" if acct == "codex-1" else f"~/.xdev-hive/accounts/{acct}")


def codex_quota(acct):
    """Hỏi app-server của Codex (account/rateLimits/read): số đo mới, không tốn lượt model và không ghi accounts.json của app.

    Gói Plus có cửa sổ 5 giờ + tuần; gói free chỉ có một cửa sổ 30 ngày, tính là "tuần" còn phiên coi như 0."""
    env = dict(os.environ, CODEX_HOME=codex_home(acct))
    p = subprocess.Popen(["codex", "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                         text=True, env=env, cwd=A)
    timer = threading.Timer(60, p.kill)
    timer.start()
    try:
        def send(o):
            p.stdin.write(json.dumps(o) + "\n")
            p.stdin.flush()

        def reply(want):
            for line in p.stdout:
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                if o.get("id") == want:
                    return o
            raise RuntimeError("app-server đóng sớm")

        send({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "fleet", "title": "fleet", "version": "1"}}})
        reply(1)
        send({"method": "initialized"})
        send({"id": 2, "method": "account/rateLimits/read"})
        res = reply(2)
        if "error" in res:
            return {"error": str(res["error"])[:200]}
        res = res["result"]
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}
    finally:
        timer.cancel()
        p.kill()
        p.wait()

    rl = res.get("rateLimits") or {}
    q = {"session": None, "session_reset": None, "week": None, "week_reset": None, "plan": rl.get("planType")}
    for w in (rl.get("primary"), rl.get("secondary")):
        if not w or w.get("usedPercent") is None:
            continue
        reset = dt.datetime.fromtimestamp(w["resetsAt"]) if w.get("resetsAt") else None
        key = "session" if (w.get("windowDurationMins") or 0) <= 600 else "week"
        q[key], q[key + "_reset"] = round(w["usedPercent"]), reset
    if q["session"] is None:
        q["session"] = 0
    if res.get("ordinaryUsageAllowed") is False or rl.get("rateLimitReachedType"):
        q["session"] = 100
    return q


def cooldown(acct):
    """Hết lượt giữa chừng (launch-auto.sh ghi cool-<tài khoản> = epoch reset): chưa tới giờ thì không giao việc."""
    try:
        with open(os.path.join(A, f"cool-{acct}")) as f:
            until = dt.datetime.fromtimestamp(int(f.read().strip()))
    except (OSError, ValueError):
        return None
    return until if until > dt.datetime.now() else None


def quota(acct):
    q = codex_quota(acct) if is_codex(acct) else claude_quota(acct)
    if is_codex(acct) and (c := cooldown(acct)):
        q["cooldown"] = c
    return q


def capacity(q, acct):
    """Số agent tài khoản chịu được tới lúc reset phiên mà không chạm (100 - SAFETY)%."""
    if not q or q.get("session") is None:
        return 0
    if q["week"] is not None and q["week"] >= WEEK_STOP:
        return 0
    if q.get("cooldown"):
        return 0
    if is_codex(acct) and q.get("plan") == "free":
        # Cửa sổ 30 ngày, không ước được theo giờ: mỗi lần một việc light cho tới khi gần cạn.
        return 1.0 if q["session"] < 100 and (q["week"] or 0) < FREE_STOP else 0
    left = 100 - SAFETY - q["session"]
    if left <= 0:
        return 0
    reset = q["session_reset"]
    hours = max((reset - dt.datetime.now()).total_seconds() / 3600, 0.25) if reset else 5
    # Số agent tương đương (số thực): agent nhẹ chiếm weight < 1 nên vẫn vừa chỗ lẻ.
    return max(0.0, round(left / ((BURN_CODEX if is_codex(acct) else BURN) * hours), 2))


def tier(info):
    t = info.get("tier")
    if t in TIERS:
        return t
    model = info.get("model", "claude-opus-5-5")
    if "opus" in model or "fable" in model:
        return "heavy"
    return "medium" if "sonnet" in model and info.get("effort", "high") in ("high", "xhigh", "max") else "light"


def claude_run(info):
    """(model, effort) khi chạy trên Claude. Tier ghi rõ thì quyết định model; không thì giữ model/effort đã ghi cho việc."""
    model, effort = info.get("model", "claude-opus-5-5"), info.get("effort", "high")
    t = info.get("tier")
    if t == "heavy" and "opus" not in model and "fable" not in model:
        model = "claude-opus-5-5"
    elif t == "medium":
        model, effort = "claude-sonnet-5-5", "high"
    elif t == "light":
        model, effort = "claude-sonnet-5-5", "medium"
    return model, effort


def codex_effort(info):
    return "medium" if tier(info) == "light" else "high"


def weight(info, acct):
    if is_codex(acct):
        return CODEX_WEIGHT[codex_effort(info)]
    return MODEL_WEIGHT.get(claude_run(info)[0], 1.0)


def eligible(acct, info, qs):
    if not is_codex(acct):
        return True
    t = tier(info)
    if t == "heavy":
        return False
    return t == "light" or qs[acct].get("plan") != "free"


def pids_of(job, wt):
    """Tiến trình wrapper và CLI của việc: wrapper có tên việc trong tham số, CLI có cwd là worktree."""
    out = subprocess.run(["pgrep", "-f", rf"launch(-auto|-claude)?\.sh {job} "], capture_output=True, text=True).stdout
    wrappers = [int(p) for p in out.split()]
    cli = []
    out = subprocess.run(["pgrep", "-f", "claude -p|agy -p|codex exec"], capture_output=True, text=True).stdout
    for p in out.split():
        cwd = subprocess.run(["lsof", "-a", "-p", p, "-d", "cwd", "-Fn"], capture_output=True, text=True).stdout
        if f"n{wt}\n" in cwd + "\n":
            cli.append(int(p))
    return wrappers, cli


def kill_tree(pid):
    kids = subprocess.run(["pgrep", "-P", str(pid)], capture_output=True, text=True).stdout.split()
    for k in kids:
        kill_tree(int(k))
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass


def start(job, info, acct, others):
    order = ",".join([acct] + [a for a in others if a != acct])
    done = os.path.join(A, f"done-{job}")
    if os.path.exists(done):
        os.remove(done)
    # Worktree đã có commit hay file đổi: agent mới phải đọc lại phần dở thay vì làm lại từ đầu.
    dirty = subprocess.run(["git", "-C", info["wt"], "status", "--porcelain"], capture_output=True, text=True).stdout
    ahead = subprocess.run(["git", "-C", info["wt"], "log", "--oneline", "origin/main..HEAD"], capture_output=True, text=True).stdout
    env = dict(os.environ, RESUME="1") if (dirty.strip() or ahead.strip()) else dict(os.environ)
    env["MODEL"], env["EFFORT"] = claude_run(info)
    env["CODEX_EFFORT"] = codex_effort(info)
    env["FLEET_DIR"] = FLEET_DIR
    subprocess.Popen(
        [os.path.join(SCRIPTS, "launch-auto.sh"), job, info["wt"], order, str(info.get("perf", 0))],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, env=env,
    )
    info["account"], info["status"] = acct, "running"


def tick(jobs):
    with ThreadPoolExecutor(len(ACCOUNTS)) as pool:
        qs = dict(zip(ACCOUNTS, pool.map(quota, ACCOUNTS)))
    for a, q in qs.items():
        if q.get("error"):
            log(f"không đo được quota {a}: {q['error']}")
    # Việc đã xong (wrapper ghi done-<việc>) thì bỏ khỏi đếm.
    for job, info in jobs.items():
        if info["status"] == "running" and os.path.exists(os.path.join(A, f"done-{job}")):
            w, c = pids_of(job, info["wt"])
            if not w and not c:
                info["status"] = "done"
                log(f"{job} xong ({open(os.path.join(A, f'done-{job}')).read().strip()})")
    cap = {a: capacity(qs[a], a) for a in ACCOUNTS}
    used = {a: sum(weight(i, a) for i in jobs.values() if i["status"] == "running" and i["account"] == a) for a in ACCOUNTS}

    def spare(info):
        """Tài khoản còn chỗ cho việc này: việc light ưu tiên Codex, còn lại ưu tiên tài khoản dư nhiều nhất."""
        t = tier(info)
        ok = [a for a in ACCOUNTS if eligible(a, info, qs) and cap[a] - used[a] >= weight(info, a)]
        return sorted(ok, key=lambda a: (t == "light" and not is_codex(a), -(cap[a] - used[a])))

    def fallbacks(info):
        return [a for a in ACCOUNTS if eligible(a, info, qs) and cap[a] > 0]

    for a in RETIRED:
        cap[a], used[a], qs[a] = 0, sum(1 for i in jobs.values() if i["status"] == "running" and i["account"] == a), {}
    # Chuyển agent khỏi tài khoản quá sức hoặc đã loại (agent khởi động muộn nhất đi trước).
    for a in RETIRED + ACCOUNTS:
        while used[a] > cap[a]:
            movable = [j for j, i in jobs.items() if i["status"] == "running" and i["account"] == a]
            target = next((t for t in spare(jobs[movable[-1]]) if t != a), None) if movable else None
            if movable and not target and a in RETIRED:
                # Tài khoản đã loại (người dùng cần cho việc khác): dừng hẳn, đưa về hàng chờ; phần đã sửa nằm trong worktree.
                job = movable[-1]
                w, c = pids_of(job, jobs[job]["wt"])
                for p in w + c:
                    kill_tree(p)
                jobs[job]["status"], jobs[job]["account"] = "queued", None
                used[a] -= 1
                log(f"dừng {job} trên {a} (đã loại), đưa vào hàng chờ")
                continue
            if not movable or not target:
                if movable:
                    log(f"{a} quá sức ({used[a]}/{cap[a]}) nhưng không còn tài khoản rảnh; để chạy tiếp")
                break
            job = movable[-1]
            info = jobs[job]
            w, c = pids_of(job, info["wt"])
            for p in w + c:
                kill_tree(p)
            time.sleep(3)
            start(job, info, target, fallbacks(info))
            used[a] -= weight(info, a)
            used[target] += weight(info, target)
            log(f"chuyển {job}: {a} -> {target} (phiên {a} {qs[a].get('session')}%, chịu được {cap[a]})")
    # Khởi động việc trong hàng.
    running = sum(1 for i in jobs.values() if i["status"] == "running")
    for job, info in jobs.items():
        if info["status"] != "queued" or running >= MAX_RUNNING:
            continue
        target = next(iter(spare(info)), None)
        if not target:
            continue
        start(job, info, target, fallbacks(info))
        used[target] += weight(info, target)
        running += 1
        log(f"bắt đầu {job} ({tier(info)}) trên {target}")
    with open(STATUS, "w") as f:
        f.write(f"{dt.datetime.now():%H:%M}\n")
        for a in ACCOUNTS:
            q = qs[a]
            r = q.get("session_reset")
            free = is_codex(a) and q.get("plan") == "free"
            f.write(f"{a}{' (' + q['plan'] + ')' if q.get('plan') else ''}: ")
            f.write(f"phiên {q.get('session')}% (reset {r:%H:%M} )" if r else f"phiên {q.get('session')}%")
            f.write(f", {'tháng' if free else 'tuần'} {q.get('week')}%, chịu được {cap[a]}, đang chạy {used[a]}")
            if q.get("cooldown"):
                f.write(f", nghỉ tới {q['cooldown']:%d/%m %H:%M}")
            f.write(": " + ", ".join(f"{j}[{tier(i)}]" for j, i in jobs.items() if i["status"] == "running" and i["account"] == a) + "\n")
        f.write("hàng chờ: " + ", ".join(f"{j}[{tier(i)}]" for j, i in jobs.items() if i["status"] == "queued") + "\n")
    # Việc được thêm vào file trong lúc chu kỳ chạy thì giữ lại, không ghi đè mất.
    import fcntl
    with open(os.path.join(A, "jobs.lock"), "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        with open(JOBS) as f:
            for k, v in json.load(f).items():
                jobs.setdefault(k, v)
        with open(JOBS, "w") as f:
            json.dump(jobs, f, indent=2, ensure_ascii=False)


def main():
    once = "--once" in sys.argv
    while True:
        with open(JOBS) as f:
            jobs = json.load(f)
        try:
            tick(jobs)
        except Exception as e:  # noqa: BLE001
            log(f"lỗi chu kỳ: {e}")
        if once or not any(i["status"] in ("running", "queued") for i in jobs.values()):
            break
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
