"""Local WeChat v4 reader. Only ordinary file reads touch the explicit source root.

SQLCipher opens verified encrypted copies, never the live source. No Electron,
WeFlow, digest service, process hooks or global Python packages are needed.
The caller consumes JSON on stdout; diagnostics never contain keys or messages.
"""
from __future__ import annotations

import argparse
import contextlib
import ctypes as C
import ctypes.util
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import sys
import tempfile
import time
import xml.etree.ElementTree as ET


class ReaderError(Exception):
    pass


MAX_CONTENT_BYTES = 4 * 1024 * 1024


def sqlcipher_library(explicit=None):
    if explicit:
        return explicit
    for path in ("/opt/homebrew/opt/sqlcipher/lib/libsqlcipher.dylib", "/usr/local/opt/sqlcipher/lib/libsqlcipher.dylib"):
        if Path(path).is_file():
            return path
    found = ctypes.util.find_library("sqlcipher")
    if not found:
        raise ReaderError("未找到 SQLCipher 4 动态库")
    return found


def checksum(data, endian, state=(0, 0)):
    a, b = state
    for x, y in struct.iter_unpack(endian + "II", data):
        a = (a + x + b) & 0xffffffff
        b = (b + y + a) & 0xffffffff
    return a, b


def index_header(path):
    if not path.exists():
        return None
    with path.open("rb") as f:
        data = f.read(136)
    if len(data) < 136 or data[:48] != data[48:96] or data[12] != 1:
        raise ReaderError("SHM 提交头不稳定")
    endian = "<" if struct.unpack_from("<I", data)[0] == 3007000 else ">"
    if struct.unpack_from(endian + "I", data)[0] != 3007000:
        raise ReaderError("不支持的 SHM 格式")
    if checksum(data[:40], endian) != struct.unpack_from(endian + "II", data, 40):
        raise ReaderError("SHM checksum 校验失败")
    frame, pages, c0, c1 = struct.unpack_from(endian + "IIII", data, 16)
    if any(struct.unpack_from(endian + "I", data, p)[0] > frame for p in (96, 128)):
        raise ReaderError("SHM checkpoint 水位无效")
    return {"signature": data[:100] + data[128:136], "frame": frame,
            "pages": pages, "checksum": (c0, c1), "salt": data[32:40]}


def verify_wal(path, index):
    """Validate the committed prefix before SQLite can silently ignore a bad WAL.

    Format: sqlite.org/fileformat2.html#walformat and sqlite.org/walformat.html.
    A checked SHM header bounds preallocated/previous-generation tails.
    """
    if not path.exists() or path.stat().st_size == 0:
        if index and index["frame"]:
            raise ReaderError("SHM 声明有提交但 WAL 缺失")
        return
    with path.open("r+b") as f:
        header = f.read(32)
        if len(header) != 32:
            raise ReaderError("WAL 头不完整")
        magic, version, size = struct.unpack_from(">III", header)
        if magic not in (0x377f0682, 0x377f0683) or version != 3007000 or size != 4096:
            raise ReaderError("不支持的 WAL 格式或页大小")
        endian = "<" if magic == 0x377f0682 else ">"
        state = checksum(header[:24], endian)
        if state != struct.unpack_from(">II", header, 24):
            raise ReaderError("WAL 头 checksum 错误")
        length = path.stat().st_size
        count, extra = divmod(length - 32, size + 24)
        if index:
            if header[16:24] != index["salt"] or index["frame"] > count:
                raise ReaderError("WAL 与 SHM generation/提交范围不一致")
            count = index["frame"]
        elif extra:
            raise ReaderError("无 SHM 的 WAL 帧不完整")
        last_commit = 0
        pages = 0
        for i in range(count):
            frame = f.read(size + 24)
            pg, committed = struct.unpack_from(">II", frame)
            if pg == 0 or frame[8:16] != header[16:24]:
                raise ReaderError("WAL 提交区 salt/页号错误")
            state = checksum(frame[:8], endian, state)
            state = checksum(frame[24:], endian, state)
            if state != struct.unpack_from(">II", frame, 16):
                raise ReaderError("WAL 提交帧 checksum 错误")
            if committed:
                last_commit, pages = i + 1, committed
        if index and count and (last_commit != count or pages != index["pages"] or state != index["checksum"]):
            raise ReaderError("WAL 最后提交与 SHM 不一致")
        f.truncate(32 + last_commit * (size + 24))


