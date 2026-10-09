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
spec=importlib.util.spec_from_file_location('campaign_keys',Path(__file__).parent/'provision-keys.py')
keys=importlib.util.module_from_spec(spec);spec.loader.exec_module(keys)

ROOT=Path('/var/tmp/ai-linux-qualification-release')
GUEST='/var/lib/ai-linux-qualification-approved-input'
class Qga:
    def __init__(self,vmid):
        require(vmid in [116,117],'FIXED_VMID');self.sock=socket.socket(socket.AF_UNIX);self.sock.settimeout(30)
        self.sock.connect('/var/run/qemu-server/'+str(vmid)+'.qga');self.reader=self.sock.makefile('rb');self.counter=0
        self.sock.sendall(b'\xff');self.call('guest-sync-delimited',{'id':int(time.time()*1000)})
    def call(self,command,args=None):
        self.counter+=1;self.sock.sendall(json.dumps({'execute':command,'arguments':args or {},'id':self.counter}).encode()+b'\n')
        for _ in range(20):
            data=self.reader.readline(8*1024*1024).lstrip(b'\xff');require(bool(data),'QGA_EOF');r=json.loads(data)
            if 'error' in r:raise ValueError('QGA_OPERATION_REJECTED')
            if 'return' in r:return r['return']
        raise ValueError('QGA_PROTOCOL')
    def python(self,code,timeout=120):
        proc=self.call('guest-exec',{'path':'/usr/bin/python3','arg':['-I','-B','-'],
          'input-data':base64.b64encode(code.encode()).decode(),'capture-output':True})
        until=time.monotonic()+timeout
        while time.monotonic()<until:
            r=self.call('guest-exec-status',{'pid':proc['pid']})
            if r.get('exited'):
                require(r.get('exitcode')==0,'GUEST_FIXED_OPERATION_FAILED')
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
def main(pin,approval):
    require(approval.strip(),'ACTUAL_HUMAN_APPROVAL_REFERENCE_REQUIRED');pre=resource_pre();require(ROOT.is_dir() and not ROOT.is_symlink(),'FIXED_INPUT_ROOT')
    m=json.loads((ROOT/'DEPLOYMENT-PACKAGE.json').read_text());require(sha((ROOT/'DEPLOYMENT-PACKAGE.json').read_bytes())==pin,'APPROVED_PACKAGE_SHA')
    require(m['targetVmids']==[116,117] and m['productionDispatch']=='CLOSED' and m['authority']=='NONE','FIXED_SCOPE')
    for name,digest in m['files'].items():
        require('/' not in name and '\\' not in name and name not in ['.','..'],'PUBLIC_PATH');require(file_sha(ROOT/name)==digest,'PUBLIC_FILE_SHA')
    claim=ROOT/'APPROVED-EXECUTION-CLAIM.json';fd=os.open(claim,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    try:os.write(fd,canonical({'packageSha256':pin,'approvalReference':approval,'pvePre':pre}).encode());os.fsync(fd)
    finally:os.close(fd)
    directory=os.open(ROOT,os.O_RDONLY|os.O_DIRECTORY);os.fsync(directory);os.close(directory)
    custody=keys.provision(ROOT/'private-campaign-keys');receipts={};installed=[]
    try:
        for vmid,role,hostname in [(117,'executor','rc02-executor-117'),(116,'controller','ai-control-116')]:
            q=Qga(vmid)
            try:
                receipts[role+'-prepare']=q.python('import os,socket,json; from pathlib import Path; assert os.geteuid()==0 and socket.gethostname()=='+repr(hostname)+'; p=Path('+repr(GUEST)+'); p.mkdir(mode=0o700); print(json.dumps({"prepared":True}))')
                for name in ['DEPLOYMENT-PACKAGE.json',*m['files']]:
                    # Controller needs only host runtime/source, but package verification binds all supplied public files.
                    q.upload(GUEST+'/'+name,ROOT/name)
                def operation(mode,secret=None):
                    # Only the approved fixed adapter; secret payload never appears in argv/stdout.
                    code='import sys,runpy,io,json,hashlib; from pathlib import Path; p=Path('+repr(GUEST+'/deploy.py')+'); assert hashlib.sha256(p.read_bytes()).hexdigest()=='+repr(m['files']['deploy.py'])+'; sys.argv=[str(p),'+repr(mode)+','+repr(role)+','+repr(pin)+']; '
                    if secret is not None:code+='sys.stdin=io.TextIOWrapper(io.BytesIO('+repr(json.dumps(secret).encode())+')); '
                    return q.python(code+'runpy.run_path(str(p),run_name="__main__")',300)
                receipts[role+'-pre']=operation('pre');installed.append((vmid,role));receipts[role+'-exec']=operation('exec',keys.role_input(custody,role));receipts[role+'-post']=operation('post')
            finally:q.close()
        # Start only the new broker, then the one-shot controller. No enable, boot, existing unit restart or PVE ACL.
        for vmid,unit in [(117,'ai-linux-qualification-broker.service'),(116,'ai-linux-qualification-controller.service')]:
            q=Qga(vmid)
            try:receipts[unit]=q.python('import subprocess,json; r=subprocess.run(["/usr/bin/systemctl","start",'+repr(unit)+'],timeout=970); print(json.dumps({"exitCode":r.returncode})); raise SystemExit(0 if r.returncode==0 else 2)',990)
            finally:q.close()
        q=Qga(116)
        try:
            receipts['linux-control-report']=q.python('import json,subprocess,re; from pathlib import Path; root=Path("/var/lib/ai-linux-qualification-controller"); rows=list(root.glob("linux-qualification-*/task.json")); assert len(rows)==1; l=json.loads(rows[0].read_text()); task=l["taskId"]; assert re.fullmatch("linux-qualification-[a-f0-9]{32}",task); r=subprocess.run(["/usr/sbin/runuser","-u","ai-qualification-controller","--","/opt/ai-linux-qualification-controller/host-runtime/usr/bin/node","/opt/ai-linux-qualification-controller/source/dist/linux-qualification/cli.js","report",task],capture_output=True,text=True,timeout=15); assert r.returncode==0; report=json.loads(r.stdout); assert report["result"]=="FIXED_13_SUITE_QUALIFICATION_PASS" and report["authority"]=="NONE" and report["productionDispatch"]=="CLOSED"; print(json.dumps(report))')
        finally:q.close()
        receipts['result']='FIXED_13_SUITE_QUALIFICATION_COMPLETED_NOT_PROVIDER_E2E'
    except Exception:
        receipts['result']='STOPPED_EXECUTION_OUTCOME_UNKNOWN_NO_REPLAY'
        for vmid,role in reversed(installed):
            q=None
            try:
                q=Qga(vmid);receipts[role+'-rollback']=q.python('import sys,runpy; sys.argv=['+repr(GUEST+'/deploy.py')+',"rollback",'+repr(role)+','+repr(pin)+']; runpy.run_path(sys.argv[0],run_name="__main__")')
            except Exception:receipts[role+'-rollback']={'result':'UNKNOWN_HUMAN_INSPECTION_REQUIRED'}
            finally:
                if q:q.close()
    # Existing service hashes/PIDs/boot are checked again after the new campaign has actually run.
    post_failure=False
    for vmid,role in installed:
        q=None
        try:
            q=Qga(vmid);receipts[role+'-final-protection']=q.python('import sys; sys.path.insert(0,'+repr(GUEST)+'); import deploy,json; r=deploy.ROLES['+repr(role)+']; old=json.loads((deploy.INPUT/('+repr(role)+'+"-PRE.json")).read_text())["snapshot"]; new=deploy.snapshot('+repr(role)+'); assert all(new[k]==old[k] for k in ["bootId","units","protectedHashes"]); assert new["memAvailableKiB"]>='+str(3407872 if role=='executor' else 524288)+' and new["diskFreeBytes"]>=8*1024**3; print(json.dumps({"result":"PROTECTED_BASELINE_UNCHANGED","memAvailableKiB":new["memAvailableKiB"],"diskFreeBytes":new["diskFreeBytes"]}))')
        except Exception:receipts[role+'-final-protection']={'result':'UNKNOWN'};receipts['result']='POST_PROTECTION_UNKNOWN';post_failure=True
        finally:
            if q:q.close()
    try:receipts['pve-final-resources']=resource_pre()
    except Exception:receipts['result']='POST_RESOURCES_UNKNOWN';post_failure=True
    if post_failure:
        for vmid,role in reversed(installed):
            q=None
            try:
                q=Qga(vmid);receipts[role+'-late-rollback']=q.python('import sys,runpy; sys.argv=['+repr(GUEST+'/deploy.py')+',"rollback",'+repr(role)+','+repr(pin)+']; runpy.run_path(sys.argv[0],run_name="__main__")')
            except Exception:receipts[role+'-late-rollback']={'result':'UNKNOWN_HUMAN_INSPECTION_REQUIRED'}
            finally:
                if q:q.close()
    (ROOT/'EXECUTION-RECEIPT.json').write_text(json.dumps(receipts,indent=2)+'\n');print(json.dumps(receipts))
    return 0 if receipts['result']=='FIXED_13_SUITE_QUALIFICATION_COMPLETED_NOT_PROVIDER_E2E' else 2
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('approvedPackageSha256');p.add_argument('--human-approval-reference',required=True);a=p.parse_args()
    try:sys.exit(main(a.approvedPackageSha256,a.human_approval_reference))
    except Exception:print('{"result":"PVE_FIXED_OPERATION_BLOCKED_NO_REPLAY"}');sys.exit(2)
