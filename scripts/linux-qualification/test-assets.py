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
import copy
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
    def valid_bundle(self):
        names=['capsule.tar','host-runtime.tar','raw-source.tar','source.tar','deploy.py','capsule.py','evidence.py','broker.service','controller.service','executor@.service','provision-keys.py','pve-operation.py','run-approved.py']
        for name in names:(self.root/name).write_bytes(b'fixed public bytes')
        m={'schema':1,'targetVmids':[116,117],'authority':'NONE','productionDispatch':'CLOSED','files':{name:capsule.file_sha(self.root/name) for name in names}}
        (self.root/'DEPLOYMENT-PACKAGE.json').write_text(json.dumps(m));return capsule.file_sha(self.root/'DEPLOYMENT-PACKAGE.json')
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
        with patch.object(deploy,'require_external_fence'),patch.object(deploy.os,'geteuid',return_value=1,create=True):
            with self.assertRaises(ValueError):deploy.execute('exec','executor','0'*64)
    def test_exec_requires_pre_before_any_command(self):
        with patch.object(deploy,'require_external_fence'),patch.object(deploy,'INPUT',self.root),patch.object(deploy.os,'geteuid',return_value=0,create=True),patch.object(deploy.socket,'gethostname',return_value='rc02-executor-117'),patch.object(deploy,'package',return_value={}),patch.object(deploy,'run') as command:
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
    def test_either_pre_failure_never_calls_exec_or_rollback(self):
        for role in ['executor','controller']:
            events=[]
            def pre():events.append('pre:'+role);raise ValueError('PRE_FAIL')
            with self.assertRaisesRegex(ValueError,'PRE_FAIL'):
                pve.two_phase(pre,lambda e:events.append('verify'),lambda t,e:events.append('exec'),lambda e:events.append('post'),lambda t:events.append('rollback'))
            self.assertEqual(events,['pre:'+role])
    def test_all_pre_then_both_rechecks_before_each_exec_and_post(self):
        events=[]
        result=pve.two_phase(lambda:events.append('both-pre') or {},lambda e:events.append('verify-both'),lambda t,e:events.append('exec:'+t[1]),lambda e:events.append('post'),lambda t:events.append('rollback'))
        self.assertEqual(result['result'],'PASS');self.assertEqual(events,['both-pre','verify-both','verify-both','exec:executor','verify-both','exec:controller','verify-both','post','verify-both'])
    def test_service_pid_network_configuration_credential_drift_blocks(self):
        old={'hostname':'rc02-executor-117','bootId':'fixed','units':{},'protectedHashes':{},'executorProtection':{'services':{'qga':{'MainPID':'10','start':'123'}},'network':{'routes':['fixed']},'trees':{'config':'hash','sshKey':'hash'}}}
        for mutate in [lambda r:r['executorProtection']['services']['qga'].update(MainPID='11'),lambda r:r['executorProtection']['services']['qga'].update(start='124'),lambda r:r['executorProtection']['network'].update(routes=['new']),lambda r:r['executorProtection']['trees'].update(config='changed'),lambda r:r['executorProtection']['trees'].update(sshKey='changed')]:
            new=copy.deepcopy(old);mutate(new)
            with self.assertRaisesRegex(ValueError,'PROTECTED_BASELINE_DRIFT'):deploy.check_baseline(old,new)
    def test_preexec_drift_no_dispatch_no_rollback(self):
        events=[]
        def verify(e):raise ValueError('BASELINE_DRIFT')
        with self.assertRaises(ValueError):pve.two_phase(lambda:{},verify,lambda t,e:events.append('exec'),lambda e:events.append('dispatch'),lambda t:events.append('rollback'))
        self.assertEqual(events,[])
    def test_midway_failure_only_attempted_targets_reverse_cleanup(self):
        events=[]
        def execute(t,e):
            events.append('exec:'+t[1])
            if t[1]=='controller':raise ValueError('MID_INSTALL_FAILED')
        result=pve.two_phase(lambda:{},lambda e:None,execute,lambda e:events.append('dispatch'),lambda t:events.append('rollback:'+t[1]) or {'result':'STOPPED'})
        self.assertEqual(result['result'],'STOPPED_NO_REPLAY');self.assertEqual(events,['exec:executor','exec:controller','rollback:controller','rollback:executor'])
    def test_unknown_execution_never_retries_and_cleanup_unknown_preserved(self):
        events=[]
        def execute(t,e):events.append(t[1]);raise TimeoutError('OUTCOME_UNKNOWN')
        def rollback(t):raise TimeoutError('CLEANUP_UNKNOWN')
        result=pve.two_phase(lambda:{},lambda e:None,execute,lambda e:events.append('dispatch'),rollback)
        self.assertEqual(events,['executor']);self.assertEqual(result['rollback'],[{'result':'UNKNOWN_HUMAN_INSPECTION_REQUIRED'}])
    def test_late_post_drift_routes_to_bounded_cleanup(self):
        events=[]
        def post(e):raise ValueError('VM117_POST_DRIFT')
        r=pve.two_phase(lambda:{},lambda e:None,lambda t,e:events.append('exec:'+t[1]),post,lambda t:events.append('stop:'+t[1]) or {})
        self.assertEqual(r['result'],'STOPPED_NO_REPLAY');self.assertEqual(events,['exec:executor','exec:controller','stop:controller','stop:executor'])
    def test_readonly_pre_does_not_write_generate_or_upload(self):
        role='controller';s={'memAvailableKiB':9999999,'diskFreeBytes':99*1024**3}
        with patch.object(deploy.os,'geteuid',return_value=0,create=True),patch.object(deploy.socket,'gethostname',return_value='ai-control-116'),patch.object(deploy,'snapshot',return_value=s),patch.object(deploy,'resource_gate'),patch.object(deploy,'management_preconditions'),patch.object(deploy,'write') as write,patch.object(deploy.pwd,'getpwnam',side_effect=KeyError):
            self.assertEqual(deploy.readonly_pre(role,'a'*64)['snapshot'],s);write.assert_not_called()
    def test_transport_pre_failure_no_remote_mkdir_scp_keys(self):
        pin=self.valid_bundle()
        with patch.object(transport,'require_external_fence'),patch.object(transport,'readonly_transport',side_effect=ValueError('PRE_FAILED')),patch.object(transport.subprocess,'run') as command:
            with self.assertRaisesRegex(ValueError,'PRE_FAILED'):transport.run(self.root,pin,'test-only-reference')
            command.assert_not_called();self.assertFalse((self.root/'PRE-COMPLETED.json').exists())
    def test_transport_existing_claim_fences_replay(self):
        pin=self.valid_bundle()
        (self.root/'PRE-COMPLETED.json').write_text('prior claim')
        with patch.object(transport,'require_external_fence'),patch.object(transport,'readonly_transport',return_value={}),patch.object(transport.subprocess,'run') as command:
            with self.assertRaises(FileExistsError):transport.run(self.root,pin,'test-only-reference')
            command.assert_not_called()
    def test_network_ttl_normalized_but_real_route_change_retained(self):
        old=[{'dst':'default','gateway':'192.168.0.1','expires':50}]
        self.assertEqual(deploy.stable_network(old),deploy.stable_network([{**old[0],'expires':10}]))
        self.assertNotEqual(deploy.stable_network(old),deploy.stable_network([{**old[0],'gateway':'192.168.0.2'}]))
    def test_existing_tree_state_digest_detects_bytes_and_links_without_body(self):
        (self.root/'credential').write_text('test-only-private-bytes');old=deploy.tree_digest(self.root)
        self.assertNotIn('test-only-private-bytes',json.dumps(old));(self.root/'credential').write_text('changed');self.assertNotEqual(old,deploy.tree_digest(self.root))
    def test_qga_sentinel_error_discarded_only_during_sync(self):
        q=pve.Qga.__new__(pve.Qga);q.counter=0;q.syncing=True;q.sock=types.SimpleNamespace(sendall=lambda data:None)
        q.reader=io.BytesIO(b'{"error":{"class":"GenericError"}}\n\xff{"return":123,"id":1}\n')
        self.assertEqual(q.call('guest-sync-delimited'),123)
        q.syncing=False;q.reader=io.BytesIO(b'{"error":{"class":"GenericError"},"id":2}\n')
        with self.assertRaisesRegex(ValueError,'QGA_OPERATION_REJECTED'):q.call('guest-exec')
    def test_qga_response_id_mismatch_rejected(self):
        q=pve.Qga.__new__(pve.Qga);q.counter=0;q.syncing=False;q.sock=types.SimpleNamespace(sendall=lambda data:None);q.reader=io.BytesIO(b'{"return":1,"id":9}\n')
        with self.assertRaisesRegex(ValueError,'QGA_RESPONSE_BINDING'):q.call('guest-exec')
    def test_missing_authenticated_adapter_rejected_before_transport(self):
        self.valid_bundle();m=json.loads((self.root/'DEPLOYMENT-PACKAGE.json').read_text());del m['files']['deploy.py'];(self.root/'DEPLOYMENT-PACKAGE.json').write_text(json.dumps(m));pin=capsule.file_sha(self.root/'DEPLOYMENT-PACKAGE.json')
        with patch.object(transport,'readonly_transport') as pre:
            with self.assertRaisesRegex(ValueError,'FIXED_PACKAGE_SCHEMA'):transport.run(self.root,pin,'test-only-reference')
            pre.assert_not_called()
    def test_broker_start_drift_fences_controller_start(self):
        events=[]
        def verify(e):
            if events:raise ValueError('BROKER_START_CHANGED_VM117')
        with patch.object(pve,'require_external_fence'):
            with self.assertRaises(ValueError):pve.start_fixed_units({},verify,lambda vmid,unit:events.append(unit))
        self.assertEqual(events,['ai-linux-qualification-broker.service'])
    def test_stale_sync_nonce_rejected(self):
        fake=types.SimpleNamespace(settimeout=lambda t:None,connect=lambda p:None,makefile=lambda mode:types.SimpleNamespace(),sendall=lambda b:None)
        with patch.object(pve.socket,'AF_UNIX',1,create=True),patch.object(pve.socket,'socket',return_value=fake),patch.object(pve.Qga,'call',return_value=123),patch.object(pve.os,'urandom',return_value=b'\x01'*8):
            with self.assertRaisesRegex(ValueError,'QGA_SYNC_NONCE_BINDING'):pve.Qga(117)
    def test_original_pid_unsettled_never_claims_cleanup(self):
        q=types.SimpleNamespace(call=lambda cmd,arg:{'exited':False})
        with self.assertRaisesRegex(ValueError,'ORIGINAL_GUEST_EXEC_STILL_UNKNOWN'):pve.settle_original(q,111)
        with self.assertRaisesRegex(ValueError,'ORIGINAL_GUEST_EXEC_PID_UNKNOWN'):pve.settle_original(q,None)
        self.assertIsNone(pve.settle_original(types.SimpleNamespace(call=lambda c,a:{'exited':True}),111))
    def test_directory_alias_target_changes_and_cycles_detected(self):
        alias=self.root/'alias';target=self.root/'target';alias.mkdir();target.mkdir();(target/'credential').write_bytes(b'old')
        orig_link=Path.is_symlink;orig_resolve=Path.resolve
        def linked(p):return p==alias or orig_link(p)
        def resolved(p,*a,**kw):return target if p==alias else orig_resolve(p,*a,**kw)
        with patch.object(Path,'is_symlink',linked),patch.object(Path,'resolve',resolved),patch.object(deploy.os,'readlink',return_value=str(target)):
            old=deploy.tree_digest(alias);(target/'credential').write_bytes(b'new');self.assertNotEqual(old,deploy.tree_digest(alias))
        (alias/'loop').mkdir();loop=alias/'loop'
        def linked_cycle(p):return p==loop or orig_link(p)
        def resolved_cycle(p,*a,**kw):return alias if p==loop else orig_resolve(p,*a,**kw)
        with patch.object(Path,'is_symlink',linked_cycle),patch.object(Path,'resolve',resolved_cycle),patch.object(deploy.os,'readlink',return_value=str(alias)):
            with self.assertRaisesRegex(ValueError,'BASELINE_LINK_CYCLE'):deploy.tree_digest(alias)
    def test_effective_runtime_network_and_pam_config_drift_blocks(self):
        paths=deploy.effective_config_paths('systemd-networkd.service',[])
        self.assertIn('/run/systemd/network',paths);self.assertIn('/usr/local/lib/systemd/network',paths);self.assertIn('/run/systemd/networkd.conf.d',paths)
        self.assertIn('/etc/pam.d',deploy.effective_config_paths('getty@tty1.service',[]))
        for name in ['runtime-network-config','pam-common-auth']:
            p=self.root/name;p.mkdir();(p/'config').write_bytes(b'old')
            old={'executorProtection':{'trees':{str(p):deploy.tree_digest(p)}}};(p/'config').write_bytes(b'new')
            with self.assertRaisesRegex(ValueError,'PROTECTED_BASELINE_DRIFT'):deploy.check_baseline(old,{'executorProtection':{'trees':{str(p):deploy.tree_digest(p)}}})
    def test_failure_always_checks_both_post_even_absent_claim(self):
        events=[]
        def verify(e):events.append('both-verify')
        def execute(t,e):events.append('transfer-failure');raise ValueError('TRANSFER_FAILED')
        result=pve.two_phase(lambda:{},verify,execute,lambda e:None,lambda t:events.append('no-claim-inputs-retained') or {})
        self.assertEqual(events[-2:],['no-claim-inputs-retained','both-verify']);self.assertEqual(result['finalProtection'],'BOTH_TARGETS_UNCHANGED');self.assertEqual(result['result'],'STOPPED_NO_REPLAY')
    def test_failure_final_protection_unknown_is_explicit(self):
        n=0
        def verify(e):
            nonlocal n
            n+=1
            if n>=3:raise ValueError('FINAL_PROTECTION_UNKNOWN')
        def execute(t,e):raise TimeoutError('UNKNOWN')
        result=pve.two_phase(lambda:{},verify,execute,lambda e:None,lambda t:{})
        self.assertEqual(result['finalProtection'],'UNKNOWN_OR_DRIFT_HUMAN_INSPECTION_REQUIRED');self.assertEqual(result['result'],'STOPPED_NO_REPLAY')
    def test_observe_second_target_even_when_first_or_host_resource_fails(self):
        events=[]
        class FakeQga:
            def __init__(self,vmid):self.vmid=vmid
            def python(self,code,timeout):
                events.append(self.vmid)
                if self.vmid==117:raise ValueError('FIRST_FAILED')
                return {'snapshot':{}}
            def close(self):pass
        with patch.object(pve.os,'geteuid',return_value=0,create=True),patch.object(pve.socket,'gethostname',return_value='pve5'),patch.object(pve,'resource_pre',side_effect=ValueError('HEADROOM')),patch.object(pve,'Qga',FakeQga):
            with self.assertRaisesRegex(ValueError,'ALL_TARGET_OBSERVATION_BLOCKED') as caught:pve.observe({'evidence':'','capsule':'','deploy':''},'a'*64,False)
            self.assertEqual(events,[117,116]);self.assertIn('controller',caught.exception.evidence['targets'])
if __name__=='__main__':unittest.main(verbosity=2)
