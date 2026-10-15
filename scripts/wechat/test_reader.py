"""Encrypted synthetic fixtures only. Never reads Library or real keys."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from reader import Cipher, Reader, ReaderError, snapshot, decode_content, decode_zstd_native, sqlcipher_library, xml_body

try:
    LIB = sqlcipher_library(os.environ.get("TEST_SQLCIPHER_LIB"))
except ReaderError:
    LIB = None
KEY = "12" * 32


@unittest.skipUnless(LIB, "SQLCipher library required")
class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="shipradar-synthetic-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "source"
        self.root.mkdir()
        self.cipher = Cipher(LIB)
        self.handles = contextlib.ExitStack()
        self.addCleanup(self.handles.close)
        self.keys = {}

    def db(self, rel, statements):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        self.keys[rel] = KEY
        db = self.handles.enter_context(self.cipher.open(path, KEY, create=True))
        self.cipher.query(db, "PRAGMA journal_mode=WAL")
        self.cipher.query(db, "PRAGMA wal_autocheckpoint=0")
        for sql in statements:
            self.cipher.query(db, sql)
        return db

    def fixture(self):
        self.db("session/session.db", ["CREATE TABLE SessionTable(username TEXT)", "INSERT INTO SessionTable VALUES ('1@chatroom'), ('2@chatroom')"])
        self.db("contact/contact.db", ["CREATE TABLE contact(username TEXT, remark TEXT, nick_name TEXT)", "INSERT INTO contact VALUES ('1@chatroom','','同名群'), ('2@chatroom','','同名群'), ('member','','群友')"])
        for shard, server in [("message_1.db", "9007199254740993"), ("message_2.db", "9007199254740994")]:
            sql = ["CREATE TABLE Name2Id(user_name TEXT PRIMARY KEY, is_session INTEGER)", "INSERT INTO Name2Id VALUES ('member',0)"]
            for group in ["1@chatroom", "2@chatroom"]:
                table = "Msg_" + hashlib.md5(group.encode()).hexdigest()
                sql += [f"CREATE TABLE {table}(local_id INTEGER, server_id INTEGER, local_type INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content BLOB)",
                        f"INSERT INTO {table} VALUES(1,{server},1,100,1,'member:' || char(10) || '合成讨论')"]
            self.db("message/" + shard, sql)
        keyfile = Path(self.temp.name) / "synthetic-keys.json"
        keyfile.write_text(json.dumps(self.keys))
        return Reader(self.root, keyfile, LIB)

    def source_hashes(self):
        return {str(p.relative_to(self.root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in self.root.rglob("*") if p.is_file()}

    def test_live_wal_group_identity_and_source_unchanged(self):
        reader = self.fixture()
        before = self.source_hashes()
        result = reader.read(["1@chatroom", "2@chatroom"], 1)
        self.assertEqual(len(result["rows"]), 4)
        self.assertEqual({r["event"]["message_id"] for r in result["rows"]}, {"9007199254740993", "9007199254740994"})
        self.assertTrue(all(r["event"]["content"] == "合成讨论" and r["event"]["sender_name"] == "群友" for r in result["rows"]))
        self.assertEqual(before, self.source_hashes())

    def test_missing_shard_key_and_wrong_key_fail_closed(self):
        reader = self.fixture()
        reader.keys.pop("message/message_2.db")
        with self.assertRaisesRegex(ReaderError, "缺少密钥"):
            reader.read(["1@chatroom"], 1)
        reader.keys["message/message_2.db"] = "34" * 32
        with self.assertRaisesRegex(ReaderError, "SQLCipher") as error:
            reader.read(["1@chatroom"], 1)
        self.assertNotIn("34" * 32, str(error.exception))

    def test_targetless_revoke_preserves_normal_messages_and_never_guesses_target(self):
        reader = self.fixture()
        table = "Msg_" + hashlib.md5(b"1@chatroom").hexdigest()
        with self.cipher.open(self.root / "message/message_1.db", KEY) as db:
            self.cipher.query(db, f"INSERT INTO {table} VALUES(2,123,10000,101,1,'<sysmsg><revokemsg><content>合成撤回</content><revoketime>0</revoketime></revokemsg></sysmsg>')")
        result = reader.read(["1@chatroom"], 1)
        self.assertEqual(len(result["rows"]), 3)
        revoked = [r for r in result["rows"] if r["event"]["revoked"]]
        self.assertEqual(len(revoked), 1)
        self.assertEqual(revoked[0]["target"], "")
        self.assertEqual(revoked[0]["event"]["content"], "")

    def test_history_pages_are_bounded_complete_and_resumable_at_same_timestamp(self):
        reader = self.fixture()
        table = "Msg_" + hashlib.md5(b"1@chatroom").hexdigest()
        with self.cipher.open(self.root / "message/message_1.db", KEY) as db:
            self.cipher.query(db, f"WITH RECURSIVE seq(x) AS (SELECT 2 UNION ALL SELECT x+1 FROM seq WHERE x<602) INSERT INTO {table} SELECT x,1000+x,1,100,1,'合成历史' FROM seq")
        before = self.source_hashes()
        pages = list(reader.batches(["1@chatroom"], 1))
        self.assertEqual([len(p["rows"]) for p in pages], [250, 250, 102, 1])
        self.assertEqual(len({r["local"] for p in pages for r in p["rows"]}), 603)
        first = pages[0]["position"]
        resumed = list(reader.batches(["1@chatroom"], 1, {first["scope"]: first}))
        self.assertEqual([r["local"] for p in resumed for r in p["rows"]], [r["local"] for p in pages[1:] for r in p["rows"]])
        self.assertEqual(before, self.source_hashes())
        self.assertTrue(all(r["event"]["group_id"] == "1@chatroom" for p in pages for r in p["rows"]))

    def test_corrupt_committed_wal_rejected(self):
        self.fixture()
        wal = self.root / "message/message_1.db-wal"
        with wal.open("r+b") as f:
            f.seek(100); b = f.read(1); f.seek(100); f.write(bytes([b[0] ^ 1]))
        with self.assertRaisesRegex(ReaderError, "checksum"):
            snapshot(self.root / "message/message_1.db", Path(self.temp.name) / "copy.db")

    def test_source_changes_during_copy_rejected(self):
        self.fixture()
        import reader as module
        original = module.shutil.copyfile
        def changed(source, destination):
            result = original(source, destination)
            os.utime(source, ns=(1, 1))
            return result
        with patch("reader.shutil.copyfile", changed), self.assertRaisesRegex(ReaderError, "复制期间"):
            snapshot(self.root / "session/session.db", Path(self.temp.name) / "copy.db")

    def test_wrong_group_and_symlink_refused(self):
        reader = self.fixture()
        with self.assertRaisesRegex(ReaderError, "白名单"):
            reader.read(["3@chatroom"], 1)
        (self.root / "message/message_3.db").symlink_to(self.root / "message/message_1.db")
        reader.keys["message/message_3.db"] = KEY
        with self.assertRaisesRegex(ReaderError, "符号链接"):
            reader.read(["1@chatroom"], 1)

    def test_zstd_content(self):
        import base64
        # Standard zstd frame, generated from UTF-8 text; works without Python 3.14.
        data = base64.b64decode("KLUv/SAMYQAA5Y6L57yp5q2j5paH")
        self.assertEqual(decode_content(data), "压缩正文")
        self.assertEqual(decode_zstd_native(data).decode(), "压缩正文")
        with self.assertRaises(ReaderError):
            decode_zstd_native(data[:-1])

    def test_nested_quote_xml_is_readable_with_declaration_or_compact_xml(self):
        inner = '<msg><appmsg><title>被引用的文字 &amp; 补充</title><type>57</type><refermsg></refermsg><appattach><aeskey>synthetic-key</aeskey></appattach></appmsg></msg>'
        for declaration in ("", '<?xml version="1.0"?>\n'):
            outer = '<msg><appmsg><title>当前回复</title><refermsg><displayname>合成群友</displayname><content><![CDATA[' + declaration + inner + ']]></content></refermsg></appmsg></msg>'
            content = xml_body(outer)
            self.assertEqual(content, "当前回复\n[引用] 合成群友: 被引用的文字 & 补充")
            self.assertNotIn("aeskey", content)
        self.assertEqual(xml_body('<msg><img aeskey="synthetic-key" /></msg>'), "[图片]")

    def test_large_card_xml_is_decoded_before_extracting_small_visible_content(self):
        import ctypes as C
        import ctypes.util
        lib = C.CDLL(ctypes.util.find_library("zstd"))
        lib.ZSTD_compressBound.argtypes, lib.ZSTD_compressBound.restype = [C.c_size_t], C.c_size_t
        lib.ZSTD_compress.argtypes = [C.c_void_p, C.c_size_t, C.c_void_p, C.c_size_t, C.c_int]
        lib.ZSTD_compress.restype = C.c_size_t
        body = ("<msg><appmsg><title>合成标题</title><des>合成说明</des><url>https://example.com</url><metadata>" + "x" * 200000 + "</metadata></appmsg></msg>").encode()
        out = C.create_string_buffer(lib.ZSTD_compressBound(len(body)))
        length = lib.ZSTD_compress(out, len(out), body, len(body), 1)
        compressed = out.raw[:length]
        self.assertEqual(decode_zstd_native(compressed), body)
        reader = self.fixture()
        event, pending = reader.message_row({"local_type": "49", "message_content": compressed, "sender": "member", "server_id": "123", "local_id": "1", "create_time": "100"}, "1@chatroom", "message_1.db", {})
        self.assertEqual(event["event"]["content"], "合成标题\n合成说明\nhttps://example.com")
        self.assertEqual(pending, 0)
        oversized = b"x" * (4 * 1024 * 1024 + 2)
        out = C.create_string_buffer(lib.ZSTD_compressBound(len(oversized)))
        length = lib.ZSTD_compress(out, len(out), oversized, len(oversized), 1)
        with self.assertRaisesRegex(ReaderError, "超过读取上限"):
            decode_zstd_native(out.raw[:length])

    def test_read_only_source_directory_is_supported(self):
        reader = self.fixture()
        paths = list(self.root.rglob("*")) + [self.root]
        modes = {p: p.stat().st_mode & 0o777 for p in paths}
        try:
            for p in paths:
                p.chmod(0o500 if p.is_dir() else 0o400)
            before = self.source_hashes()
            self.assertEqual(len(reader.read(["1@chatroom"], 1)["rows"]), 2)
            self.assertEqual(before, self.source_hashes())
        finally:
            for p, mode in modes.items():
                p.chmod(mode)


import contextlib
if __name__ == "__main__":
    unittest.main()
