#!/usr/bin/env python3
"""Ghi cool-<tài khoản> (epoch giây) khi Codex báo hết lượt, để supervisor không giao việc cho tài khoản đó tới lúc reset.

Dùng: codex_cool.py <tài khoản> <file log>... ; đọc thông báo 'try again at ...' trong vài dòng cuối, không có thì nghỉ 60 phút.
"""
import datetime as dt
import os
import re
import sys

A = os.path.join(os.path.expanduser(os.environ.get("FLEET_DIR", "~/.xdev-hive/fleet")), "agents")
FALLBACK = 3600


def tail(path, n=8):
    try:
        with open(path, errors="replace") as f:
            return "".join(f.readlines()[-n:])
    except OSError:
        return ""


def parse(text):
    """'Nov 9th, 2026 12:22 PM' hoặc '3:41 PM' -> epoch; không đọc được thì None."""
    m = re.search(r"try again at (?:([A-Z][a-z]{2}) (\d+)(?:st|nd|rd|th)?, (\d{4}) )?(\d+):(\d+) ?([AP]M)", text)
    if not m:
        return None
    mon, day, year, h, mi, ap = m.groups()
    h = int(h) % 12 + (12 if ap == "PM" else 0)
    now = dt.datetime.now()
    if mon:
        when = dt.datetime(int(year), dt.datetime.strptime(mon, "%b").month, int(day), h, int(mi))
    else:
        when = now.replace(hour=h, minute=int(mi), second=0, microsecond=0)
        if when <= now:
            when += dt.timedelta(days=1)
    return when.timestamp()


def main():
    acct, logs = sys.argv[1], sys.argv[2:]
    until = next((t for t in (parse(tail(p)) for p in logs) if t), None)
    until = until or dt.datetime.now().timestamp() + FALLBACK
    with open(os.path.join(A, f"cool-{acct}"), "w") as f:
        f.write(str(int(until)))


if __name__ == "__main__":
    main()
