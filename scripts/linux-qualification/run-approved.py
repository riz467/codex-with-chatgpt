"""Workstation transport for a separately Human-approved, SHA-pinned finite operation. No secrets logged.
Does not invent approval or bypass independent organizational signature gates. Public files only via scp.
"""
import argparse
import hashlib
import json
import shlex
import subprocess
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from evidence import Journal,process,OperationFailure,clean,EvidenceFailure,require_external_fence
EVENTS=None
def command(step,args,**kwargs):
    if not EVENTS:return subprocess.run(args,**kwargs)
    kwargs.pop('capture_output',None);kwargs.pop('check',None)
    timeout=kwargs.pop('timeout',120)
    try:return process(EVENTS,step,args,timeout,**kwargs)
    except OperationFailure as error:
        completed=getattr(error,'completed',None)
        if completed and step=='transport.approved-adapter':
            try:
                body=json.loads(completed.stdout);flow=body.get('controlFlow',{}) if isinstance(body,dict) else {}
                if body.get('result') not in ['STOPPED_EXECUTION_OUTCOME_UNKNOWN_NO_REPLAY','PVE_FIXED_OPERATION_BLOCKED_NO_REPLAY']:raise ValueError('SCHEMA')
                summary={'result':body['result']}
                if body['result']=='PVE_FIXED_OPERATION_BLOCKED_NO_REPLAY':
                    if body.get('failedStep') not in ['external-fence','entry'] or not isinstance(body.get('failure'),dict):raise ValueError('BLOCKED_FAILURE_SCHEMA')
                    fields=clean(body['failure'])
                    if fields.get('classification') in [None,'SUCCESS']:raise ValueError('BLOCKED_FAILURE_CLASS_REQUIRED')
                    if body['failedStep']=='external-fence' and (fields.get('classification')!='UNKNOWN' or fields.get('settled') is not False):raise ValueError('EXTERNAL_FENCE_FAILURE_SCHEMA')
                    summary.update(failedStep=body['failedStep'],failure=fields)
                if body['result']=='STOPPED_EXECUTION_OUTCOME_UNKNOWN_NO_REPLAY' and isinstance(flow,dict):
                    if isinstance(flow.get('failure'),dict):summary['failure']=clean(flow['failure'])
                    first=flow.get('firstFailure')
                    if isinstance(first,dict) and isinstance(first.get('step'),str) and __import__('re').fullmatch('[a-z][a-z0-9_.-]{0,95}',first['step']):
                        summary['firstFailure']={'step':first['step'],'fields':clean(first.get('fields',{}))}
                    summary['rollback']=[{'result':'UNKNOWN','failure':clean(item.get('failure',{}))} for item in flow.get('rollback',[]) if isinstance(item,dict)]
                payload=json.dumps(summary).encode();fd=__import__('os').open(EVENTS.directory/'validated-remote-failure.json',__import__('os').O_WRONLY|__import__('os').O_CREAT|__import__('os').O_EXCL,0o600)
                try:
                    with __import__('os').fdopen(__import__('os').dup(fd),'wb') as f:f.write(payload);f.flush();__import__('os').fsync(fd)
                finally:__import__('os').close(fd)
                EVENTS.emit('transport.failure-receipt','STATUS',stdoutBytes=len(payload))
            except (ValueError,TypeError,KeyError):EVENTS.emit('transport.failure-receipt-invalid','STATUS',classification='UNKNOWN')
            except Exception:raise EvidenceFailure('REMOTE_RECEIPT_SAVE_FAILED') from None
        raise
SSH=['ssh','-F','C:/work/.ssh/config','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8','-o','IdentitiesOnly=yes','pve5']
FRAME_LOADER='import sys; n=int(sys.stdin.buffer.readline(32)); assert 0<n<=1048576; c=sys.stdin.buffer.read(n); assert len(c)==n; exec(compile(c,"<approved-host-input>","exec"))'
def frame_source(code,payload):
    code=code.encode();require_size=0<len(code)<=1048576 and len(payload)<=32*1024**2
    if not require_size:raise ValueError('PUBLIC_FRAME_BOUND')
    return str(len(code)).encode()+b'\n'+code+payload
