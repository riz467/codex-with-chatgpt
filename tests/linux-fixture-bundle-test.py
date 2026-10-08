"""Run: python -B tests/linux-fixture-bundle-test.py (Python 3.12+)."""
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
import warnings
import zipfile

spec = importlib.util.spec_from_file_location("bundle", Path(__file__).parents[1] / "scripts/linux-fixture-bundle.py")
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)
TEMP = Path("C:/Users/bootstrap-admin/AppData/Local/Temp/opencode/phase16-handoff") if os.name == "nt" else Path(tempfile.gettempdir())
TEMP.mkdir(parents=True, exist_ok=True)


class BundleTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bundle-test-", dir=TEMP)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "-q")
        for name in bundle.ROOT_FILES | bundle.DOCS | {"src/example.ts", "tests/example.test.ts"}:
            target = self.repo / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("fixture\n", encoding="utf-8")
        (self.repo / "package.json").write_text(json.dumps({"packageManager": "pnpm@11.24.0",
            "engines": {"node": ">=20"}, "dependencies": {}, "devDependencies": {}}))
        self.git("add", ".")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "-qm", "fixture")
        self.commit = self.git("rev-parse", "HEAD").decode().strip()
        self.result = bundle.build(self.repo, self.commit, self.root / "output")
        self.archive = Path(self.result["archive"])
        self.data = self.archive.read_bytes()

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repo), *args], stderr=subprocess.PIPE)

    def mutate(self, transform):
        with zipfile.ZipFile(io.BytesIO(self.data)) as archive:
            entries = [(entry, archive.read(entry)) for entry in archive.infolist()]
        entries = transform(entries)
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            for entry, data in entries:
                archive.writestr(entry, data)
        return output.getvalue()

    def rejects(self, data):
        self.archive.write_bytes(data)
        destination = self.root / "extracted"
        with self.assertRaises((ValueError, zipfile.BadZipFile)):
            bundle.check(self.archive, self.commit, bundle.sha(data), destination)
        self.assertFalse(destination.exists())

    def test_roundtrip_and_reproducibility(self):
        other = bundle.build(self.repo, self.commit, self.root / "other")
        self.assertEqual(self.result["sha256"], other["sha256"])
        destination = self.root / "extracted"
        result = bundle.check(self.archive, self.commit, self.result["sha256"], destination)
        self.assertEqual(result["offline_status"], "BLOCKED")
        self.assertEqual((destination / "src/example.ts").read_bytes(), b"fixture\n")
        with self.assertRaises(FileExistsError):
            bundle.check(self.archive, self.commit, self.result["sha256"], destination)

    def test_worktree_and_excluded_material_not_read(self):
        (self.repo / "src/example.ts").write_text("dirty secret")
        for directory in ("node_modules", "HOME", "runtime", "ledger", "sessions"):
            (self.repo / directory).mkdir()
            (self.repo / directory / "secret.json").write_text("secret")
        other = bundle.build(self.repo, self.commit, self.root / "other")
        self.assertEqual(other["sha256"], self.result["sha256"])

    def test_missing_extra_and_corrupt(self):
        self.rejects(self.mutate(lambda rows: [(e, d) for e, d in rows if e.filename != "src/example.ts"]))
        self.rejects(self.mutate(lambda rows: [(e, b"changed" if e.filename == "src/example.ts" else d) for e, d in rows]))
        def extra(rows):
            entry = zipfile.ZipInfo("src/extra.ts")
            entry.create_system = 3
            entry.external_attr = (stat.S_IFREG | 0o644) << 16
            return rows + [(entry, b"extra")]
        self.rejects(self.mutate(extra))

    def test_replace_ref_does_not_change_approved_commit(self):
        (self.repo / "src/example.ts").write_text("replacement contents")
        self.git("add", ".")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "-qm", "replacement")
        replacement = self.git("rev-parse", "HEAD").decode().strip()
        self.git("replace", self.commit, replacement)
        other = bundle.build(self.repo, self.commit, self.root / "replacement-check")
        self.assertEqual(other["sha256"], self.result["sha256"])

    def test_ancestor_case_and_file_directory_collision(self):
        for names in (("src/Foo/a.ts", "src/foo/b.ts"), ("src/a.ts", "src/a.ts/b.ts")):
            def append(rows):
                for name in names:
                    entry = zipfile.ZipInfo(name)
                    entry.create_system = 3
                    entry.external_attr = (stat.S_IFREG | 0o644) << 16
                    rows.append((entry, b"fixture"))
                return rows
            data = self.mutate(append)
            with self.assertRaisesRegex(ValueError, "ancestor case/file-directory collision"):
                bundle.validate(data, self.commit)
            self.rejects(data)

    def test_traversal_absolute_backslash_and_case_collision(self):
        for name in ("../escape", "/escape", "C:/escape", "src\\escape.ts", "src/../escape.ts",
                     "src/NUL.ts", "src/.env", "src/HOME/secret.json", "PACKAGE.JSON"):
            with self.subTest(name=name):
                def rename(rows):
                    for entry, _ in rows:
                        if entry.filename == "src/example.ts":
                            entry.filename = name
                    return rows
                self.rejects(self.mutate(rename))

    def test_symlink_special_file_and_directory(self):
        for mode in (stat.S_IFLNK | 0o777, stat.S_IFIFO | 0o644, stat.S_IFDIR | 0o755,
                     stat.S_IFREG | 0o4755):
            with self.subTest(mode=mode):
                def change(rows):
                    rows[0][0].external_attr = mode << 16
                    return rows
                self.rejects(self.mutate(change))

    def test_duplicate_manifest_key(self):
        self.rejects(self.mutate(lambda rows: [(e, d.replace(b'"schema": 1', b'"schema": 1, "schema": 1')
            if e.filename == bundle.MANIFEST else d) for e, d in rows]))

    def test_duplicate_entry(self):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            self.rejects(self.mutate(lambda rows: rows + [rows[0]]))

    def test_secret_detection(self):
        self.assertIsNotNone(bundle.SECRET.search(b"-----BEGIN PRIVATE KEY-----\n" + b"A" * 64))
        self.assertIsNotNone(bundle.SECRET.search(b"ghp_" + b"a" * 36))
        self.assertIsNone(bundle.SECRET.search(b"-----BEGIN PRIVATE KEY-----"))

    def test_wrong_commit_or_archive_hash(self):
        for commit, digest in (("0" * 40, self.result["sha256"]), (self.commit, "0" * 64)):
            with self.assertRaises(ValueError):
                bundle.check(self.archive, commit, digest)

    def test_destination_link(self):
        link = self.root / "link"
        try:
            link.symlink_to(self.repo, target_is_directory=True)
        except OSError:
            self.skipTest("host does not permit symlinks")
        with self.assertRaises(ValueError):
            bundle.check(self.archive, self.commit, self.result["sha256"], link / "extracted")
        self.assertFalse((self.repo / "extracted").exists())

    def test_tracked_symlink_rejected(self):
        blob = subprocess.check_output(["git", "-C", str(self.repo), "hash-object", "-w", "--stdin"], input=b"../HOME")
        self.git("update-index", "--add", "--cacheinfo", "120000," + blob.decode().strip() + ",src/link.ts")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "-qm", "link")
        with self.assertRaisesRegex(ValueError, "tracked link"):
            bundle.build(self.repo, self.git("rev-parse", "HEAD").decode().strip(), self.root / "bad")


if __name__ == "__main__":
    unittest.main()
