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
from evidence import Journal,EvidenceFailure,OperationFailure,failure,require_external_fence
ACTIVE_JOURNAL=None
def tracked(step,action):return ACTIVE_JOURNAL.run(step,action) if ACTIVE_JOURNAL else action()
import importlib.util
if 'campaign_keys' in sys.modules:keys=sys.modules['campaign_keys']
else:
    spec=importlib.util.spec_from_file_location('campaign_keys',Path(__file__).parent/'provision-keys.py')
    keys=importlib.util.module_from_spec(spec);spec.loader.exec_module(keys)

ROOT=Path('/var/tmp/ai-linux-qualification-retest-20261010-release')
V2_ROOT=Path('/var/tmp/ai-linux-qualification-custody-v2-release')
OLD_ROOT=Path('/var/tmp/ai-linux-qualification-release')
OLD_PACKAGE_SHA='35a3cb96e791f0e42d8e658dc54c4a676f6464b1e7ea22fa37ca16eff7c9068d'
OLD_CLAIM_SHA='565f03dec95a83e7bf06270155f126e572759f11b68e81c474e586d13d5c44ba'
OLD_PRE_SHA='bf0ea09ca232acaba960e04bdfbd4854d26253b5f25f41c8e65ec7095f3820bc'
GUEST='/var/lib/ai-linux-qualification-retest-20261010-input'
HOST_PUBLIC_NAMES=frozenset(['DEPLOYMENT-PACKAGE.json','PRE-COMPLETED.json','capsule.tar','host-runtime.tar','raw-source.tar','source.tar','deploy.py','capsule.py','evidence.py','broker.service','controller.service','executor@.service','provision-keys.py','pve-operation.py','run-approved.py'])
def fresh_host_path():
    require(all(ROOT!=p and ROOT not in p.parents and p not in ROOT.parents for p in [OLD_ROOT,V2_ROOT]),'FRESH_HOST_PATH_COLLISION')
def trusted_host_parents(path):
    import stat
    require(path in [ROOT,OLD_ROOT,V2_ROOT],'FIXED_HOST_DIRECTORY')
    for ancestor in path.parents:
        s=ancestor.lstat();require(stat.S_ISDIR(s.st_mode) and s.st_uid==0 and not ancestor.is_symlink(),'HOST_ANCESTOR_CUSTODY')
        require(not s.st_mode&0o022 or str(ancestor)=='/var/tmp' and bool(s.st_mode&stat.S_ISVTX),'HOST_ANCESTOR_WRITABLE')
def trusted_host_directory(path):
    import stat
    trusted_host_parents(path)
    s=path.lstat();require(stat.S_ISDIR(s.st_mode) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o700 and not path.is_symlink(),'HOST_INPUT_CUSTODY')
def host_file_identity(path):
    import stat
    trusted_host_directory(ROOT);s=path.lstat()
    require(stat.S_ISREG(s.st_mode) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o600 and s.st_nlink==1,'HOST_FILE_CUSTODY')
    return s.st_dev,s.st_ino