def fingerprint(path):
    if not path.exists():
        return None
    if path.is_symlink() or not path.is_file():
        raise ReaderError("源文件不能是符号链接或特殊文件")
    s = path.stat()
    return s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns


def snapshot(source, destination):
    for attempt in range(3):
        try:
            return snapshot_once(source, destination)
        except ReaderError as error:
            if str(error) not in ("复制期间源库变化，本批重试", "SHM 提交头不稳定") or attempt == 2:
                raise
            time.sleep(0.1)


def snapshot_once(source, destination):
    paths = [source, Path(str(source) + "-wal"), Path(str(source) + "-shm")]
    journal = Path(str(source) + "-journal")
    if journal.exists() and journal.stat().st_size:
        raise ReaderError("源库存在 rollback journal，暂不读取")
    before = [fingerprint(p) for p in paths]
    if before[0] is None:
        raise ReaderError("源库不存在")
    index = index_header(paths[2])
    shutil.copyfile(source, destination)
    if before[1] is not None:
        shutil.copyfile(paths[1], Path(str(destination) + "-wal"))
    after_index = index_header(paths[2])
    if before != [fingerprint(p) for p in paths] or index != after_index:
        raise ReaderError("复制期间源库变化，本批重试")
    if journal.exists() and journal.stat().st_size:
        raise ReaderError("复制期间出现 rollback journal")
    verify_wal(Path(str(destination) + "-wal"), index)


class Cipher:
    """Minimal SQLCipher C API; no SQL/key/error text escapes into diagnostics."""
    def __init__(self, library=None):
        try:
            self.lib = C.CDLL(sqlcipher_library(library))
        except OSError:
            raise ReaderError("无法加载 SQLCipher 动态库") from None
        for name, restype, args in (
            ("open_v2", C.c_int, [C.c_char_p, C.POINTER(C.c_void_p), C.c_int, C.c_char_p]),
            ("close_v2", C.c_int, [C.c_void_p]),
            ("prepare_v2", C.c_int, [C.c_void_p, C.c_char_p, C.c_int, C.POINTER(C.c_void_p), C.c_void_p]),
            ("step", C.c_int, [C.c_void_p]),
            ("finalize", C.c_int, [C.c_void_p]),
            ("column_count", C.c_int, [C.c_void_p]),
            ("column_type", C.c_int, [C.c_void_p, C.c_int]),
            ("column_name", C.c_char_p, [C.c_void_p, C.c_int]),
            ("column_text", C.c_void_p, [C.c_void_p, C.c_int]),
            ("column_blob", C.c_void_p, [C.c_void_p, C.c_int]),
            ("column_bytes", C.c_int, [C.c_void_p, C.c_int]),
        ):
            fn = getattr(self.lib, "sqlite3_" + name)
            fn.restype, fn.argtypes = restype, args
            setattr(self, name, fn)

    @contextlib.contextmanager
    def open(self, path, key, create=False):
        if not re.fullmatch(r"[a-fA-F0-9]{64}", key):
            raise ReaderError("缺少有效逐库密钥")
        db = C.c_void_p()
        code = self.open_v2(os.fsencode(path), C.byref(db), 6 if create else 2, None)
        try:
            if code:
                raise ReaderError(f"SQLCipher 打开副本失败 ({code})")
            version = self.query(db, "PRAGMA cipher_version")
            if not version or not str(next(iter(version[0].values()))).startswith("4."):
                raise ReaderError("需要 SQLCipher 4，不支持旧版加密格式")
            self.query(db, f'PRAGMA key = "x\'{key}\'"')
            self.query(db, "PRAGMA cipher_page_size = 4096")
            self.query(db, "PRAGMA temp_store = MEMORY")
            self.query(db, "SELECT count(*) FROM sqlite_master")
            yield db
        finally:
            if db:
                self.close_v2(db)

    def query(self, db, sql):
        stmt = C.c_void_p()
        code = self.prepare_v2(db, sql.encode(), -1, C.byref(stmt), None)
        try:
            if code:
                raise ReaderError(f"SQLCipher 查询失败 ({code})，检查密钥或副本结构")
            names = [self.column_name(stmt, i).decode() for i in range(self.column_count(stmt))]
            out = []
            while True:
                code = self.step(stmt)
                if code == 101:
                    return out
                if code != 100:
                    raise ReaderError(f"SQLCipher 读取失败 ({code})")
                row = {}
                for i, name in enumerate(names):
                    kind = self.column_type(stmt, i)
                    if kind == 5:
                        value = None
                    else:
                        ptr = self.column_blob(stmt, i) if kind == 4 else self.column_text(stmt, i)
                        value = C.string_at(ptr, self.column_bytes(stmt, i)) if ptr else b""
                        if kind != 4:
                            value = value.decode("utf-8", errors="strict")
                    row[name] = value
                out.append(row)
        finally:
            if stmt:
                self.finalize(stmt)


