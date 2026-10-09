"""Finite approved PVE/QGA deployment and one-shot run. Never a resident remote command broker.
Only pve5/116/117; public files pinned by one Human-approved package SHA. No generic command API.
"""
import argparse
import base64
import hashlib
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from capsule import canonical,require,sha,file_sha
import importlib.util
if 'campaign_keys' in sys.modules:keys=sys.modules['campaign_keys']
else:
    spec=importlib.util.spec_from_file_location('campaign_keys',Path(__file__).parent/'provision-keys.py')
    keys=importlib.util.module_from_spec(spec);spec.loader.exec_module(keys)

ROOT=Path('/var/tmp/ai-linux-qualification-release')
GUEST='/var/lib/ai-linux-qualification-approved-input'
TARGETS=[(117,'executor','rc02-executor-117'),(116,'controller','ai-control-116')]
def guest_modules(sources):
    # In-memory trusted adapter only; python -I -B, no guest upload/import cache or directory creation.
    code='import sys,types,json; '
    for name in ['capsule','deploy']:
        code+='m=types.ModuleType('+repr(name)+'); m.__file__='+repr('/nonexistent/qualification-'+name+'.py')+'; sys.modules['+repr(name)+']=m; exec(compile('+repr(sources[name])+',m.__file__,"exec"),m.__dict__); '
    return code
def observe(sources,pin,initial=True):
    require(os.geteuid()==0 and socket.gethostname()=='pve5','PVE_IDENTITY')
    errors=[];receipts={};resources={}
    try:resources=resource_pre()
    except Exception:errors.append('PVE_RESOURCES_UNCONFIRMED')
    for vmid,role,_ in TARGETS:
        q=None
        try:
            q=Qga(vmid)
            code=guest_modules(sources)
            expression='deploy.readonly_pre('+repr(role)+','+repr(pin)+')' if initial else '{"snapshot":deploy.snapshot('+repr(role)+')}'
            receipts[role]=q.python(code+'import deploy; r='+expression+'; deploy.resource_gate('+repr(role)+',r["snapshot"]); print(json.dumps(r))',300)
        except Exception:receipts[role]={'result':'UNKNOWN_OR_BLOCKED'};errors.append(role+'_OBSERVATION_UNCONFIRMED')
        finally:
            if q:q.close()
    result={'packageSha256':pin,'pveResources':resources,'targets':receipts,'errors':errors}
    if errors:
        error=ValueError('ALL_TARGET_OBSERVATION_BLOCKED');error.evidence=result;raise error
    return result
def check_observation(old,new):
    require(old['packageSha256']==new['packageSha256'],'PRE_PACKAGE_BINDING')
    for _,role,_ in TARGETS:
        a=old['targets'][role]['snapshot'];b=new['targets'][role]['snapshot']
        for key in ['hostname','bootId','units','protectedHashes','executorProtection']:
            require(a.get(key)==b.get(key),'ALL_TARGET_BASELINE_DRIFT:'+role+':'+key)
def two_phase(pre,verify,execute,post,rollback):
    """Pure control flow used by the live composition and failure-injection regressions."""
    evidence=pre() # BOTH targets must pass. No execute/cleanup if this fails.
    verify(evidence);attempted=[]
    try:
        for target in TARGETS:
            verify(evidence) # Both baselines immediately before EVERY target EXEC.
            attempted.append(target);execute(target,evidence)
        verify(evidence);post(evidence);verify(evidence)
    except Exception:
        outcomes=[]
        for target in reversed(attempted):
            try:outcomes.append(rollback(target))
            except Exception:outcomes.append({'result':'UNKNOWN_HUMAN_INSPECTION_REQUIRED'})
        # Failure is still failure, even if unit cleanup succeeded. Always attempt both-target POST.
        try:verify(evidence);protection='BOTH_TARGETS_UNCHANGED'
        except Exception:protection='UNKNOWN_OR_DRIFT_HUMAN_INSPECTION_REQUIRED'
        return {'result':'STOPPED_NO_REPLAY','rollback':outcomes,'finalProtection':protection}
    return {'result':'PASS'}
def start_fixed_units(evidence,verify,start):
    for vmid,unit in [(117,'ai-linux-qualification-broker.service'),(116,'ai-linux-qualification-controller.service')]:
        verify(evidence);start(vmid,unit)
