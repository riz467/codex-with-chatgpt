"""Workstation transport for a separately Human-approved, SHA-pinned finite operation. No secrets logged.
Does not invent approval or bypass independent organizational signature gates. Public files only via scp.
"""
import argparse
import hashlib
import json
import shlex
import subprocess
import sys
import argparse
from pathlib import Path
SSH=['ssh','-F','C:/work/.ssh/config','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8','-o','IdentitiesOnly=yes','pve5']
def readonly_transport(sources,pin):
    code='import sys,types,json; '
    for name,file in [('capsule','capsule.py'),('campaign_keys','provision-keys.py'),('pve_operation','pve-operation.py')]:
        code+='m=types.ModuleType('+repr(name)+'); m.__file__='+repr('/nonexistent/'+file)+'; sys.modules['+repr(name)+']=m; exec(compile('+repr(sources[file])+',m.__file__,"exec"),m.__dict__); '
    code+='print(json.dumps(sys.modules["pve_operation"].observe('+repr({name:sources[name+'.py'] for name in ['capsule','deploy']})+','+repr(pin)+',True)))'
    # Code is streamed, no remote file, argv source/secrets, pycache, mkdir or upload.
    r=subprocess.run([*SSH,'python3 -I -B -'],input=code.encode(),capture_output=True,timeout=750)
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
    if not pre_only and not approval.strip():raise ValueError('ACTUAL_HUMAN_APPROVAL_REQUIRED')
    data=(root/'DEPLOYMENT-PACKAGE.json').read_bytes()
    if hashlib.sha256(data).hexdigest()!=pin:raise ValueError('APPROVED_MANIFEST_SHA')
    m=json.loads(data)
    required={'capsule.tar','host-runtime.tar','raw-source.tar','source.tar','deploy.py','capsule.py','broker.service','controller.service','executor@.service','provision-keys.py','pve-operation.py','run-approved.py'}
    if m.get('schema')!=1 or m.get('targetVmids')!=[116,117] or m.get('authority')!='NONE' or m.get('productionDispatch')!='CLOSED' or set(m.get('files',{}))!=required:raise ValueError('FIXED_PACKAGE_SCHEMA_SCOPE_AND_REQUIRED_FILES')
    verified={}
    for name,digest in m['files'].items():
        if '/' in name or '\\' in name or name in ['.','..'] or hashlib.sha256((root/name).read_bytes()).hexdigest()!=digest:raise ValueError('PUBLIC_PACKAGE_INTEGRITY')
        if name.endswith('.py'):
            content=(root/name).read_bytes()
            if hashlib.sha256(content).hexdigest()!=digest:raise ValueError('ADAPTER_SOURCE_CHANGED')
            verified[name]=content
    sources={name:verified[name].decode('utf-8') for name in ['capsule.py','deploy.py','provision-keys.py','pve-operation.py']}
    evidence=readonly_transport(sources,pin) # BOTH VM PRE passes BEFORE host or guest changes.
    data=json.dumps(evidence,sort_keys=True,separators=(',',':')).encode();pre_sha=hashlib.sha256(data).hexdigest()
    pre_file=root/('READONLY-PRE-CANDIDATE.json' if pre_only else 'PRE-COMPLETED.json')
    # Exclusive local evidence also fences accidental whole-operation replay.
    with pre_file.open('xb') as f:f.write(data)
    if pre_only:print(json.dumps({'result':'ALL_TARGET_READONLY_PRE_PASS','evidence':str(pre_file)}));return
    again=readonly_transport(sources,pin)
    for role in ['executor','controller']:
        for key in ['hostname','bootId','units','protectedHashes','executorProtection']:
            if evidence['targets'][role]['snapshot'].get(key)!=again['targets'][role]['snapshot'].get(key):raise ValueError('PRE_DRIFT_BEFORE_TRANSFER')
    ssh=SSH
    remote='/var/tmp/ai-linux-qualification-release'
    prepare='import os,socket; from pathlib import Path; assert os.geteuid()==0 and socket.gethostname()=="pve5"; Path('+repr(remote)+').mkdir(mode=0o700)'
    subprocess.run([*ssh,'python3 -I -B -c '+shlex.quote(prepare)],check=True,timeout=30)
    for name in ['DEPLOYMENT-PACKAGE.json',*m['files'],'PRE-COMPLETED.json']:
        subprocess.run(['scp','-F','C:/work/.ssh/config','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','IdentitiesOnly=yes',str(root/name),'pve5:'+remote+'/'+name],check=True,timeout=300)
    code='import hashlib,runpy,sys; from pathlib import Path; root=Path('+repr(remote)+'); p=root/"pve-operation.py"; '
    for name in ['pve-operation.py','capsule.py','provision-keys.py']:
        code+='assert hashlib.sha256((root/'+repr(name)+').read_bytes()).hexdigest()=='+repr(m['files'][name])+'; '
    code+='sys.argv=[str(p),'+repr(pin)+',"--human-approval-reference",'+repr(approval)+',"--pre-receipt-sha256",'+repr(pre_sha)+']; runpy.run_path(str(p),run_name="__main__")'
    r=subprocess.run([*ssh,'python3 -I -B -c '+shlex.quote(code)],capture_output=True,timeout=2100)
    (root/'approved-execution-transport.json').write_bytes(r.stdout)
    if r.returncode:raise ValueError('APPROVED_EXECUTION_STOPPED_CHECK_REDACTED_RECEIPT')
    print(r.stdout.decode())
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('bundle',type=Path);p.add_argument('approvedPackageSha256');p.add_argument('--human-approval-reference',default='');p.add_argument('--pre-only',action='store_true');a=p.parse_args()
    run(a.bundle,a.approvedPackageSha256,a.human_approval_reference,a.pre_only)