def decode_zstd_native(value):
    """Bounded ZSTD_decompress API, for Python versions without compression.zstd."""
    path = ctypes.util.find_library("zstd")
    if not path:
        raise ReaderError("压缩消息需要系统 libzstd 或 Python 3.14")
    lib = C.CDLL(path)
    lib.ZSTD_decompress.argtypes = [C.c_void_p, C.c_size_t, C.c_void_p, C.c_size_t]
    lib.ZSTD_decompress.restype = C.c_size_t
    lib.ZSTD_isError.argtypes = [C.c_size_t]
    lib.ZSTD_isError.restype = C.c_uint
    output = C.create_string_buffer(MAX_CONTENT_BYTES + 1)
    size = lib.ZSTD_decompress(output, len(output), value, len(value))
    if lib.ZSTD_isError(size) or size > MAX_CONTENT_BYTES:
        raise ReaderError("压缩消息损坏或超过读取上限")
    return output.raw[:size]


def decode_content(value):
    if not isinstance(value, bytes):
        return value or ""
    if value.startswith(b"\x28\xb5\x2f\xfd"):
        try:
            from compression import zstd
            decoder = zstd.ZstdDecompressor()
            value = decoder.decompress(value, max_length=MAX_CONTENT_BYTES + 1)
            if not decoder.eof or len(value) > MAX_CONTENT_BYTES:
                raise ReaderError("压缩消息超过读取上限")
        except ImportError:
            value = decode_zstd_native(value)
    if len(value) > MAX_CONTENT_BYTES:
        raise ReaderError("消息原始数据超过读取上限")
    return value.decode("utf-8", errors="strict")


def xml_body(body, depth=0):
    if depth >= 8:
        return "[引用层级过深]"
    start = body.find("<msg")
    if start < 0:
        return "[链接/卡片内容不可解析]"
    try:
        root = ET.fromstring(body[start:])
    except ET.ParseError:
        return "[链接/卡片内容不可解析]"
    for tag, label in (("img", "图片"), ("voicemsg", "语音"), ("videomsg", "视频"), ("emoji", "表情"), ("location", "位置")):
        if root.find(tag) is not None:
            return "[" + label + "]"
    def readable(value):
        return xml_body(value, depth + 1) if "<msg" in value and re.search(r"<(appmsg|img|voicemsg|videomsg|emoji|location)\b", value) else value
    parts = [readable(root.findtext(p, "").strip()) for p in ("./appmsg/title", "./appmsg/des", "./appmsg/url")]
    quote = root.find("./appmsg/refermsg")
    if quote is not None and quote.findtext("content", "").strip():
        author = quote.findtext("displayname", "").strip()
        parts.append("[引用] " + (author + ": " if author else "") + readable(quote.findtext("content", "").strip()))
    return "\n".join(p for p in parts if p) or "[卡片无文字]"