def donor_file(name,digest):
    import stat
    require(name in ['capsule.tar','host-runtime.tar'],'FIXED_PUBLIC_REUSE_NAME');trusted_host_directory(OLD_ROOT)
    fd=os.open(OLD_ROOT/name,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        s=os.fstat(fd);require(stat.S_ISREG(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022 and s.st_nlink==1,'DONOR_CUSTODY')
        with os.fdopen(os.dup(fd),'rb') as stream:require(hashlib.file_digest(stream,'sha256').hexdigest()==digest,'DONOR_SHA')
        os.lseek(fd,0,os.SEEK_SET);return fd
    except Exception:os.close(fd);raise
def receive_host_input(name,stream,size,digest):
    import stat
    fresh_host_path()
    require(name in HOST_PUBLIC_NAMES,'FIXED_HOST_INPUT_NAME');trusted_host_directory(ROOT)
    fd=os.open(ROOT/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);count=0;h=hashlib.sha256()
    try:
        s=os.fstat(fd);identity=(s.st_dev,s.st_ino)
        require(stat.S_ISREG(s.st_mode) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o600 and s.st_nlink==1 and s.st_size==0 and host_file_identity(ROOT/name)==identity,'HOST_CREATE_CUSTODY')
        with os.fdopen(os.dup(fd),'wb') as out:
            for chunk in iter(lambda:stream.read(1024*1024),b''):
                count+=len(chunk);require(count<=size,'HOST_TRANSFER_SIZE');out.write(chunk);h.update(chunk)
            out.flush();os.fsync(fd)
        require(count==size and h.hexdigest()==digest,'HOST_TRANSFER_SHA')
        s=os.fstat(fd);require(stat.S_ISREG(s.st_mode) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o600 and s.st_nlink==1 and s.st_size==size and (s.st_dev,s.st_ino)==identity and host_file_identity(ROOT/name)==identity,'HOST_FINAL_FD_CUSTODY')
    finally:os.close(fd)
    require(host_file_identity(ROOT/name)==identity and (ROOT/name).stat().st_size==size and file_sha(ROOT/name)==digest,'HOST_FINAL_SHA_OR_CUSTODY')
    require(host_file_identity(ROOT/name)==identity,'HOST_POST_HASH_IDENTITY')
    directory=os.open(ROOT,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(directory)
    finally:os.close(directory)
    return {'name':name,'bytes':count,'sha256':digest}
def prepare_host_inputs(sources,files):
    tracked('external-fence',require_external_fence)
    fresh_host_path()
    # Only after BOTH PRE and external fencing; fresh root fences same-region replay only.
    before=old_host_custody(sources);trusted_host_parents(ROOT);ROOT.mkdir(mode=0o700);trusted_host_directory(ROOT);reused=[]
    for name in ['capsule.tar','host-runtime.tar']:
        fd=donor_file(name,files[name])
        with os.fdopen(fd,'rb') as stream:reused.append(receive_host_input(name,stream,os.fstat(stream.fileno()).st_size,files[name]))
    require(old_host_custody(sources)==before,'OLD_CAMPAIGN_REUSE_DRIFT')
    return {'reused':reused,'oldCampaignUnchanged':True}
def old_host_custody(sources):
    import stat
    trusted_host_directory(OLD_ROOT)
    for name,digest in [('DEPLOYMENT-PACKAGE.json',OLD_PACKAGE_SHA),('APPROVED-EXECUTION-CLAIM.json',OLD_CLAIM_SHA),('PRE-COMPLETED.json',OLD_PRE_SHA)]:
        p=OLD_ROOT/name;s=p.lstat();require(stat.S_ISREG(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022 and s.st_nlink==1 and file_sha(p)==digest,'OLD_CAMPAIGN_CUSTODY')
    namespace={};exec(guest_modules(sources)+'import deploy; from pathlib import Path; result=deploy.tree_digest(Path('+repr(str(OLD_ROOT))+'),file_limit=1024**3)',namespace)
    original=namespace['result']
    trusted_host_directory(V2_ROOT)
    for name,digest in [('DEPLOYMENT-PACKAGE.json','e14d769a068725eb6d108f625d69915bc4aa12dbcd4940487e3e9aa771639a05'),('APPROVED-EXECUTION-CLAIM.json','505f18071ad3568c124b833acd6a84761429364c069ac9413a86cb1f88342b32')]:
        p=V2_ROOT/name;s=p.lstat();require(stat.S_ISREG(s.st_mode) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o600 and s.st_nlink==1 and file_sha(p)==digest,'V2_CAMPAIGN_CUSTODY')
    namespace={};exec(guest_modules(sources)+'import deploy; from pathlib import Path; result=deploy.tree_digest(Path('+repr(str(V2_ROOT))+'),file_limit=1024**3)',namespace)
    return {'release':original,'custodyV2':namespace['result']}
TARGETS=[(117,'executor','rc02-executor-117'),(116,'controller','ai-control-116')]
def guest_modules(sources):
    # In-memory trusted adapter only; python -I -B, no guest upload/import cache or directory creation.
    code='import sys,types,json; '
    for name in ['evidence','capsule','deploy']:
        code+='m=types.ModuleType('+repr(name)+'); m.__file__='+repr('/nonexistent/qualification-'+name+'.py')+'; sys.modules['+repr(name)+']=m; exec(compile('+repr(sources[name])+',m.__file__,"exec"),m.__dict__); '
    return code
def observe(sources,pin,initial=True):
    require(os.geteuid()==0 and socket.gethostname()=='pve5','PVE_IDENTITY')
    errors=[];receipts={};resources={}
    try:resources=resource_pre()
    except EvidenceFailure:raise
    except Exception:errors.append('PVE_RESOURCES_UNCONFIRMED')
    for vmid,role,_ in TARGETS:
        q=None
        try:
            q=Qga(vmid)
            code=guest_modules(sources)
            expression='deploy.readonly_pre('+repr(role)+','+repr(pin)+')' if initial else '{"snapshot":deploy.snapshot('+repr(role)+')}'
            receipts[role]=q.python(code+'import deploy; r='+expression+'; deploy.resource_gate('+repr(role)+',r["snapshot"]); print(json.dumps(r))',300)
        except EvidenceFailure:raise
        except Exception:receipts[role]={'result':'UNKNOWN_OR_BLOCKED'};errors.append(role+'_OBSERVATION_UNCONFIRMED')
        finally:
            if q:q.close()
    retention=None
    try:retention=old_host_custody(sources)
    except EvidenceFailure:raise
    except Exception:errors.append('OLD_CAMPAIGN_CUSTODY_UNCONFIRMED')
    result={'packageSha256':pin,'pveResources':resources,'targets':receipts,'oldHostCampaign':retention,'errors':errors}
    if errors:
        error=ValueError('ALL_TARGET_OBSERVATION_BLOCKED');error.evidence=result;raise error
    return result
def check_observation(old,new):
    require(old['packageSha256']==new['packageSha256'],'PRE_PACKAGE_BINDING')
    require(old.get('oldHostCampaign')==new.get('oldHostCampaign'),'OLD_HOST_CAMPAIGN_DRIFT')
    for _,role,_ in TARGETS:
        a=old['targets'][role]['snapshot'];b=new['targets'][role]['snapshot']
        for key in ['hostname','bootId','units','protectedHashes','executorProtection','oldCampaignInputs']:
            require(a.get(key)==b.get(key),'ALL_TARGET_BASELINE_DRIFT:'+role+':'+key)
def two_phase(pre,verify,execute,post,rollback,journal=None):
    """Pure control flow used by the live composition and failure-injection regressions."""
    run=journal.run if journal else lambda step,fn:fn()
    evidence=run('all.pre',pre) # BOTH targets must pass. No execute/cleanup if this fails.
    run('all.verify',lambda:verify(evidence));attempted=[]
    try:
        for target in TARGETS:
            run('all.pre-exec-verify',lambda:verify(evidence))
            attempted.append(target);run('install.'+target[1],lambda:execute(target,evidence))
        run('all.pre-post-verify',lambda:verify(evidence));run('all.post',lambda:post(evidence));run('all.final-verify',lambda:verify(evidence))
    except EvidenceFailure:raise # Evidence failure fences further actions; never silently continue.
    except Exception as error:
        outcomes=[]
        for target in reversed(attempted):
            try:outcomes.append(run('rollback.'+target[1],lambda:rollback(target)))
            except EvidenceFailure:raise
            except Exception as rollback_error:
                outcome={'result':'UNKNOWN_HUMAN_INSPECTION_REQUIRED'}
                if journal:outcome['failure']=failure(rollback_error)
                outcomes.append(outcome)
        # Failure is still failure, even if unit cleanup succeeded. Always attempt both-target POST.
        try:run('all.failure-post',lambda:verify(evidence));protection='BOTH_TARGETS_UNCHANGED'
        except EvidenceFailure:raise
        except Exception:protection='UNKNOWN_OR_DRIFT_HUMAN_INSPECTION_REQUIRED'
        outcome={'result':'STOPPED_NO_REPLAY','rollback':outcomes,'finalProtection':protection}
        if journal:outcome.update(firstFailure=journal.first_failure,failure=failure(error))
        return outcome
    return {'result':'PASS'}
def start_fixed_units(evidence,verify,start):
    tracked('external-fence',require_external_fence)
    for vmid,unit in [(117,'ai-linux-qualification-broker.service'),(116,'ai-linux-qualification-controller.service')]:
        verify(evidence);start(vmid,unit)
def settle_original(q,pid):
    require(pid is not None,'ORIGINAL_GUEST_EXEC_PID_UNKNOWN')
    require(q.call('guest-exec-status',{'pid':pid}).get('exited') is True,'ORIGINAL_GUEST_EXEC_STILL_UNKNOWN')
def ensure_child_settled(record):
    require(not record.get('unsettledChild'),'UNSETTLED_CHILD_REQUIRES_HUMAN_INSPECTION')
class Qga:
    def __init__(self,vmid):
        self.vmid=vmid
        tracked('qga.connect',lambda:self.connect(vmid))
    def connect(self,vmid):
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
        if ACTIVE_JOURNAL:ACTIVE_JOURNAL.emit('qga.process','STATUS',guestPid=self.last_exec_pid,vmid=getattr(self,'vmid',None),settled=False)
        until=time.monotonic()+timeout
        while time.monotonic()<until:
            r=self.call('guest-exec-status',{'pid':proc['pid']})
            if r.get('exited'):
                self.execution_unknown=False
                fields={'guestPid':proc['pid'],'exited':True,'exitCode':r.get('exitcode'),'signal':r.get('signal'),'settled':True,'stdoutSha256':sha(base64.b64decode(r.get('out-data',''))),'stderrSha256':sha(base64.b64decode(r.get('err-data','')))}
                if ACTIVE_JOURNAL:ACTIVE_JOURNAL.emit('qga.process','STATUS',**fields)
                if r.get('exitcode')!=0 or r.get('signal'):
                    self.execution_unknown=True;self.unsettled_child=True # Invalid/incomplete failure receipts never settle children.
                    try:
                        guest=json.loads(base64.b64decode(r.get('out-data','')))
                        allowed={'external-fence','private-input','identity','package','pre-binding','replay-gate','snapshot','baseline','resource','install-claim','account','directories','runtime','private-config','units','daemon-reload','post','rollback','entry'}
                        if not isinstance(guest,dict) or not isinstance(guest.get('failure'),dict):raise ValueError('GUEST_FAILURE_SCHEMA')
                        if guest.get('result')!='BLOCKED' or guest.get('failedStep') not in allowed or guest['failure'].get('classification') not in (__import__('evidence').CLASSES-{'SUCCESS'}):raise ValueError('GUEST_FAILURE_SCHEMA')
                        sanitized=__import__('evidence').clean(guest['failure'])
                        if 'settled' in sanitized and not isinstance(sanitized['settled'],bool):raise ValueError('GUEST_SETTLEMENT_SCHEMA')
                        if ACTIVE_JOURNAL:ACTIVE_JOURNAL.emit('guest.'+guest['failedStep'],'FAIL',**sanitized)
                        if guest['failure'].get('classification')=='EVIDENCE_FAILURE':
                            self.execution_unknown=True;self.unsettled_child=True
                            raise EvidenceFailure('GUEST_EVIDENCE_FAILURE')
                        if sanitized.get('settled') is True and sanitized['classification'] not in ['TIMEOUT','UNKNOWN','DISCONNECTED']:
                            self.execution_unknown=False;self.unsettled_child=False
                    except (ValueError,KeyError,TypeError):
                        self.execution_unknown=True;self.unsettled_child=True
                    raise OperationFailure('SIGNAL' if r.get('signal') else 'NONZERO_EXIT',**fields)
                data=base64.b64decode(r.get('out-data',''));require(len(data)<=4*1024*1024,'GUEST_RECEIPT_LIMIT');return json.loads(data)
            time.sleep(.5)
        raise OperationFailure('TIMEOUT',guestPid=proc['pid'],timeoutSeconds=timeout,settled=False)
    def upload(self,name,file,sources,digest):
        import re
        require(name in {'DEPLOYMENT-PACKAGE.json','capsule.tar','host-runtime.tar','raw-source.tar','source.tar','deploy.py','capsule.py','evidence.py','broker.service','controller.service','executor@.service','provision-keys.py','pve-operation.py','run-approved.py'},'FIXED_UPLOAD_NAME')
        require(re.fullmatch('[a-f0-9]{64}',digest) is not None and file_sha(file)==digest,'UPLOAD_SOURCE_SHA')
        size=file.stat().st_size;prefix=guest_modules(sources)+'import deploy; '
        identity=self.python(prefix+'print(json.dumps(deploy.prepare_upload('+repr(name)+')))')
        self.execution_unknown=True;self.last_exec_pid=None
        handle=self.call('guest-file-open',{'path':GUEST+'/'+name,'mode':'r+b'})
        try:
            self.python(prefix+'print(json.dumps(deploy.check_upload('+repr(name)+','+repr(identity)+',0)))')
            self.execution_unknown=True;self.last_exec_pid=None
            with file.open('rb') as stream:
                for chunk in iter(lambda:stream.read(256*1024),b''):
                    r=self.call('guest-file-write',{'handle':handle,'buf-b64':base64.b64encode(chunk).decode()});require(r['count']==len(chunk),'QGA_SHORT_WRITE')
            self.call('guest-file-flush',{'handle':handle})
        finally:
            self.execution_unknown=True;self.last_exec_pid=None
            self.call('guest-file-close',{'handle':handle})
        self.python(prefix+'print(json.dumps(deploy.check_upload('+repr(name)+','+repr(identity)+','+repr(size)+','+repr(digest)+')))')
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
    global ACTIVE_JOURNAL
    tracked('external-fence',require_external_fence) # Before host/QGA access, claim, keys or writes.
    require(approval.strip(),'ACTUAL_HUMAN_APPROVAL_REFERENCE_REQUIRED');pre=resource_pre();require(ROOT.is_dir() and not ROOT.is_symlink(),'FIXED_INPUT_ROOT')
    m=json.loads((ROOT/'DEPLOYMENT-PACKAGE.json').read_text());require(sha((ROOT/'DEPLOYMENT-PACKAGE.json').read_bytes())==pin,'APPROVED_PACKAGE_SHA')
    require(m['targetVmids']==[116,117] and m['productionDispatch']=='CLOSED' and m['authority']=='NONE','FIXED_SCOPE')
    for name,digest in m['files'].items():
        require('/' not in name and '\\' not in name and name not in ['.','..'],'PUBLIC_PATH');host_file_identity(ROOT/name);require(file_sha(ROOT/name)==digest,'PUBLIC_FILE_SHA')
    host_file_identity(ROOT/'DEPLOYMENT-PACKAGE.json');host_file_identity(ROOT/'PRE-COMPLETED.json')
    require(file_sha(ROOT/'PRE-COMPLETED.json')==baseline_sha,'PRE_RECEIPT_CUSTODY')
    approved_pre=json.loads((ROOT/'PRE-COMPLETED.json').read_text())
    sources={name:(ROOT/(name+'.py')).read_text() for name in ['evidence','capsule','deploy']}
    check_observation(approved_pre,observe(sources,pin,True)) # All PRE and both baselines BEFORE claim/key/guest writes.
    ACTIVE_JOURNAL=Journal(ROOT/'operation-events')
    claim=ROOT/'APPROVED-EXECUTION-CLAIM.json';fd=os.open(claim,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    try:os.write(fd,canonical({'packageSha256':pin,'approvalReference':approval,'pvePre':pre}).encode());os.fsync(fd)
    finally:os.close(fd)
    directory=os.open(ROOT,os.O_RDONLY|os.O_DIRECTORY);os.fsync(directory);os.close(directory)
    receipts={'all-target-readonly-pre':approved_pre};installed=[];custody=None;unknown={}
    def record_unknown(q,vmid,role):
        if getattr(q,'execution_unknown',True):
            unknown[vmid]=getattr(q,'last_exec_pid',None);receipts[role+'-unknownGuestExec']={'pid':unknown[vmid],'settled':False,'unsettledChild':True}
    def verify(evidence):
        try:
            current=observe(sources,pin,False);receipts.setdefault('protectionObservations',[]).append(current);receipts['latestBothTargetProtection']=current;check_observation(evidence,current)
        except Exception as error:
            if hasattr(error,'evidence'):
                receipts.setdefault('protectionObservations',[]).append(error.evidence);receipts['latestBothTargetProtection']=error.evidence
            raise
    def operation(vmid,role,mode,secret=None):
        q=Qga(vmid)
        try:
            code='import sys,runpy,io,json,hashlib; from pathlib import Path; p=Path('+repr(GUEST+'/deploy.py')+'); assert hashlib.sha256(p.read_bytes()).hexdigest()=='+repr(m['files']['deploy.py'])+'; assert hashlib.sha256(Path('+repr(GUEST+'/capsule.py')+').read_bytes()).hexdigest()=='+repr(m['files']['capsule.py'])+'; sys.argv=[str(p),'+repr(mode)+','+repr(role)+','+repr(pin)+']; '
            if secret is not None:code+='sys.stdin=io.TextIOWrapper(io.BytesIO('+repr(json.dumps(secret).encode())+')); '
            return tracked(role+'.'+mode,lambda:q.python(code+'runpy.run_path(str(p),run_name="__main__")',300))
        except Exception:record_unknown(q,vmid,role);raise
        finally:q.close()
    def install(target,evidence):
        nonlocal custody
        vmid,role,hostname=target
        # This is EXEC, not PRE. Key generation, mkdir and transfer begin only after ALL PRE pass.
        if custody is None:custody=tracked('keys.generate',lambda:keys.provision(ROOT/'private-campaign-keys'))
        q=Qga(vmid)
        try:
            receipts[role+'-prepare']=q.python('import os,socket,json; from pathlib import Path; assert os.geteuid()==0 and socket.gethostname()=='+repr(hostname)+'; p=Path('+repr(GUEST)+'); p.mkdir(mode=0o700); print(json.dumps({"prepared":True}))')
            for name in ['DEPLOYMENT-PACKAGE.json',*m['files']]:tracked('upload.'+role+'.'+name.replace('@','template').lower(),lambda:q.upload(name,ROOT/name,sources,pin if name=='DEPLOYMENT-PACKAGE.json' else m['files'][name]))
            # Persist the genuine earlier no-write PRE only now, after both target passes.
            q.python(guest_modules(sources)+'import deploy; deploy.write(deploy.INPUT/'+repr(role+'-PRE.json')+','+repr(canonical(evidence['targets'][role]))+'); print(json.dumps({"preEvidencePersistedInExec":True}))')
        except Exception:record_unknown(q,vmid,role);raise
        finally:q.close()
        verify(evidence);installed.append((vmid,role))
        secret=tracked('keys.role-input.'+role,lambda:keys.role_input(custody,role))
        receipts[role+'-exec']=operation(vmid,role,'exec',secret);verify(evidence);receipts[role+'-post']=operation(vmid,role,'post')
    def rollback(target):
        vmid,role,_=target
        if vmid in unknown:
            ensure_child_settled(receipts[role+'-unknownGuestExec'])
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
    outcome=two_phase(lambda:approved_pre,verify,install,post,rollback,ACTIVE_JOURNAL)
    receipts['result']='FIXED_13_SUITE_QUALIFICATION_COMPLETED_NOT_PROVIDER_E2E' if outcome['result']=='PASS' else 'STOPPED_EXECUTION_OUTCOME_UNKNOWN_NO_REPLAY'
    receipts['controlFlow']=outcome
    (ROOT/'EXECUTION-RECEIPT.json').write_text(json.dumps(receipts,indent=2)+'\n');print(json.dumps(receipts))
    return 0 if receipts['result']=='FIXED_13_SUITE_QUALIFICATION_COMPLETED_NOT_PROVIDER_E2E' else 2
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('approvedPackageSha256');p.add_argument('--human-approval-reference',required=True);p.add_argument('--pre-receipt-sha256',required=True);a=p.parse_args()
    try:sys.exit(main(a.approvedPackageSha256,a.human_approval_reference,a.pre_receipt_sha256))
    except Exception as error:
        print(json.dumps({'result':'PVE_FIXED_OPERATION_BLOCKED_NO_REPLAY','failedStep':'external-fence' if getattr(error,'external_fence_unverified',False) else 'entry','failure':failure(error)}));sys.exit(2)