def host_modules(sources):
    code='import sys,types,json; '
    for name,file in [('evidence','evidence.py'),('capsule','capsule.py'),('campaign_keys','provision-keys.py'),('pve_operation','pve-operation.py')]:
        code+='m=types.ModuleType('+repr(name)+'); m.__file__='+repr('/nonexistent/'+file)+'; sys.modules['+repr(name)+']=m; exec(compile('+repr(sources[file])+',m.__file__,"exec"),m.__dict__); '
    return code+'pve=sys.modules["pve_operation"]; '
def readonly_transport(sources,pin):
    code=host_modules(sources)+'assert not pve.ROOT.exists() and not pve.ROOT.is_symlink(), "FRESH_HOST_CAMPAIGN_REQUIRED"; '
    code+='print(json.dumps(pve.observe('+repr({name:sources[name+'.py'] for name in ['evidence','capsule','deploy']})+','+repr(pin)+',True)))'
    # Code is streamed, no remote file, argv source/secrets, pycache, mkdir or upload.
    r=command('transport.readonly-pre',[*SSH,'python3 -I -B -'],input=code.encode(),capture_output=True,timeout=750)
    if r.returncode:
        import re
        match=re.search(rb'ValueError: ([A-Z_]+)(?:\r?\n|$)',r.stderr)
        raise ValueError(match.group(1).decode() if match else 'ALL_TARGET_READONLY_PRE_BLOCKED')
    evidence=json.loads(r.stdout)
    if evidence.get('packageSha256')!=pin or set(evidence.get('targets',{}))!={'executor','controller'}:raise ValueError('PRE_RECEIPT_BINDING')
    for role in ['executor','controller']:
        if evidence['targets'][role].get('result')!='PASS':raise ValueError('PRE_NOT_PASS')
    return evidence

def run(root,pin,approval,pre_only=False):
    global EVENTS
    if not pre_only and not approval.strip():raise ValueError('ACTUAL_HUMAN_APPROVAL_REQUIRED')
    EVENTS=Journal(root/'hqo-operation-events')
    return EVENTS.run('hqo.operation',lambda:_run(root,pin,approval,pre_only))