def settle_original(q,pid):
    require(pid is not None,'ORIGINAL_GUEST_EXEC_PID_UNKNOWN')
    require(q.call('guest-exec-status',{'pid':pid}).get('exited') is True,'ORIGINAL_GUEST_EXEC_STILL_UNKNOWN')
class Qga:
    def __init__(self,vmid):
        require(vmid in [116,117],'FIXED_VMID');self.sock=socket.socket(socket.AF_UNIX);self.sock.settimeout(30)
        self.sock.connect('/var/run/qemu-server/'+str(vmid)+'.qga');self.reader=self.sock.makefile('rb');self.counter=0
        self.syncing=True
        nonce=int.from_bytes(os.urandom(8),'big')&((1<<63)-1)
        self.sock.sendall(b'\xff');require(self.call('guest-sync-delimited',{'id':nonce})==nonce,'QGA_SYNC_NONCE_BINDING')
        self.syncing=False
    def call(self,command,args=None):
        self.counter+=1;self.sock.sendall(json.dumps({'execute':command,'arguments':args or {},'id':self.counter}).encode()+b'\n')
        for _ in range(20):
            raw=self.reader.readline(8*1024*1024);require(bool(raw),'QGA_EOF')
            # QGA intentionally emits a parse error for the resynchronization sentinel. Discard
            # stale frames until its delimited reply, not all errors during normal operations.
            if self.syncing and not raw.startswith(b'\xff'):continue
            data=raw.lstrip(b'\xff');r=json.loads(data)
            require(r.get('id')==self.counter,'QGA_RESPONSE_BINDING')
            if 'error' in r:
                # Report only a fixed command's error classification, never guest payload or stderr.
                reason=r['error'].get('class','')
                raise ValueError('QGA_OPERATION_REJECTED_'+str(reason).upper().replace(' ','_'))
            if 'return' in r:return r['return']
        raise ValueError('QGA_PROTOCOL')
    def python(self,code,timeout=120):
        self.execution_unknown=True;self.last_exec_pid=None
        proc=self.call('guest-exec',{'path':'/usr/bin/python3','arg':['-I','-B','-'],
          'input-data':base64.b64encode(code.encode()).decode(),'capture-output':True})
        self.last_exec_pid=proc['pid']
        until=time.monotonic()+timeout
        while time.monotonic()<until:
            r=self.call('guest-exec-status',{'pid':proc['pid']})
            if r.get('exited'):
                self.execution_unknown=False
                if r.get('exitcode')!=0:
                    # Only adapter-defined uppercase diagnostic, never traceback, credential data or command args.
                    import re
                    error=base64.b64decode(r.get('err-data','')).decode(errors='replace')
                    match=re.search(r'ValueError: ([A-Z_]+)(?:\n|$)',error)
                    raise ValueError(match.group(1) if match else 'GUEST_FIXED_OPERATION_FAILED')
                data=base64.b64decode(r.get('out-data',''));require(len(data)<=4*1024*1024,'GUEST_RECEIPT_LIMIT');return json.loads(data)
            time.sleep(.5)
        raise ValueError('GUEST_OUTCOME_UNKNOWN_NO_REPLAY')
    def upload(self,path,file):
        handle=self.call('guest-file-open',{'path':path,'mode':'wb'})
        try:
            with file.open('rb') as stream:
                for chunk in iter(lambda:stream.read(256*1024),b''):
                    r=self.call('guest-file-write',{'handle':handle,'buf-b64':base64.b64encode(chunk).decode()});require(r['count']==len(chunk),'QGA_SHORT_WRITE')
            self.call('guest-file-flush',{'handle':handle})
        finally:self.call('guest-file-close',{'handle':handle})
    def close(self):self.reader.close();self.sock.close()
def resource_pre():
    require(os.geteuid()==0 and socket.gethostname()=='pve5','PVE_IDENTITY')
    mem=dict((s.split(':')[0],int(s.split()[1])) for s in Path('/proc/meminfo').read_text().splitlines())
    require(mem['MemAvailable']>=4*1024**2,'PVE_HEADROOM')
    psi=Path('/proc/pressure/memory').read_text();require(all('avg10=0.00' in line for line in psi.splitlines()),'PVE_MEMORY_PRESSURE')
    rows=json.loads(subprocess.check_output(['pvesh','get','/cluster/resources','--output-format','json']))
    guests=[r for r in rows if r.get('node')=='pve5' and r.get('type') in ['qemu','lxc']]
    require(sum(int(r.get('maxmem',0)) for r in guests)<=mem['MemTotal']*1024-3*1024**3,'NO_OVERCOMMIT')
    for vmid,name in [(116,'ai-control-116'),(117,'rc02-executor-117')]:
        r=[x for x in guests if x.get('vmid')==vmid and x.get('type')=='qemu'];require(len(r)==1 and r[0]['name']==name and r[0]['status']=='running','LIVE_VM_IDENTITY')
    return {'memAvailableKiB':mem['MemAvailable'],'guestReservationsBytes':sum(int(r.get('maxmem',0)) for r in guests)}
