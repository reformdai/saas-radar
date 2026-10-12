"""Build synthetic encrypted fixtures for the Docker integration check only."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
from compression import zstd
from test_reader import ReaderTests

destination = Path(sys.argv[1])
destination.mkdir(mode=0o700)  # Refuse existing paths; never reuse user data.
case = ReaderTests()
case.setUp()
try:
    case.fixture()
    table = "Msg_" + hashlib.md5(b"1@chatroom").hexdigest()
    compressed = zstd.compress("member:\n容器压缩合成消息".encode()).hex()
    for path in sorted((case.root / "message").glob("message_*.db")):
        with case.cipher.open(path, "12" * 32) as db:
            case.cipher.query(db, f"UPDATE {table} SET message_content=X'{compressed}'")
    shutil.copytree(case.root, destination / "db")
    (destination / "keys.json").write_text(json.dumps(case.keys))
    (destination / "keys.json").chmod(0o600)
finally:
    case.doCleanups()
