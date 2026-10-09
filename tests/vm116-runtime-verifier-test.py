import importlib.util
import hashlib
import json
import tempfile
import io
import tarfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('verify', Path(__file__).parents[1] / 'scripts/vm116/verify-runtime.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
extract_spec = importlib.util.spec_from_file_location('extract', Path(__file__).parents[1] / 'scripts/vm116/extract-runtime.py')
extractor = importlib.util.module_from_spec(extract_spec)
extract_spec.loader.exec_module(extractor)

class VerifierTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'package.json').write_bytes(b'{}')
        self.manifest = dict(schema=1, baselineCommit=module.BASE, sourceCommit=module.BASE, scope='health-only-staging', node='24.16.0', dispatch='CLOSED', authority='NONE', files=[dict(path='package.json', bytes=2, mode='0644', sha256=hashlib.sha256(b'{}').hexdigest())])
    def tearDown(self):
        self.temp.cleanup()
    def run_verify(self):
        raw = json.dumps(self.manifest).encode()
        (self.root / 'RUNTIME-MANIFEST.json').write_bytes(raw)
        return module.verify(self.root, hashlib.sha256(raw).hexdigest())
    def test_valid(self):
        self.assertEqual(self.run_verify()['status'], 'PASS')
    def test_tamper(self):
        (self.root / 'package.json').write_bytes(b'[]')
        with self.assertRaises(AssertionError): self.run_verify()
    def test_extra(self):
        (self.root / 'extra').write_bytes(b'x')
        with self.assertRaises(AssertionError): self.run_verify()
    def test_missing(self):
        (self.root / 'package.json').unlink()
        with self.assertRaises(AssertionError): self.run_verify()
    def test_escape(self):
        self.manifest['files'][0]['path'] = '../escape'
        with self.assertRaises(AssertionError): self.run_verify()
    def test_absolute(self):
        self.manifest['files'][0]['path'] = '/escape'
        with self.assertRaises(AssertionError): self.run_verify()
    def test_duplicate(self):
        self.manifest['files'].append(self.manifest['files'][0].copy())
        with self.assertRaises(AssertionError): self.run_verify()
    def test_wrong_authority(self):
        self.manifest['authority'] = 'SIGNER'
        with self.assertRaises(AssertionError): self.run_verify()
    def test_wrong_hash(self):
        self.run_verify()
        with self.assertRaises(AssertionError): module.verify(self.root, '0'*64)

class ExtractTests(unittest.TestCase):
    setUp = VerifierTests.setUp
    tearDown = VerifierTests.tearDown
    run_verify = VerifierTests.run_verify
    def make_archive(self, extra=None):
        self.run_verify()
        archive = self.root / 'runtime.tar'
        with tarfile.open(archive, 'w', format=tarfile.USTAR_FORMAT) as tar:
            for name in ['package.json', 'RUNTIME-MANIFEST.json']:
                data = (self.root/name).read_bytes()
                info = tarfile.TarInfo(name)
                info.size, info.mode = len(data), 0o644
                tar.addfile(info, io.BytesIO(data))
            if extra:
                tar.addfile(extra, io.BytesIO(b'x') if extra.isreg() else None)
        return archive, hashlib.sha256(archive.read_bytes()).hexdigest(), hashlib.sha256((self.root/'RUNTIME-MANIFEST.json').read_bytes()).hexdigest()
    def test_extract_valid(self):
        self.assertEqual(extractor.extract(*self.make_archive(), self.root/'new')['status'], 'PASS')
    def test_extract_escape(self):
        info = tarfile.TarInfo('../outside'); info.size=1; info.mode=0o644
        with self.assertRaises(ValueError): extractor.extract(*self.make_archive(info), self.root/'new')
        self.assertFalse((self.root/'new').exists())
    def test_extract_symlink(self):
        info = tarfile.TarInfo('link'); info.type=tarfile.SYMTYPE; info.linkname='/etc/passwd'; info.mode=0o644
        with self.assertRaises(ValueError): extractor.extract(*self.make_archive(info), self.root/'new')
    def test_extract_duplicate(self):
        info = tarfile.TarInfo('package.json'); info.size=1; info.mode=0o644
        with self.assertRaises(ValueError): extractor.extract(*self.make_archive(info), self.root/'new')
    def test_extract_existing(self):
        with self.assertRaises(ValueError): extractor.extract(*self.make_archive(), self.root)
    def test_extract_wrong_sha(self):
        archive, digest, manifest = self.make_archive()
        with self.assertRaises(ValueError): extractor.extract(archive, '0'*64, manifest, self.root/'new')

if __name__ == '__main__': unittest.main()