def main(pin,approval,baseline_sha):
    require(approval.strip(),'ACTUAL_HUMAN_APPROVAL_REFERENCE_REQUIRED');pre=resource_pre();require(ROOT.is_dir() and not ROOT.is_symlink(),'FIXED_INPUT_ROOT')
    m=json.loads((ROOT/'DEPLOYMENT-PACKAGE.json').read_text());require(sha((ROOT/'DEPLOYMENT-PACKAGE.json').read_bytes())==pin,'APPROVED_PACKAGE_SHA')
    require(m['targetVmids']==[116,117] and m['productionDispatch']=='CLOSED' and m['authority']=='NONE','FIXED_SCOPE')
    for name,digest in m['files'].items():
        require('/' not in name and '\\' not in name and name not in ['.','..'],'PUBLIC_PATH');require(file_sha(ROOT/name)==digest,'PUBLIC_FILE_SHA')
    require(file_sha(ROOT/'PRE-COMPLETED.json')==baseline_sha,'PRE_RECEIPT_CUSTODY')
    approved_pre=json.loads((ROOT/'PRE-COMPLETED.json').read_text())
    sources={name:(ROOT/(name+'.py')).read_text() for name in ['capsule','deploy']}
    check_observation(approved_pre,observe(sources,pin,True)) # All PRE and both baselines BEFORE claim/key/guest writes.
    claim=ROOT/'APPROVED-EXECUTION-CLAIM.json';fd=os.open(claim,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    try:os.write(fd,canonical({'packageSha256':pin,'approvalReference':approval,'pvePre':pre}).encode());os.fsync(fd)
    finally:os.close(fd)
    directory=os.open(ROOT,os.O_RDONLY|os.O_DIRECTORY);os.fsync(directory);os.close(directory)
    receipts={'all-target-readonly-pre':approved_pre};installed=[];custody=None;unknown={}
    def record_unknown(q,vmid,role):
        if getattr(q,'execution_unknown',True):
            unknown[vmid]=getattr(q,'last_exec_pid',None);receipts[role+'-unknownGuestExec']={'pid':unknown[vmid],'settled':False}
    def verify(evidence):
        try:
            current=observe(sources,pin,False);receipts['latestBothTargetProtection']=current;check_observation(evidence,current)
        except Exception as error:
            if hasattr(error,'evidence'):receipts['latestBothTargetProtection']=error.evidence
            raise
    def operation(vmid,role,mode,secret=None):
        q=Qga(vmid)
        try:
            code='import sys,runpy,io,json,hashlib; from pathlib import Path; p=Path('+repr(GUEST+'/deploy.py')+'); assert hashlib.sha256(p.read_bytes()).hexdigest()=='+repr(m['files']['deploy.py'])+'; assert hashlib.sha256(Path('+repr(GUEST+'/capsule.py')+').read_bytes()).hexdigest()=='+repr(m['files']['capsule.py'])+'; sys.argv=[str(p),'+repr(mode)+','+repr(role)+','+repr(pin)+']; '
            if secret is not None:code+='sys.stdin=io.TextIOWrapper(io.BytesIO('+repr(json.dumps(secret).encode())+')); '
            return q.python(code+'runpy.run_path(str(p),run_name="__main__")',300)
        except Exception:record_unknown(q,vmid,role);raise
        finally:q.close()
    def install(target,evidence):
        nonlocal custody
        vmid,role,hostname=target
        # This is EXEC, not PRE. Key generation, mkdir and transfer begin only after ALL PRE pass.
        if custody is None:custody=keys.provision(ROOT/'private-campaign-keys')
        q=Qga(vmid)
        try:
            receipts[role+'-prepare']=q.python('import os,socket,json; from pathlib import Path; assert os.geteuid()==0 and socket.gethostname()=='+repr(hostname)+'; p=Path('+repr(GUEST)+'); p.mkdir(mode=0o700); print(json.dumps({"prepared":True}))')
            for name in ['DEPLOYMENT-PACKAGE.json',*m['files']]:q.upload(GUEST+'/'+name,ROOT/name)
            # Persist the genuine earlier no-write PRE only now, after both target passes.
            q.python(guest_modules(sources)+'import deploy; deploy.write(deploy.INPUT/'+repr(role+'-PRE.json')+','+repr(canonical(evidence['targets'][role]))+'); print(json.dumps({"preEvidencePersistedInExec":True}))')
        except Exception:record_unknown(q,vmid,role);raise
        finally:q.close()
        verify(evidence);installed.append((vmid,role))
        receipts[role+'-exec']=operation(vmid,role,'exec',keys.role_input(custody,role));receipts[role+'-post']=operation(vmid,role,'post')
    def rollback(target):
        vmid,role,_=target
        if vmid in unknown:
            q=Qga(vmid)
            try:settle_original(q,unknown[vmid]);receipts[role+'-unknownGuestExec']['settled']=True
            finally:q.close()
        # If transfer failed before a durable install claim, do not stop any guessed service.
        q=Qga(vmid)
        try:
            result=q.python(guest_modules(sources)+'import deploy; from pathlib import Path; p=deploy.INPUT/'+repr(role+'-CREATED.json')+'; print(json.dumps({"claimed":p.exists()}))')
        finally:q.close()
        if not result['claimed']:
            return {'result':'NO_INSTALL_CLAIM_INPUTS_RETAINED_NO_UNIT_STOP'}
        result=operation(vmid,role,'rollback');receipts[role+'-rollback']=result;return result
    def post(evidence):
        verify(evidence)
        run_job(evidence)
        verify(evidence)
    def run_job(evidence):
        # Start only the new broker, then the one-shot controller. No enable, boot, existing unit restart or PVE ACL.
        def start(vmid,unit):
            q=Qga(vmid)
            try:receipts[unit]=q.python('import subprocess,json; r=subprocess.run(["/usr/bin/systemctl","start",'+repr(unit)+'],timeout=970); print(json.dumps({"exitCode":r.returncode})); raise SystemExit(0 if r.returncode==0 else 2)',990)
            except Exception:record_unknown(q,vmid,'executor' if vmid==117 else 'controller');raise
            finally:q.close()
        start_fixed_units(evidence,verify,start)
        q=Qga(116)
        try:
            receipts['linux-control-report']=q.python('import json,subprocess,re; from pathlib import Path; root=Path("/var/lib/ai-linux-qualification-controller"); rows=list(root.glob("linux-qualification-*/task.json")); assert len(rows)==1; l=json.loads(rows[0].read_text()); task=l["taskId"]; assert re.fullmatch("linux-qualification-[a-f0-9]{32}",task); r=subprocess.run(["/usr/sbin/runuser","-u","ai-qualification-controller","--","/opt/ai-linux-qualification-controller/host-runtime/usr/bin/node","/opt/ai-linux-qualification-controller/source/dist/linux-qualification/cli.js","report",task],capture_output=True,text=True,timeout=15); assert r.returncode==0; report=json.loads(r.stdout); assert report["result"]=="FIXED_13_SUITE_QUALIFICATION_PASS" and report["authority"]=="NONE" and report["productionDispatch"]=="CLOSED"; print(json.dumps(report))')
        finally:q.close()
    outcome=two_phase(lambda:approved_pre,verify,install,post,rollback)
    receipts['result']='FIXED_13_SUITE_QUALIFICATION_COMPLETED_NOT_PROVIDER_E2E' if outcome['result']=='PASS' else 'STOPPED_EXECUTION_OUTCOME_UNKNOWN_NO_REPLAY'
    receipts['controlFlow']=outcome
    (ROOT/'EXECUTION-RECEIPT.json').write_text(json.dumps(receipts,indent=2)+'\n');print(json.dumps(receipts))
    return 0 if receipts['result']=='FIXED_13_SUITE_QUALIFICATION_COMPLETED_NOT_PROVIDER_E2E' else 2
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('approvedPackageSha256');p.add_argument('--human-approval-reference',required=True);p.add_argument('--pre-receipt-sha256',required=True);a=p.parse_args()
    try:sys.exit(main(a.approvedPackageSha256,a.human_approval_reference,a.pre_receipt_sha256))
    except Exception:print('{"result":"PVE_FIXED_OPERATION_BLOCKED_NO_REPLAY"}');sys.exit(2)
