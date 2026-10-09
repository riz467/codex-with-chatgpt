"""Workstation transport for a separately Human-approved, SHA-pinned finite operation. No secrets logged.
Does not invent approval or bypass independent organizational signature gates. Public files only via scp.
"""
import argparse
import hashlib
import json
import shlex
import subprocess
from pathlib import Path

def run(root,pin,approval):
    if not approval.strip():raise ValueError('ACTUAL_HUMAN_APPROVAL_REQUIRED')
    data=(root/'DEPLOYMENT-PACKAGE.json').read_bytes()
    if hashlib.sha256(data).hexdigest()!=pin:raise ValueError('APPROVED_MANIFEST_SHA')
    m=json.loads(data)
    for name,digest in m['files'].items():
        if '/' in name or '\\' in name or name in ['.','..'] or hashlib.sha256((root/name).read_bytes()).hexdigest()!=digest:raise ValueError('PUBLIC_PACKAGE_INTEGRITY')
    ssh=['ssh','-F','C:/work/.ssh/config','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8','-o','IdentitiesOnly=yes','pve5']
    remote='/var/tmp/ai-linux-qualification-release'
    prepare='import os,socket; from pathlib import Path; assert os.geteuid()==0 and socket.gethostname()=="pve5"; Path('+repr(remote)+').mkdir(mode=0o700)'
    subprocess.run([*ssh,'python3 -I -B -c '+shlex.quote(prepare)],check=True,timeout=30)
    for name in ['DEPLOYMENT-PACKAGE.json',*m['files']]:
        subprocess.run(['scp','-F','C:/work/.ssh/config','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','IdentitiesOnly=yes',str(root/name),'pve5:'+remote+'/'+name],check=True,timeout=300)
    code='import hashlib,runpy,sys; from pathlib import Path; p=Path('+repr(remote+'/pve-operation.py')+'); assert hashlib.sha256(p.read_bytes()).hexdigest()=='+repr(m['files']['pve-operation.py'])+'; sys.argv=[str(p),'+repr(pin)+',"--human-approval-reference",'+repr(approval)+']; runpy.run_path(str(p),run_name="__main__")'
    r=subprocess.run([*ssh,'python3 -I -B -c '+shlex.quote(code)],capture_output=True,timeout=2100)
    (root/'approved-execution-transport.json').write_bytes(r.stdout)
    if r.returncode:raise ValueError('APPROVED_EXECUTION_STOPPED_CHECK_REDACTED_RECEIPT')
    print(r.stdout.decode())
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('bundle',type=Path);p.add_argument('approvedPackageSha256');p.add_argument('--human-approval-reference',required=True);a=p.parse_args()
    run(a.bundle,a.approvedPackageSha256,a.human_approval_reference)
