"""Offline POSIX-metadata adversarial simulation; not a live QGA/OS permission certification."""
import copy,hashlib,importlib.util,io,json,os,stat,sys,tempfile,types,unittest
from contextlib import ExitStack,contextmanager
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
if sys.platform=='win32':sys.modules['pwd']=types.SimpleNamespace(getpwnam=lambda n:(_ for _ in ()).throw(KeyError(n)))
import deploy
spec=importlib.util.spec_from_file_location('pve',Path(__file__).parent/'pve-operation.py');pve=importlib.util.module_from_spec(spec);spec.loader.exec_module(pve)

class Upload(unittest.TestCase):
    def setUp(self):self.tmp=tempfile.TemporaryDirectory(prefix='custody-test-');self.root=Path(self.tmp.name);self.input=self.root/'new';self.input.mkdir();self.modes={self.input:0o700};self.owners={};self.links={};self.kinds={};self.fdpaths={};self.opens=[]
    def tearDown(self):self.tmp.cleanup()
    @contextmanager
    def filesystem(self):
        # Actual local bytes, exclusive create and inode checks; explicit POSIX metadata simulation
        # on Windows. No admin operations; do not interpret this as Linux isolation proof.
        original_open=os.open;original_stat=Path.lstat;original_fstat=os.fstat;nofollow=getattr(os,'O_NOFOLLOW',1<<28);directory=getattr(os,'O_DIRECTORY',1<<29)
        def info(p,s):return types.SimpleNamespace(st_dev=s.st_dev,st_ino=s.st_ino,st_uid=self.owners.get(p,0),st_mode=self.kinds.get(p,stat.S_IFDIR if p==self.input else stat.S_IFREG)|self.modes.get(p,0o600),st_nlink=self.links.get(p,1),st_size=s.st_size)
        def lstat(p,*a,**kw):return info(p,original_stat(p,*a,**kw)) if p==self.input or p.parent==self.input else original_stat(p,*a,**kw)
        def openfd(p,flags,mode=0o777):
            p=Path(p);self.opens.append((p,flags,mode))
            if flags&os.O_CREAT:self.modes[p]=mode
            if sys.platform=='win32' and p==self.input:return -99
            fd=original_open(p,flags&~(nofollow|directory) if sys.platform=='win32' else flags,mode);self.fdpaths[fd]=p;return fd
        def fstat(fd):return info(self.fdpaths[fd],original_fstat(fd))
        original_close=os.close;original_sync=os.fsync
        with ExitStack() as stack:
            for target,name,value in [(deploy,'INPUT',self.input),(deploy,'safe',lambda p,*a:None),(Path,'lstat',lstat),(os,'O_NOFOLLOW',nofollow),(os,'O_DIRECTORY',directory),(os,'open',openfd),(os,'fstat',fstat),(os,'close',lambda fd:None if fd==-99 else original_close(fd)),(os,'fsync',lambda fd:None if fd==-99 or sys.platform=='win32' else original_sync(fd))]:stack.enter_context(patch.object(target,name,value,create=True))
            yield
    def put(self,body=b'public',name='capsule.tar'):
        (self.input/name).write_bytes(body);return self.input/name
    def test_exclusive_0600_with_umask_zero(self):
        old=os.umask(0)
        try:
            with self.filesystem():
                identity=deploy.prepare_upload('capsule.tar');self.assertEqual(deploy.upload_identity('capsule.tar'),identity)
                _,flags,mode=self.opens[0];self.assertEqual(mode,0o600);self.assertTrue(flags&os.O_EXCL);self.assertTrue(flags&os.O_NOFOLLOW)
        finally:os.umask(old)
    def test_existing_file_rejected_without_overwrite(self):
        p=self.put(b'old')
        with self.filesystem():
            with self.assertRaises(FileExistsError):deploy.prepare_upload('capsule.tar')
        self.assertEqual(p.read_bytes(),b'old')
    def test_mode_0666_not_repaired(self):
        p=self.put();self.modes[p]=0o666
        with self.filesystem():
            with self.assertRaisesRegex(ValueError,'UPLOAD_FILE_CUSTODY'):deploy.upload_identity('capsule.tar')
        self.assertEqual(self.modes[p],0o666)
    def test_symlink_hardlink_owner_nonregular_rejected(self):
        p=self.put()
        for field,value in [('kinds',stat.S_IFLNK),('kinds',stat.S_IFIFO),('links',2),('owners',1000)]:
            getattr(self,field)[p]=value
            with self.filesystem():
                with self.assertRaises(ValueError):deploy.upload_identity('capsule.tar')
            getattr(self,field).clear()
    def test_directory_mode_owner_symlink_rejected(self):
        for field,value in [('modes',0o755),('owners',1000),('kinds',stat.S_IFLNK)]:
            getattr(self,field)[self.input]=value
            with self.filesystem():
                with self.assertRaises(ValueError):deploy.prepare_upload('capsule.tar')
            getattr(self,field).clear();self.modes[self.input]=0o700
    def test_unapproved_name_rejected_before_open(self):
        for name in ['../escape','/tmp/x','private-key.pem','executor-PRE.json','capsule.tar/child']:
            with self.filesystem():
                with self.assertRaisesRegex(ValueError,'FIXED_UPLOAD_NAME'):deploy.prepare_upload(name)
        self.assertEqual(self.opens,[])
    def test_final_sha_size_and_identity(self):
        with self.filesystem():
            identity=deploy.prepare_upload('capsule.tar');self.put(b'public')
            self.assertEqual(deploy.check_upload('capsule.tar',identity,6,hashlib.sha256(b'public').hexdigest())['result'],'UPLOAD_VERIFIED')
            with self.assertRaises(ValueError):deploy.check_upload('capsule.tar',identity,7,hashlib.sha256(b'public').hexdigest())
            with self.assertRaisesRegex(ValueError,'UPLOAD_FINAL_SHA'):deploy.check_upload('capsule.tar',identity,6,'0'*64)
            with self.assertRaisesRegex(ValueError,'UPLOAD_INODE_CHANGED'):deploy.check_upload('capsule.tar',{**identity,'inode':identity['inode']+1},6)
    def test_post_permissions_changed_rejected(self):
        with self.filesystem():
            identity=deploy.prepare_upload('capsule.tar');self.put();self.modes[self.input/'capsule.tar']=0o666
            with self.assertRaises(ValueError):deploy.check_upload('capsule.tar',identity,6)
    def qga(self,failure=None):
        q=pve.Qga.__new__(pve.Qga);events=[]
        def python(code,*a):
            events.append('prepare' if 'prepare_upload' in code else 'check-final' if "'"+hashlib.sha256(b'public').hexdigest()+"'" in code else 'check-before')
            q.execution_unknown=False
            if failure=='final' and events[-1]=='check-final':raise ValueError('UPLOAD_FINAL_SHA')
            return {'device':1,'inode':2}
        def call(command,args):
            events.append(command)
            if failure==command:raise TimeoutError('QGA_UNKNOWN')
            if command=='guest-file-open':self.assertEqual(args['mode'],'r+b');self.assertEqual(args['path'],pve.GUEST+'/capsule.tar');return 1
            if command=='guest-file-write':return {'count':0 if failure=='short' else 6}
            return {}
        q.python=python;q.call=call;q.events=events;return q
    def test_qga_order_rplus_flush_close_before_final_sha(self):
        f=self.root/'local';f.write_bytes(b'public');q=self.qga();q.upload('capsule.tar',f,{'evidence':'','capsule':'','deploy':''},hashlib.sha256(b'public').hexdigest())
        self.assertEqual(q.events,['prepare','guest-file-open','check-before','guest-file-write','guest-file-flush','guest-file-close','check-final'])
    def test_qga_short_timeout_flush_close_and_final_failure_never_retry(self):
        f=self.root/'local';f.write_bytes(b'public')
        for failure in ['short','guest-file-open','guest-file-write','guest-file-flush','guest-file-close','final']:
            q=self.qga(failure)
            with self.assertRaises((ValueError,TimeoutError)):q.upload('capsule.tar',f,{'evidence':'','capsule':'','deploy':''},hashlib.sha256(b'public').hexdigest())
            self.assertEqual(q.events.count('prepare'),1);self.assertLessEqual(q.events.count('guest-file-write'),1)
            if failure not in ['final']:self.assertTrue(q.execution_unknown)
    def test_qga_bad_source_or_name_no_calls(self):
        f=self.root/'local';f.write_bytes(b'public');q=self.qga()
        for name,digest in [('capsule.tar','0'*64),('../escape',hashlib.sha256(b'public').hexdigest())]:
            with self.assertRaises(ValueError):q.upload(name,f,{'evidence':'','capsule':'','deploy':''},digest)
        self.assertEqual(q.events,[])
    def test_old_guest_input_drift_fences(self):
        with self.assertRaisesRegex(ValueError,'PROTECTED_BASELINE_DRIFT'):deploy.check_baseline({'oldCampaignInputs':{'sha256':'old'}},{'oldCampaignInputs':{'sha256':'new'}})
    def test_old_host_drift_fences(self):
        with self.assertRaisesRegex(ValueError,'OLD_HOST_CAMPAIGN_DRIFT'):pve.check_observation({'packageSha256':'x','oldHostCampaign':'old'},{'packageSha256':'x','oldHostCampaign':'new'})
    def test_old_and_new_scopes_distinct(self):
        self.assertNotEqual(pve.ROOT,pve.OLD_ROOT);self.assertNotEqual(deploy.INPUT,deploy.OLD_INPUT);self.assertEqual(deploy.INPUT.as_posix(),pve.GUEST)
    def test_reuse_only_public_archive_no_keys(self):
        for name in ['private-campaign-keys','PRE-COMPLETED.json','raw-source.tar','APPROVED-EXECUTION-CLAIM.json']:
            with self.assertRaisesRegex(ValueError,'FIXED_PUBLIC_REUSE_NAME'):pve.donor_file(name,'0'*64)
    def test_host_receive_no_partial_success_existing_rejected(self):
        with patch.object(pve,'ROOT',self.input),patch.object(pve,'trusted_host_directory'),self.filesystem():
            with self.assertRaisesRegex(ValueError,'HOST_TRANSFER_SHA'):pve.receive_host_input('capsule.tar',io.BytesIO(b'pub'),6,'0'*64)
            with self.assertRaises(FileExistsError):pve.receive_host_input('capsule.tar',io.BytesIO(b'public'),6,hashlib.sha256(b'public').hexdigest())
        self.assertEqual((self.input/'capsule.tar').read_bytes(),b'pub')
    def test_old_claim_not_deleted_by_host_prepare_existing_target(self):
        old=self.root/'old-claim';old.write_bytes(b'original')
        with patch.object(pve,'ROOT',self.input),patch.object(pve,'trusted_host_parents'),patch.object(pve,'old_host_custody',return_value={'sha':'old'}),patch.object(pve,'donor_file') as donor:
            with self.assertRaises(FileExistsError):pve.prepare_host_inputs({},{});donor.assert_not_called()
        self.assertEqual(old.read_bytes(),b'original')
    def test_host_success_and_fd_permissions_checked(self):
        with patch.object(pve,'ROOT',self.input),patch.object(pve,'trusted_host_directory'),self.filesystem():
            self.assertEqual(pve.receive_host_input('capsule.tar',io.BytesIO(b'public'),6,hashlib.sha256(b'public').hexdigest())['bytes'],6)
        self.assertEqual(self.modes[self.input/'capsule.tar'],0o600)
    def test_host_fd_hardlink_or_wrong_owner_rejected(self):
        for field,value in [('links',2),('owners',1000)]:
            p=self.input/'capsule.tar';getattr(self,field)[p]=value
            with patch.object(pve,'ROOT',self.input),patch.object(pve,'trusted_host_directory'),self.filesystem():
                with self.assertRaisesRegex(ValueError,'HOST_CREATE_CUSTODY'):pve.receive_host_input('capsule.tar',io.BytesIO(b'public'),6,hashlib.sha256(b'public').hexdigest())
            self.assertEqual(p.read_bytes(),b'');p.unlink();getattr(self,field).clear()
    def test_qga_check_failure_then_close_timeout_is_unknown(self):
        f=self.root/'local';f.write_bytes(b'public');q=self.qga('guest-file-close');original=q.python
        def fail_check(code,*a):
            value=original(code,*a)
            if 'check_upload' in code:raise ValueError('UPLOAD_CUSTODY')
            return value
        q.python=fail_check
        with self.assertRaises(TimeoutError):q.upload('capsule.tar',f,{'evidence':'','capsule':'','deploy':''},hashlib.sha256(b'public').hexdigest())
        self.assertTrue(q.execution_unknown);self.assertNotIn('guest-file-write',q.events)
    def test_missing_known_old_guest_inputs_fail_closed(self):
        with patch.object(deploy,'OLD_INPUT',self.root/'absent'),patch.object(deploy,'safe'):
            with self.assertRaises(FileNotFoundError):deploy.old_guest_custody('executor')
        with patch.object(deploy,'OLD_INPUT',self.input):
            with self.assertRaisesRegex(ValueError,'OLD_CONTROLLER_INPUT_UNEXPECTED'):deploy.old_guest_custody('controller')
    def test_old_tree_inode_and_hardlink_metadata_retained(self):
        p=self.root/'old';p.mkdir();(p/'public').write_bytes(b'public')
        original=Path.lstat
        def altered(path,*a,**kw):
            s=original(path,*a,**kw)
            if path!=p/'public':return s
            return types.SimpleNamespace(st_uid=s.st_uid,st_gid=s.st_gid,st_mode=s.st_mode,st_dev=s.st_dev,st_ino=s.st_ino+1,st_nlink=2,st_size=s.st_size)
        before=deploy.tree_digest(p)
        with patch.object(Path,'lstat',altered):after=deploy.tree_digest(p)
        self.assertNotEqual(before,after)
    def test_windows_safe_framing_keeps_source_off_command_line(self):
        # Exercise the actual transport with a mock approved bundle; no SSH is launched.
        s=importlib.util.spec_from_file_location('transport',Path(__file__).parent/'run-approved.py');t=importlib.util.module_from_spec(s);s.loader.exec_module(t)
        bundle=self.root/'bundle';bundle.mkdir();files={}
        for name in pve.HOST_PUBLIC_NAMES-{'PRE-COMPLETED.json','DEPLOYMENT-PACKAGE.json'}:
            content=b'# public adapter\n' if name.endswith('.py') else b'public';(bundle/name).write_bytes(content);files[name]=hashlib.sha256(content).hexdigest()
        manifest={'schema':1,'targetVmids':[116,117],'authority':'NONE','productionDispatch':'CLOSED','files':files};data=json.dumps(manifest).encode();(bundle/'DEPLOYMENT-PACKAGE.json').write_bytes(data)
        evidence={'oldHostCampaign':'fixed','targets':{'executor':{'snapshot':{}},'controller':{'snapshot':{}}}}
        calls=[]
        def command(argv,**kw):
            calls.append((argv,kw));self.assertLess(sum(len(str(v)) for v in argv),4096)
            if len(calls)==1:self.assertEqual(argv[-1],'python3 -I -B -');self.assertIn(b'prepare_host_inputs',kw['input'])
            elif 'input' in kw:
                frame=kw['input'];header,tail=frame.split(b'\n',1);n=int(header);self.assertIn(b'receive_host_input',tail[:n]);self.assertLessEqual(n,1048576)
            return types.SimpleNamespace(returncode=0,stdout=b'{"result":"PASS"}')
        with patch.object(t,'readonly_transport',return_value=evidence),patch.object(t,'process',side_effect=lambda journal,step,args,timeout,**kw:command(args,**kw)):t.run(bundle,hashlib.sha256(data).hexdigest(),'test-only-human-record')
        self.assertEqual(len(calls),15) # prepare +13 small files + final invocation
    def test_actual_loader_complete_truncated_oversize_frames(self):
        import subprocess
        s=importlib.util.spec_from_file_location('t',Path(__file__).parent/'run-approved.py');t=importlib.util.module_from_spec(s);s.loader.exec_module(t)
        code='import sys; data=sys.stdin.buffer.read(); assert data==b"public"; print("FRAME_PASS")'
        complete=t.frame_source(code,b'public')
        for frame,success in [(complete,True),(b'9999999\n',False),(str(len(code)+1).encode()+b'\n'+code.encode(),False),(complete[:-1],False)]:
            r=subprocess.run([sys.executable,'-I','-B','-c',t.FRAME_LOADER],input=frame,capture_output=True,timeout=10)
            self.assertEqual(r.returncode==0,success)
            self.assertEqual(b'FRAME_PASS' in r.stdout,success)
        with self.assertRaisesRegex(ValueError,'PUBLIC_FRAME_BOUND'):t.frame_source('x'*1048577,b'')

if __name__=='__main__':unittest.main(verbosity=2)
