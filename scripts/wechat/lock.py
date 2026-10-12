"""Lifetime lock: the pipe/OS releases it on exit, including a killed collector.

The lock file intentionally remains; only the OS lock means 'running'. No PID
expiry guesses, stale-file deletion or source database locks are involved.
"""
import fcntl
import os
import sys

try:
    fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("已有采集器使用同一状态文件", file=sys.stderr)
        sys.exit(1)
    print("locked", flush=True)
    # Node keeps this pipe open until the collection lifecycle ends. On SIGKILL,
    # closing the parent's pipe causes EOF here and releases flock immediately.
    sys.stdin.buffer.read()
finally:
    if "fd" in globals():
        os.close(fd)