class Reader:
    def __init__(self, root, keyfile, library):
        self.root = Path(root).resolve(strict=True)
        self.identity = f"{self.root}:{self.root.stat().st_dev}:{self.root.stat().st_ino}"
        try:
            self.keys = json.loads(Path(keyfile).read_text())
            if not isinstance(self.keys, dict):
                raise ValueError()
        except Exception:
            raise ReaderError("密钥文件格式错误（未输出内容）") from None
        self.cipher = Cipher(library)

    @contextlib.contextmanager
    def database(self, rel):
        path = self.root / rel
        if path.resolve(strict=True).parent != path.parent or not path.resolve().is_relative_to(self.root):
            raise ReaderError("源库路径越界或存在符号链接")
        if not re.fullmatch(r"[a-fA-F0-9]{64}", str(self.keys.get(rel, ""))):
            raise ReaderError(f"缺少密钥：{rel}")
        source_stat = path.stat()
        with tempfile.TemporaryDirectory(prefix="shipradar-wechat-") as work:
            copy = Path(work) / "copy.db"
            snapshot(path, copy)
            with self.cipher.open(copy, self.keys[rel]) as db:
                yield lambda query: self.cipher.query(db, query)
            after = path.stat()
            if (source_stat.st_dev, source_stat.st_ino) != (after.st_dev, after.st_ino):
                raise ReaderError("读取期间源库被替换，本批重试")

    def catalog(self, groups, listing=False):
        with self.database("session/session.db") as query:
            sessions = {r["username"] for r in query("SELECT username FROM SessionTable") if re.fullmatch(r"[\w-]+@chatroom", r["username"] or "")}
        selected = sessions if listing else set(groups)
        if not selected.issubset(sessions):
            raise ReaderError("白名单群不在该账号会话列表中")
        names = {}
        with self.database("contact/contact.db") as query:
            # Read only selected groups here; member names are fetched below by stable IDs.
            for group in sorted(selected):
                for row in query(f"SELECT username, remark, nick_name FROM contact WHERE username='{group}'"):
                    names[group] = row["remark"] or row["nick_name"] or group
        result = {"identity": self.identity, "groups": [{"id": g, "name": names.get(g, g)} for g in sorted(selected)], "rows": [], "pending": 0}
        return result

    def message_row(self, row, group, shard, names):
        kind = int(row["local_type"]) & 0xffffffff
        if kind not in (1, 49, 10000, 10002):
            return None, 0
        body = decode_content(row["message_content"])
        sender = row["sender"] or ""
        prefix = re.match(r"^([\w@.-]+):\n", body)
        if prefix:
            if sender and sender != prefix[1]:
                raise ReaderError("发言人索引与正文身份冲突")
            sender, body = prefix[1], body[prefix.end():]
        revoked = kind in (10000, 10002) and ("<revokemsg" in body or "撤回了一条消息" in body)
        if kind in (10000, 10002) and not revoked:
            return None, 0
        target = ""
        if revoked and "<revokemsg" in body:
            try:
                xml = ET.fromstring(body[body.index("<"):])
                session = xml.findtext(".//revokemsg/session", "")
                if session and session != group:
                    raise ReaderError("撤回目标群不匹配")
                target = xml.findtext(".//revokemsg/newmsgid", "")
                if not re.fullmatch(r"[1-9]\d{0,24}", target):
                    target = ""
            except ET.ParseError:
                raise ReaderError("撤回消息 XML 无法定位") from None
        server_id = row["server_id"] or "0"
        pending = int(server_id == "0" and not revoked)
        # Prefix local scope with DB inode: replacing a shard cannot reuse an old
        # in-place revoke identity from the collector's saved map.
        inode = (self.root / "message" / shard).stat().st_ino
        return {"local": f'{group}/{shard}:{inode}/{row["local_id"]}', "target": target,
            "event": {"group_id": group, "group_name": names.get(group, group), "message_id": server_id,
                      "sender_id": sender, "sender_name": "", "sent_at": int(row["create_time"]),
                      "revoked": revoked, "content": "" if revoked else xml_body(body) if kind == 49 else body}}, pending

    def batches(self, groups, since, positions=None):
        catalog = self.catalog(groups)
        selected = sorted(groups)
        positions = positions or {}
        shards = sorted(p.name for p in (self.root / "message").iterdir() if re.fullmatch(r"message_\d+\.db", p.name))
        if not shards:
            raise ReaderError("未发现消息分片")
        names = {g["id"]: g["name"] for g in catalog["groups"]}
        with self.database("contact/contact.db") as contacts:
            for shard in shards:
                inode = (self.root / "message" / shard).stat().st_ino
                with self.database("message/" + shard) as query:
                    tables = {r["name"].lower(): r["name"] for r in query("SELECT name FROM sqlite_master WHERE type='table'")}
                    for group in selected:
                        table = "Msg_" + hashlib.md5(group.encode()).hexdigest()
                        scope = f"{group}/{shard}:{inode}"
                        if table.lower() not in tables:
                            yield {**catalog, "position": {"scope": scope, "time": 0, "local": 0, "done": True}}
                            continue
                        position = positions.get(scope, {})
                        if position.get("done"):
                            continue
                        timestamp, local = int(position.get("time", 0)), int(position.get("local", 0))
                        while True:
                            rows = query(f'SELECT m.local_id, m.server_id, m.local_type, m.create_time, m.message_content, n.user_name AS sender FROM "{table}" m LEFT JOIN Name2Id n ON n.rowid=m.real_sender_id WHERE m.create_time >= {int(since)} AND (m.create_time > {timestamp} OR (m.create_time = {timestamp} AND m.local_id > {local})) ORDER BY m.create_time, m.local_id LIMIT 250')
                            result = {**catalog, "rows": [], "pending": 0}
                            for row in rows:
                                event, pending = self.message_row(row, group, shard, names)
                                result["pending"] += pending
                                if event:
                                    result["rows"].append(event)
                            senders = sorted({r["event"]["sender_id"] for r in result["rows"] if r["event"]["sender_id"] and r["event"]["sender_id"] not in names})
                            if senders:
                                literals = ",".join("'" + sender.replace("'", "''") + "'" for sender in senders)
                                for row in contacts(f"SELECT username, remark, nick_name FROM contact WHERE username IN ({literals})"):
                                    names[row["username"]] = row["remark"] or row["nick_name"] or row["username"]
                            for row in result["rows"]:
                                row["event"]["sender_name"] = names.get(row["event"]["sender_id"], "")
                            if rows:
                                timestamp, local = int(rows[-1]["create_time"]), int(rows[-1]["local_id"])
                            result["position"] = {"scope": scope, "time": timestamp, "local": local, "done": len(rows) < 250}
                            yield result
                            if len(rows) < 250:
                                break
        if shards != sorted(p.name for p in (self.root / "message").iterdir() if re.fullmatch(r"message_\d+\.db", p.name)):
            raise ReaderError("读取期间消息分片发生变化，重试本批")
        if self.identity != f"{self.root}:{self.root.stat().st_dev}:{self.root.stat().st_ino}":
            raise ReaderError("读取期间账号目录发生变化")

    def read(self, groups, since, listing=False):
        if listing:
            return self.catalog(groups, True)
        result = None
        for batch in self.batches(groups, since):
            if result is None:
                result = {**batch, "rows": [], "pending": 0}
                result.pop("position", None)
            result["rows"].extend(batch["rows"])
            result["pending"] += batch["pending"]
        return result or self.catalog(groups)


