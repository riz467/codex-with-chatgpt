"""Local adversarial tests; no remote connection, key acquisition, root operation or Linux qualification."""
import hashlib
import importlib.util
import io
import json
import sys
import tarfile
import tempfile
import unittest
import types
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
import capsule
if sys.platform=='win32':sys.modules['pwd']=types.SimpleNamespace(getpwnam=lambda name:(_ for _ in ()).throw(KeyError(name)))
import deploy
def module(name,file):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).parent/file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
pve=module('pve','pve-operation.py');transport=module('transport','run-approved.py')
public=module('public_inputs','verify-public-inputs.py')
class Assets(unittest.TestCase):
    def setUp(self):self.tmp=tempfile.TemporaryDirectory(prefix='qualification-assets-');self.root=Path(self.tmp.name)
    def tearDown(self):self.tmp.cleanup()
    def archive(self,entries):
        file=self.root/'a.tar'
        with tarfile.open(file,'w') as t:
            for name,kind,mode,data in entries:
                m=tarfile.TarInfo(name);m.mode=mode
                if kind=='dir':m.type=tarfile.DIRTYPE;t.addfile(m)
                elif kind=='link':m.type=tarfile.SYMTYPE;m.linkname=data;t.addfile(m)
                elif kind=='hard':m.type=tarfile.LNKTYPE;m.linkname=data;t.addfile(m)
                else:m.size=len(data);t.addfile(m,io.BytesIO(data))
        return file,hashlib.sha256(file.read_bytes()).hexdigest()
    def reject(self,entries):
        f,h=self.archive(entries)
        with self.assertRaises(ValueError):capsule.verify_archive(f,h)
    def test_roundtrip_plain_archive(self):
        f,h=self.archive([('usr','dir',0o755,''),('usr/node','file',0o755,b'fixed bytes')]);self.assertEqual(len(capsule.verify_archive(f,h)),2)
    def test_sha_mismatch(self):
        f,h=self.archive([('node','file',0o644,b'x')]);
        with self.assertRaises(ValueError):capsule.verify_archive(f,'0'*64)
    def test_traversal(self):self.reject([('../escape','file',0o644,b'x')])
    def test_absolute(self):self.reject([('/escape','file',0o644,b'x')])
    def test_backslash(self):self.reject([('dir\\escape','file',0o644,b'x')])
    def test_drive(self):self.reject([('C:escape','file',0o644,b'x')])
    def test_duplicate(self):self.reject([('a','file',0o644,b'x'),('a','file',0o644,b'x')])
    def test_case_alias(self):self.reject([('a','file',0o644,b'x'),('A','file',0o644,b'x')])
    def test_symlink(self):self.reject([('a','link',0o644,'/root')])
    def test_hardlink(self):self.reject([('a','hard',0o644,'/root')])
    def test_suid(self):self.reject([('a','file',0o4755,b'x')])
    def test_world_write(self):self.reject([('a','file',0o666,b'x')])
    def test_parent_file(self):self.reject([('a','file',0o644,b'x'),('a/b','file',0o644,b'x')])
    def test_missing_parent(self):self.reject([('a/b','file',0o644,b'x')])
    def test_secret_path(self):self.reject([('auth.json','file',0o600,b'{}')])
    def test_secret_body(self):self.reject([('x','file',0o644,b'-----BEGIN PRIVATE KEY-----\n'+b'A'*128+b'\n-----END PRIVATE KEY-----')])
    def test_windows_reserved(self):self.reject([('NUL','file',0o644,b'x')])
    def test_wrong_elf_arch(self):
        data=bytearray(64);data[:6]=b'\x7fELF\x02\x01';data[18:20]=(183).to_bytes(2,'little')
        with self.assertRaises(ValueError):capsule.elf_dependencies(data)
    def test_unapproved_deployment_identity(self):
        with patch.object(deploy.os,'geteuid',return_value=1,create=True):
            with self.assertRaises(ValueError):deploy.execute('exec','executor','0'*64)
    def test_exec_requires_pre_before_any_command(self):
        with patch.object(deploy,'INPUT',self.root),patch.object(deploy.os,'geteuid',return_value=0,create=True),patch.object(deploy.socket,'gethostname',return_value='rc02-executor-117'),patch.object(deploy,'package',return_value={}),patch.object(deploy,'run') as command:
            with self.assertRaises(ValueError):deploy.execute('exec','executor','0'*64)
            command.assert_not_called()
    def test_forbidden_qga_vmid_no_socket(self):
        with patch.object(pve.socket,'socket') as socket:
            for vmid in [703,704,115,118]:
                with self.assertRaises(ValueError):pve.Qga(vmid)
            socket.assert_not_called()
    def test_transport_requires_explicit_approval_no_command(self):
        with patch.object(transport.subprocess,'run') as command:
            with self.assertRaises(ValueError):transport.run(self.root,'0'*64,'')
            command.assert_not_called()
    def test_transport_sha_failure_no_command(self):
        (self.root/'DEPLOYMENT-PACKAGE.json').write_text('{}')
        with patch.object(transport.subprocess,'run') as command:
            with self.assertRaises(ValueError):transport.run(self.root,'0'*64,'ACTUAL TEST AUTH REFERENCE')
            command.assert_not_called()
    def test_signed_checksum_section_only(self):
        self.assertTrue(public.signed_index_match('SHA256:\n abc 12 file\nSHA512:\n other 12 file','abc',12,'file'))
        self.assertFalse(public.signed_index_match('SHA512:\n abc 12 file','abc',12,'file'))
        self.assertFalse(public.signed_index_match('SHA256:\n abc 12 file\n abc 12 file','abc',12,'file'))
    def test_unsigned_inrelease_trailer_rejected_before_gpg(self):
        meta=self.root/'os-acquisition/metadata';meta.mkdir(parents=True)
        (meta/'noble-InRelease').write_text('-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\noriginal\n-----BEGIN PGP SIGNATURE-----\nx\n-----END PGP SIGNATURE-----\nFAKE CHECKSUM TRAILER\n')
        (meta/'noble-Packages.xz').write_bytes(b'x')
        with patch.object(public.subprocess,'run') as command:
            with self.assertRaisesRegex(ValueError,'UNSIGNED_INRELEASE_TRAILER'):public.verify(self.root,'gpg',self.root/'receipt.json')
            command.assert_not_called()
    def test_rollback_stop_failure_never_success(self):
        (self.root/'executor-PRE.json').write_text(json.dumps({'packageSha256':'a'*64,'snapshot':{}}))
        (self.root/'executor-CREATED.json').write_text(json.dumps({'packageSha256':'a'*64}))
        with patch.object(deploy,'INPUT',self.root),patch.object(deploy.os,'geteuid',return_value=0,create=True),patch.object(deploy.socket,'gethostname',return_value='rc02-executor-117'),patch.object(deploy,'package',return_value={}),patch.object(deploy,'run',side_effect=ValueError('STOP_FAILED')):
            with self.assertRaisesRegex(ValueError,'STOP_FAILED'):deploy.execute('rollback','executor','a'*64)
if __name__=='__main__':unittest.main(verbosity=2)
