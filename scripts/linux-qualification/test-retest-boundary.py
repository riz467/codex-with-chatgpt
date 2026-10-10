"""Offline-only retest boundary tests. Mock metadata is not live fencing/permission proof."""
import base64,hashlib,importlib.util,io,json,subprocess,sys,types,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
def load(name,file):
    s=importlib.util.spec_from_file_location(name,Path(__file__).parent/file);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
custody=load('custody_fixture','test-upload-custody.py');pve=custody.pve;deploy=custody.deploy
transport=load('retest_transport','run-approved.py')
from evidence import Journal,OperationFailure,require_external_fence
class Retest(unittest.TestCase):
    def setUp(self):self.f=custody.Upload();self.f.setUp();self.root=self.f.root
    def tearDown(self):self.f.tearDown()
    def test_fixed_fresh_roots_separate_all_prior_inputs(self):
        self.assertEqual(deploy.INPUT.as_posix(),pve.GUEST)
        self.assertEqual(len({pve.ROOT,pve.OLD_ROOT,pve.V2_ROOT}),3)
        self.assertEqual(len({deploy.INPUT,deploy.OLD_INPUT,deploy.V2_INPUT}),3)
        pve.fresh_host_path()
    def test_host_path_collision_rejected_before_open(self):
        for old in [pve.OLD_ROOT,pve.V2_ROOT,pve.V2_ROOT/'nested',pve.V2_ROOT.parent]:
            with patch.object(pve,'ROOT',old),patch.object(pve.os,'open') as opened:
                with self.assertRaisesRegex(ValueError,'FRESH_HOST_PATH_COLLISION'):pve.receive_host_input('capsule.tar',io.BytesIO(b'x'),1,'0'*64)
                opened.assert_not_called()
    def test_guest_path_collision_rejected_before_open(self):
        for old in [deploy.OLD_INPUT,deploy.V2_INPUT,deploy.V2_INPUT/'nested',deploy.V2_INPUT.parent]:
            with patch.object(deploy,'INPUT',old),patch.object(deploy.os,'open') as opened:
                with self.assertRaisesRegex(ValueError,'FRESH_INPUT_PATH_COLLISION'):deploy.prepare_upload('capsule.tar')
                opened.assert_not_called()
    def test_fresh_host_custody_primitives_and_prior_claims_unchanged(self):
        old=self.root/'prior-v2';old.mkdir();claim=old/'APPROVED-EXECUTION-CLAIM.json';claim.write_bytes(b'old-claim')
        key=old/'private-key';key.write_bytes(b'fixture-secret');before=deploy.tree_digest(old)
        fresh=self.root/'fresh-host';self.f.input=fresh;self.f.modes[fresh]=0o700
        files={'capsule.tar':hashlib.sha256(b'public').hexdigest(),'host-runtime.tar':hashlib.sha256(b'public').hexdigest()}
        donor=self.root/'donor';donor.write_bytes(b'public')
        # Gate mock exercises only custody mechanics; does not establish external fencing.
        with patch.object(pve,'require_external_fence'),patch.object(pve,'ROOT',fresh),patch.object(pve,'trusted_host_parents'),patch.object(pve,'old_host_custody',side_effect=lambda s:deploy.tree_digest(old)),patch.object(pve,'donor_file',side_effect=lambda *a:__import__('os').open(donor,__import__('os').O_RDONLY)),self.f.filesystem():
            r=pve.prepare_host_inputs({},files)
            self.assertTrue(r['oldCampaignUnchanged']);self.assertEqual(len(r['reused']),2)
            self.assertEqual(self.f.modes[fresh],0o700)
            for name,digest in files.items():
                self.assertEqual(hashlib.sha256((fresh/name).read_bytes()).hexdigest(),digest);self.assertEqual(self.f.modes[fresh/name],0o600)
            with self.assertRaises(FileExistsError):pve.prepare_host_inputs({},files)
        self.assertEqual(deploy.tree_digest(old),before);self.assertEqual(claim.read_bytes(),b'old-claim');self.assertEqual(key.read_bytes(),b'fixture-secret')
    def test_fresh_guest_upload_and_duplicate_rejection_preserve_prior_inputs(self):
        old=self.root/'prior-guest';old.mkdir();(old/'executor-PRE.json').write_bytes(b'old-pre');before=deploy.tree_digest(old)
        with self.f.filesystem():
            identity=deploy.prepare_upload('capsule.tar')
            with (self.f.input/'capsule.tar').open('r+b') as f:f.write(b'public')
            self.assertEqual(deploy.check_upload('capsule.tar',identity,6,hashlib.sha256(b'public').hexdigest())['result'],'UPLOAD_VERIFIED')
            with self.assertRaises(FileExistsError):deploy.prepare_upload('capsule.tar')
        self.assertEqual(deploy.tree_digest(old),before)
    def test_external_fence_has_no_human_or_file_or_lock_bypass(self):
        (self.root/'new.lock').write_bytes(b'held');(self.root/'EXTERNAL-FENCE.json').write_text('{"approved":true,"processesAbsent":true}')
        with self.assertRaises(OperationFailure) as caught:require_external_fence()
        self.assertEqual(caught.exception.classification,'UNKNOWN');self.assertFalse(caught.exception.fields['settled'])
    def test_old_process_ignores_new_lock_new_exec_still_rejected(self):
        events=[]
        def old_process():events.append('old-ignores-new-lock')
        old_process()
        with patch.object(deploy,'package') as package,patch.object(deploy,'run') as command:
            with self.assertRaises(OperationFailure):deploy.execute('exec','executor','0'*64,{})
        package.assert_not_called();command.assert_not_called();self.assertEqual(events,['old-ignores-new-lock'])
    def test_direct_host_main_rejected_before_any_access(self):
        with patch.object(pve,'resource_pre') as resources,patch.object(pve,'Qga') as qga:
            with self.assertRaises(OperationFailure):pve.main('0'*64,'human-reference','0'*64)
        resources.assert_not_called();qga.assert_not_called()
    def test_host_preparation_rejected_before_mkdir_keys_or_donor(self):
        with patch.object(pve,'old_host_custody') as old,patch.object(pve,'donor_file') as donor:
            with self.assertRaises(OperationFailure):pve.prepare_host_inputs({}, {})
        old.assert_not_called();donor.assert_not_called()
    def test_fixed_unit_start_rejected_before_verify_or_start(self):
        events=[]
        with self.assertRaises(OperationFailure):pve.start_fixed_units({},lambda e:events.append('verify'),lambda *a:events.append('start'))
        self.assertEqual(events,[])
    def bundle(self):
        bundle=self.root/'bundle';bundle.mkdir();files={}
        for name in pve.HOST_PUBLIC_NAMES-{'DEPLOYMENT-PACKAGE.json','PRE-COMPLETED.json'}:
            body=b'# fixture\n' if name.endswith('.py') else b'public';(bundle/name).write_bytes(body);files[name]=hashlib.sha256(body).hexdigest()
        m={'schema':1,'targetVmids':[116,117],'authority':'NONE','productionDispatch':'CLOSED','files':files}
        data=json.dumps(m).encode();(bundle/'DEPLOYMENT-PACKAGE.json').write_bytes(data)
        return bundle,hashlib.sha256(data).hexdigest()
    def test_hqo_fence_rejection_before_remote_with_failure_receipt(self):
        bundle,pin=self.bundle()
        with patch.object(transport,'readonly_transport') as pre,patch.object(transport,'command') as command:
            with self.assertRaises(OperationFailure):transport.run(bundle,pin,'human-reference')
        pre.assert_not_called();command.assert_not_called()
        rows=[json.loads(p.read_text()) for p in sorted((bundle/'hqo-operation-events').glob('*.json'))]
        first=next(r for r in rows if r['state']=='UNKNOWN')
        self.assertEqual(first['step'],'external-fence');self.assertEqual(first['fields']['classification'],'UNKNOWN')
        self.assertFalse((bundle/'PRE-COMPLETED.json').exists())
    def test_both_prior_regions_drift_fail_closed(self):
        for old,new in [({'release':'a','custodyV2':'a'},{'release':'a','custodyV2':'b'}),({'release':'a','custodyV2':'a'},{'release':'b','custodyV2':'a'})]:
            with self.assertRaisesRegex(ValueError,'OLD_HOST_CAMPAIGN_DRIFT'):pve.check_observation({'packageSha256':'x','oldHostCampaign':old},{'packageSha256':'x','oldHostCampaign':new})
            with self.assertRaisesRegex(ValueError,'PROTECTED_BASELINE_DRIFT'):deploy.check_baseline({'oldCampaignInputs':old},{'oldCampaignInputs':new})
    def test_missing_v2_guest_custody_never_inferred_safe(self):
        with patch.object(deploy,'V2_INPUT',self.root/'absent'),patch.object(deploy,'safe'):
            with self.assertRaises(FileNotFoundError):deploy.v2_guest_custody('executor')
        with patch.object(deploy,'V2_INPUT',self.f.input):
            with self.assertRaisesRegex(ValueError,'V2_CONTROLLER_INPUT_UNEXPECTED'):deploy.v2_guest_custody('controller')
    def test_actual_guest_cli_denies_before_stdin_or_journal(self):
        script=str(Path(__file__).parent/'deploy.py')
        # Execute actual __main__ locally via runpy; Windows pwd import is stubbed, no guest calls.
        code='import sys,types,runpy; sys.modules["pwd"]=types.ModuleType("pwd"); sys.path.insert(0,'+repr(str(Path(script).parent))+'); import evidence; evidence.Journal=lambda *a: (_ for _ in ()).throw(AssertionError("JOURNAL_MUST_NOT_RUN")); sys.stdin=types.SimpleNamespace(buffer=types.SimpleNamespace(read=lambda *a: (_ for _ in ()).throw(AssertionError("STDIN_MUST_NOT_RUN")))); sys.argv=['+repr(script)+',"exec","executor","'+'0'*64+'"]; runpy.run_path('+repr(script)+',run_name="__main__")'
        r=subprocess.run([sys.executable,'-I','-B','-c',code],capture_output=True,timeout=10)
        self.assertEqual(r.returncode,2);body=json.loads(r.stdout)
        self.assertEqual(body['failedStep'],'external-fence');self.assertEqual(body['failure']['classification'],'UNKNOWN');self.assertFalse(body['failure']['settled'])
    def test_host_top_level_fence_receipt_preserved_at_hqo(self):
        j=Journal(self.root/'events');body={'result':'PVE_FIXED_OPERATION_BLOCKED_NO_REPLAY','failedStep':'external-fence','failure':{'classification':'UNKNOWN','settled':False},'secret':'NEVER_SAVE'}
        error=OperationFailure('NONZERO_EXIT');error.completed=types.SimpleNamespace(stdout=json.dumps(body).encode())
        with patch.object(transport,'EVENTS',j),patch.object(transport,'process',side_effect=error):
            with self.assertRaises(OperationFailure):transport.command('transport.approved-adapter',['never executed'])
        saved=json.loads((j.directory/'validated-remote-failure.json').read_text())
        self.assertEqual(saved['failedStep'],'external-fence');self.assertFalse(saved['failure']['settled']);self.assertNotIn('secret',saved)
    def test_conflicting_control_flow_cannot_overwrite_host_fence(self):
        j=Journal(self.root/'mixed-events')
        body={'result':'PVE_FIXED_OPERATION_BLOCKED_NO_REPLAY','failedStep':'external-fence','failure':{'classification':'UNKNOWN','settled':False},'controlFlow':{'failure':{'classification':'SUCCESS','settled':True},'firstFailure':{'step':'later-pass','fields':{'classification':'SUCCESS'}}}}
        error=OperationFailure('NONZERO_EXIT');error.completed=types.SimpleNamespace(stdout=json.dumps(body).encode())
        with patch.object(transport,'EVENTS',j),patch.object(transport,'process',side_effect=error):
            with self.assertRaises(OperationFailure):transport.command('transport.approved-adapter',['never executed'])
        saved=json.loads((j.directory/'validated-remote-failure.json').read_text())
        self.assertEqual(saved['failure'],{'classification':'UNKNOWN','settled':False});self.assertNotIn('firstFailure',saved)
    def test_empty_or_invalid_guest_failure_never_settles(self):
        for body in [ {'result':'BLOCKED','failedStep':'package','failure':{}}, {'result':'BLOCKED','failedStep':'package','failure':{'classification':'SUCCESS','settled':True}}, {'result':'PASS','failedStep':'package','failure':{'classification':'PERMISSION','settled':True}}, {'result':'BLOCKED','failedStep':'package','failure':{'classification':'PERMISSION'}}, {'result':'BLOCKED','failedStep':'package','failure':{'classification':'PERMISSION','settled':1}} ]:
            q=pve.Qga.__new__(pve.Qga);q.call=lambda cmd,arg:{'pid':23} if cmd=='guest-exec' else {'exited':True,'exitcode':2,'out-data':base64.b64encode(json.dumps(body).encode()).decode()}
            with self.assertRaises(OperationFailure):q.python('never executed')
            self.assertTrue(q.execution_unknown);self.assertTrue(q.unsettled_child)
if __name__=='__main__':unittest.main(verbosity=2)