def main():
    parser = argparse.ArgumentParser(description="Internal JSON reader; use scripts/wechat-collect.ts")
    parser.add_argument("--root", required=True)
    parser.add_argument("--keys", required=True)
    parser.add_argument("--library", help="SQLCipher 4 动态库路径；默认自动发现")
    parser.add_argument("--group", action="append", default=[])
    parser.add_argument("--since", type=int, default=1)
    parser.add_argument("--list-groups", action="store_true")
    parser.add_argument("--stream", action="store_true")
    parser.add_argument("--resume")
    args = parser.parse_args()
    if any(not re.fullmatch(r"[\w-]+@chatroom", g) for g in args.group) or not args.list_groups and not args.group:
        raise ReaderError("必须指定群白名单")
    reader = Reader(args.root, args.keys, args.library)
    if args.stream:
        saved = json.loads(Path(args.resume).read_text()) if args.resume and Path(args.resume).exists() else {}
        if saved and saved.get("identity") != reader.identity:
            raise ReaderError("历史状态与源账号身份不一致")
        for batch in reader.batches(args.group, args.since, saved.get("positions", {})):
            print(json.dumps(batch, ensure_ascii=False), flush=True)
        print(json.dumps({"complete": True, "identity": reader.identity}), flush=True)
    else:
        data = reader.read(args.group, args.since, args.list_groups)
        print(json.dumps(data, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except ReaderError as error:
        print("READER_ERROR: " + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("本地读取失败；检查源路径、依赖和消息编码（未输出凭据或正文）", file=sys.stderr)
        sys.exit(1)
