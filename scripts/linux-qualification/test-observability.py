"""Offline-only evidence/exit tests; no QGA constructor, sockets, deploy, kill or secret acquisition."""
import base64,importlib.util,json,sys,tempfile,types,unittest,subprocess
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
from evidence import Journal,EvidenceFailure,OperationFailure,process
import evidence
spec=importlib.util.spec_from_file_location('pve_obs',Path(__file__).parent/'pve-operation.py');pve=importlib.util.module_from_spec(spec);spec.loader.exec_module(pve)
class Obs(unittest.TestCase):
    def setUp(self):self.tmp=tempfile.TemporaryDirectory(prefix='obs-');self.root=Path(self.tmp.name);self.j=Journal(self.root/'events')
    def tearDown(self):self.tmp.cleanup()
    def rows(self):return [json.loads(p.read_text()) for p in sorted(self.j.directory.glob('*.json'))]
    def test_success_events_and_process_identity(self):
        self.assertEqual(self.j.run('install.package',lambda:3),3)
        self.assertEqual([r['state'] for r in self.rows()],['BEGIN','SUCCESS']);self.assertGreater(self.rows()[0]['pid'],0)
    def test_distinct_failures_previously_same_receipt_now_distinct(self):
        failures=[]
        for n,error in enumerate([PermissionError('SECRET_TOKEN'),TimeoutError('SECRET_TOKEN'),ValueError('SECRET_TOKEN'),OperationFailure('UNKNOWN',settled=False)]):
            j=Journal(self.root/str(n))
            def execute(target,old):raise error
            result=pve.two_phase(lambda:{},lambda old:None,execute,lambda old:None,lambda t:{'result':'STOPPED'},j)
            failures.append(result['failure']['classification']);self.assertEqual(result['firstFailure']['step'],'install.executor')
            self.assertNotIn('SECRET_TOKEN',json.dumps(result));self.assertEqual(result['finalProtection'],'BOTH_TARGETS_UNCHANGED')
        self.assertEqual(failures,['PERMISSION','TIMEOUT','VALIDATION','UNKNOWN'])
    def test_rollback_failure_separate_first_failure_not_overwritten(self):
        def execute(t,e):raise PermissionError('PRIVATE_PAYLOAD')
        def rollback(t):raise TimeoutError('PRIVATE_PAYLOAD')
        r=pve.two_phase(lambda:{},lambda e:None,execute,lambda e:None,rollback,self.j)
        self.assertEqual(r['firstFailure']['fields']['classification'],'PERMISSION');self.assertEqual(r['rollback'][0]['failure']['classification'],'TIMEOUT')
        self.assertEqual(r['rollback'][0]['result'],'UNKNOWN_HUMAN_INSPECTION_REQUIRED');self.assertNotIn('PRIVATE_PAYLOAD',json.dumps(self.rows()))
    def test_save_failure_before_side_effect_stops(self):
        calls=[]
        with patch.object(evidence.os,'fsync',side_effect=OSError('SECRET')):
            with self.assertRaises(EvidenceFailure):self.j.run('install.claim',lambda:calls.append(1))
        self.assertEqual(calls,[]);self.assertTrue(self.j.broken)
        with self.assertRaises(EvidenceFailure):self.j.emit('later','BEGIN')
    def test_save_failure_after_action_not_replayed_or_pass(self):
        count=[];real=self.j.emit
        def emit(step,state,**fields):
            if state=='SUCCESS':raise EvidenceFailure('FAIL')
            return real(step,state,**fields)
        with patch.object(self.j,'emit',side_effect=emit):
            with self.assertRaises(EvidenceFailure):self.j.run('install.claim',lambda:count.append(1))
        self.assertEqual(count,[1])
    def test_evidence_failure_does_not_start_rollback(self):
        calls=[]
        def execute(t,e):raise EvidenceFailure('BROKEN')
        with self.assertRaises(EvidenceFailure):pve.two_phase(lambda:{},lambda e:None,execute,lambda e:None,lambda t:calls.append(1),self.j)
        self.assertEqual(calls,[])
    def test_existing_journal_cannot_resume_or_overwrite(self):
        with self.assertRaises(EvidenceFailure):Journal(self.j.directory)
    def test_unapproved_fields_never_persisted(self):
        with self.assertRaises(EvidenceFailure):self.j.emit('fixture','FAIL',message='PEM_SECRET')
        self.assertEqual(self.rows(),[])
    def test_guest_known_exit_signal_and_sanitized_failure(self):
        for response,expected in [({'exitcode':2},'NONZERO_EXIT'),({'signal':9},'SIGNAL')]:
            q=pve.Qga.__new__(pve.Qga);q.vmid=117
            body={'result':'BLOCKED','failedStep':'package','failure':{'classification':'PERMISSION','errorClass':'PermissionError','settled':True}}
            q.call=lambda cmd,arg:{'pid':22} if cmd=='guest-exec' else {'exited':True,'out-data':base64.b64encode(json.dumps(body).encode()).decode(),**response}
            with patch.object(pve,'ACTIVE_JOURNAL',self.j):
                with self.assertRaises(OperationFailure) as caught:q.python('never executed')
            self.assertEqual(caught.exception.classification,expected);self.assertFalse(q.execution_unknown)
        self.assertTrue(any(r['step']=='guest.package' for r in self.rows()))
    def test_guest_timeout_retains_pid_and_unknown(self):
        q=pve.Qga.__new__(pve.Qga);q.call=lambda cmd,arg:{'pid':23};q.vmid=117
        with self.assertRaises(OperationFailure) as caught:q.python('never executed',0)
        self.assertEqual(caught.exception.fields['guestPid'],23);self.assertFalse(caught.exception.fields['settled']);self.assertTrue(q.execution_unknown)
    def fake_child(self,returncode=0,timeout=False):
        def communicate(**kwargs):
            if timeout:raise subprocess.TimeoutExpired('NOT_LOGGED',1)
            return b'PRIVATE_PAYLOAD',b'SECRET_TOKEN'
        return types.SimpleNamespace(pid=99,returncode=returncode,communicate=communicate,poll=lambda:None if timeout else returncode)
    def test_child_pid_exit_signal_and_body_hash_only(self):
        for rc in [0,2,-9]:
            with patch.object(evidence.subprocess,'Popen',return_value=self.fake_child(rc)):
                if rc:
                    with self.assertRaises(OperationFailure):process(self.j,'child.command',['NOT_LOGGED'],1)
                else:self.assertEqual(process(self.j,'child.command',['NOT_LOGGED'],1).returncode,0)
        text=json.dumps(self.rows());self.assertNotIn('PRIVATE_PAYLOAD',text);self.assertNotIn('SECRET_TOKEN',text);self.assertNotIn('NOT_LOGGED',text)
        self.assertTrue(any(r['fields'].get('signal')==9 for r in self.rows()))
    def test_child_timeout_no_kill_no_retry(self):
        child=self.fake_child(timeout=True)
        with patch.object(evidence.subprocess,'Popen',return_value=child) as spawn:
            with self.assertRaises(OperationFailure) as caught:process(self.j,'child.command',['NOT_LOGGED'],1)
        spawn.assert_called_once();self.assertFalse(caught.exception.fields['settled']);self.assertIn(child,evidence.UNSETTLED_CHILDREN)
    def test_communication_disconnect_classified(self):
        with patch.object(evidence.subprocess,'Popen',side_effect=ConnectionResetError('SECRET')):
            with self.assertRaises(ConnectionResetError):process(self.j,'child.command',['NOT_LOGGED'],1)
        self.assertEqual(self.j.first_failure['fields']['classification'],'DISCONNECTED')
    def test_uppercase_asset_step_is_normalized(self):
        self.j.run('upload.executor.'+'DEPLOYMENT-PACKAGE.json'.lower(),lambda:None)
        self.assertEqual(self.rows()[-1]['state'],'SUCCESS')
    def test_evidence_failure_observe_stops_other_target(self):
        calls=[]
        class Q:
            def __init__(self,vmid):calls.append(vmid)
            def python(self,*a):raise EvidenceFailure('FAIL')
            def close(self):pass
        with patch.object(pve.os,'geteuid',return_value=0,create=True),patch.object(pve.socket,'gethostname',return_value='pve5'),patch.object(pve,'resource_pre',return_value={}),patch.object(pve,'Qga',Q):
            with self.assertRaises(EvidenceFailure):pve.observe({'evidence':'','capsule':'','deploy':''},'x')
        self.assertEqual(calls,[117])
    def test_wrapper_exit_does_not_settle_child(self):
        with self.assertRaisesRegex(ValueError,'UNSETTLED_CHILD'):pve.ensure_child_settled({'pid':22,'unsettledChild':True})
    def test_malformed_guest_failure_is_unknown_and_safe(self):
        for body in [[],{'failure':None},{'failure':'SECRET'}]:
            q=pve.Qga.__new__(pve.Qga);q.call=lambda cmd,arg:{'pid':23} if cmd=='guest-exec' else {'exited':True,'exitcode':2,'out-data':base64.b64encode(json.dumps(body).encode()).decode()}
            with self.assertRaises(OperationFailure):q.python('never executed')
            self.assertTrue(q.unsettled_child);self.assertTrue(q.execution_unknown)
    def test_validated_remote_failure_retained_before_nonzero_raise(self):
        spec=importlib.util.spec_from_file_location('t',Path(__file__).parent/'run-approved.py');t=importlib.util.module_from_spec(spec);spec.loader.exec_module(t)
        body={'result':'STOPPED_EXECUTION_OUTCOME_UNKNOWN_NO_REPLAY','controlFlow':{'failure':{'classification':'PERMISSION'},'rollback':[]},'private':'SECRET_TOKEN'}
        error=OperationFailure('NONZERO_EXIT');error.completed=types.SimpleNamespace(stdout=json.dumps(body).encode())
        with patch.object(t,'EVENTS',self.j),patch.object(t,'process',side_effect=error):
            with self.assertRaises(OperationFailure):t.command('transport.approved-adapter',['never executed'])
        saved=(self.j.directory/'validated-remote-failure.json').read_text();self.assertIn('PERMISSION',saved);self.assertNotIn('SECRET_TOKEN',saved)
    def test_guest_evidence_failure_fences_host(self):
        q=pve.Qga.__new__(pve.Qga)
        body={'result':'BLOCKED','failedStep':'account','failure':{'classification':'EVIDENCE_FAILURE','errorClass':'EvidenceFailure'}}
        q.call=lambda cmd,arg:{'pid':23} if cmd=='guest-exec' else {'exited':True,'exitcode':2,'out-data':base64.b64encode(json.dumps(body).encode()).decode()}
        with self.assertRaises(EvidenceFailure):q.python('never executed')
        self.assertTrue(q.unsettled_child);self.assertTrue(q.execution_unknown)
    def test_save_failure_immediately_after_popen_retains_child(self):
        child=self.fake_child(timeout=True);real=self.j.emit
        def emit(step,state,**fields):
            if state=='STATUS':raise EvidenceFailure('BROKEN')
            return real(step,state,**fields)
        with patch.object(self.j,'emit',side_effect=emit),patch.object(evidence.subprocess,'Popen',return_value=child):
            with self.assertRaises(EvidenceFailure):process(self.j,'child.command',['never executed'],1)
        self.assertIn(child,evidence.UNSETTLED_CHILDREN)
if __name__=='__main__':unittest.main(verbosity=2)