def _run(root,pin,approval,pre_only=False):
    if not pre_only and not approval.strip():raise ValueError('ACTUAL_HUMAN_APPROVAL_REQUIRED')
    data=(root/'DEPLOYMENT-PACKAGE.json').read_bytes()
    if hashlib.sha256(data).hexdigest()!=pin:raise ValueError('APPROVED_MANIFEST_SHA')
    m=json.loads(data)
    required={'capsule.tar','host-runtime.tar','raw-source.tar','source.tar','deploy.py','capsule.py','evidence.py','broker.service','controller.service','executor@.service','provision-keys.py','pve-operation.py','run-approved.py'}
    if m.get('schema')!=1 or m.get('targetVmids')!=[116,117] or m.get('authority')!='NONE' or m.get('productionDispatch')!='CLOSED' or set(m.get('files',{}))!=required:raise ValueError('FIXED_PACKAGE_SCHEMA_SCOPE_AND_REQUIRED_FILES')
    verified={}
    for name,digest in m['files'].items():
        if '/' in name or '\\' in name or name in ['.','..'] or hashlib.sha256((root/name).read_bytes()).hexdigest()!=digest:raise ValueError('PUBLIC_PACKAGE_INTEGRITY')
        if name.endswith('.py'):
            content=(root/name).read_bytes()
            if hashlib.sha256(content).hexdigest()!=digest:raise ValueError('ADAPTER_SOURCE_CHANGED')
            verified[name]=content
    sources={name:verified[name].decode('utf-8') for name in ['evidence.py','capsule.py','deploy.py','provision-keys.py','pve-operation.py']}
    if not pre_only:EVENTS.run('external-fence',require_external_fence) # No transport or mutating preparation without technical fencing.
    evidence=readonly_transport(sources,pin) # BOTH VM PRE passes BEFORE host or guest changes.
    data=json.dumps(evidence,sort_keys=True,separators=(',',':')).encode();pre_sha=hashlib.sha256(data).hexdigest()
    pre_file=root/('READONLY-PRE-CANDIDATE.json' if pre_only else 'PRE-COMPLETED.json')
    # Exclusive local evidence also fences accidental whole-operation replay.
    with pre_file.open('xb') as f:f.write(data)
    if pre_only:print(json.dumps({'result':'ALL_TARGET_READONLY_PRE_PASS','evidence':str(pre_file)}));return
    again=readonly_transport(sources,pin)
    if evidence.get('oldHostCampaign')!=again.get('oldHostCampaign'):raise ValueError('OLD_HOST_CAMPAIGN_DRIFT')
    for role in ['executor','controller']:
        for key in ['hostname','bootId','units','protectedHashes','executorProtection','oldCampaignInputs']:
            if evidence['targets'][role]['snapshot'].get(key)!=again['targets'][role]['snapshot'].get(key):raise ValueError('PRE_DRIFT_BEFORE_TRANSFER')
    ssh=SSH
    remote='/var/tmp/ai-linux-qualification-retest-20261010-release'
    prepare=host_modules(sources)+'assert pve.os.geteuid()==0 and pve.socket.gethostname()=="pve5"; print(json.dumps(pve.prepare_host_inputs('+repr({name:sources[name+'.py'] for name in ['evidence','capsule','deploy']})+','+repr(m['files'])+')))'
    r=command('transport.host-reuse',[*ssh,'python3 -I -B -'],input=prepare.encode(),capture_output=True,timeout=600)
    (root/'HOST-REUSE-TRANSPORT.json').write_bytes(r.stdout)
    if r.returncode:raise ValueError('HOST_PUBLIC_REUSE_STOPPED_NO_RETRY')
    for name in ['DEPLOYMENT-PACKAGE.json',*m['files'],'PRE-COMPLETED.json']:
        if name in ['capsule.tar','host-runtime.tar']:continue
        p=root/name;size=p.stat().st_size;digest=hashlib.sha256(p.read_bytes()).hexdigest()
        if name=='PRE-COMPLETED.json' and digest!=pre_sha:raise ValueError('PRE_CUSTODY_CHANGED')
        if name=='DEPLOYMENT-PACKAGE.json' and digest!=pin or name in m['files'] and digest!=m['files'][name]:raise ValueError('TRANSFER_INPUT_CHANGED')
        code=host_modules(sources)+'assert pve.os.geteuid()==0 and pve.socket.gethostname()=="pve5"; print(json.dumps(pve.receive_host_input('+repr(name)+',sys.stdin.buffer,'+repr(size)+','+repr(digest)+')))'
        # Public small inputs only (large archives already copied on host); bounded framing
        # keeps source out of Windows command lines and leaves file bytes on the same stdin.
        if size>32*1024**2:raise ValueError('SMALL_INPUT_TRANSFER_BOUND')
        payload=p.read_bytes();framed=frame_source(code,payload)
        r=command('transport.small-input', [ssh[0],'-C',*ssh[1:],'python3 -I -B -c '+shlex.quote(FRAME_LOADER)],input=framed,capture_output=True,timeout=1200)
        if r.returncode:raise ValueError('HOST_PUBLIC_UPLOAD_STOPPED_NO_RETRY')
    code='import hashlib,runpy,sys; from pathlib import Path; root=Path('+repr(remote)+'); p=root/"pve-operation.py"; '
    for name in ['pve-operation.py','capsule.py','evidence.py','provision-keys.py']:
        code+='assert hashlib.sha256((root/'+repr(name)+').read_bytes()).hexdigest()=='+repr(m['files'][name])+'; '
    code+='sys.argv=[str(p),'+repr(pin)+',"--human-approval-reference",'+repr(approval)+',"--pre-receipt-sha256",'+repr(pre_sha)+']; runpy.run_path(str(p),run_name="__main__")'
    r=command('transport.approved-adapter', [*ssh,'python3 -I -B -c '+shlex.quote(code)],capture_output=True,timeout=2100)
    (root/'approved-execution-transport.json').write_bytes(r.stdout)
    if r.returncode:raise ValueError('APPROVED_EXECUTION_STOPPED_CHECK_REDACTED_RECEIPT')
    print(r.stdout.decode())
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('bundle',type=Path);p.add_argument('approvedPackageSha256');p.add_argument('--human-approval-reference',default='');p.add_argument('--pre-only',action='store_true');a=p.parse_args()
    run(a.bundle,a.approvedPackageSha256,a.human_approval_reference,a.pre_only)
