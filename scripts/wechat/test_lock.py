import subprocess
import sys
import tempfile
from pathlib import Path
import unittest


class LockTests(unittest.TestCase):
    def test_live_collector_excludes_others_and_kill_releases_lock(self):
        with tempfile.TemporaryDirectory(prefix="wechat-lock-test-") as root:
            lock = str(Path(root) / "collector.lock")
            args = [sys.executable, "-B", str(Path(__file__).with_name("lock.py")), lock]
            first = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                self.assertEqual(first.stdout.readline(), b"locked\n")
                second = subprocess.run(args, input=b"", capture_output=True, timeout=5)
                self.assertEqual(second.returncode, 1)
                first.kill()
                first.wait(timeout=5)
                # The file remains, but the OS releases the running process's lock.
                self.assertTrue(Path(lock).exists())
                third = subprocess.run(args, input=b"", capture_output=True, timeout=5)
                self.assertEqual(third.returncode, 0)
                self.assertEqual(third.stdout, b"locked\n")
            finally:
                if first.poll() is None:
                    first.kill(); first.wait(timeout=5)
                first.stdin.close(); first.stdout.close(); first.stderr.close()
