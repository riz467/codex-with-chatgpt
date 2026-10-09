"""Fixed PRE/EXEC/POST/rollback adapter. Requires separate explicit Human approval before any EXEC.
Run through existing Human management/QGA, never an AI unrestricted sudo/PVE key. No existing service,
account, network, SSH, VM or auth modification. New campaign secrets arrive via private stdin only.
"""
import argparse
import hashlib
import json
import os
import pwd
import socket
import subprocess
import sys
import tarfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from capsule import canonical, inventory, require, sha, file_sha, verify_archive

INPUT=Path('/var/lib/ai-linux-qualification-approved-input')
ROLES={
 'executor':{'hostname':'rc02-executor-117','account':'ai-qualification-executor','root':Path('/opt/ai-linux-qualification'),
   'state':Path('/var/lib/ai-linux-qualification-executor'),'secrets':Path('/etc/ai-linux-qualification-broker'),
   'unit':'ai-linux-qualification-broker.service','unitFile':'broker.service'},
 'controller':{'hostname':'ai-control-116','account':'ai-qualification-controller','root':Path('/opt/ai-linux-qualification-controller'),
   'state':Path('/var/lib/ai-linux-qualification-controller'),'secrets':Path('/etc/ai-linux-qualification-controller'),
   'unit':'ai-linux-qualification-controller.service','unitFile':'controller.service'}}
KEEP=['ai-linux-gateway-staging.service','ai-linux-dashboard-staging.service','ai-control-bridge.service','ai-control-cloudflared.service']
def run(args,check=True):
    p=subprocess.run(args,capture_output=True,text=True,timeout=30,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C'})
    if check:require(p.returncode==0,'FIXED_COMMAND_FAILED')
    return p.stdout
def safe(path,allow_user=None):
    for p in [path,*path.parents]:
        if p.exists():
            s=p.lstat();require(not p.is_symlink() and s.st_uid in [0,allow_user] and not s.st_mode&0o022,'PATH_CUSTODY')
        else:require(not p.is_symlink(),'DANGLING_SYMLINK')
def write(path,value,uid=0,gid=0,mode=0o600):
    safe(path.parent,uid);fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
    try:
        data=value if isinstance(value,bytes) else value.encode()
        with os.fdopen(fd,'wb',closefd=False) as f:f.write(data);f.flush()
        os.fchown(fd,uid,gid);os.fsync(fd)
    finally:os.close(fd)
    fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(fd)
    finally:os.close(fd)
def snapshot(role):
    mem=dict((line.split(':')[0],int(line.split()[1])) for line in Path('/proc/meminfo').read_text().splitlines())
    units={u:run(['systemctl','show',u,'-p','ActiveState','-p','SubState','-p','MainPID','-p','ExecMainStartTimestampMonotonic','-p','FragmentPath'],False) for u in KEEP} if role=='controller' else {}
    hashes={}
    for path in ['/etc/ssh/sshd_config','/etc/sudoers',*map(str,Path('/etc/ssh').glob('ssh_host_*_key'))]:
        if Path(path).is_file():hashes[path]=sha(Path(path).read_bytes()) # Digest only, never content.
    for value in units.values():
        props=dict(line.split('=',1) for line in value.splitlines() if '=' in line)
        require(props.get('ActiveState')=='active' and props.get('SubState')=='running' and int(props.get('MainPID','0'))>0,'PROTECTED_UNIT_NOT_RUNNING')
        pid=props['MainPID'];exe=Path('/proc/'+pid+'/exe').resolve();hashes[str(exe)]=file_sha(exe)
        for arg in Path('/proc/'+pid+'/cmdline').read_bytes().split(b'\0'):
            path=Path(arg.decode(errors='replace'))
            if path.is_absolute() and path.suffix in ['.js','.mjs','.cjs','.py','.sh'] and path.is_file():hashes[str(path)]=file_sha(path)
        for line in value.splitlines():
            if line.startswith('FragmentPath=') and line[13:] and Path(line[13:]).is_file():hashes[line[13:]]=sha(Path(line[13:]).read_bytes())
    if role=='controller':
        staging=Path('/srv/ai-orchestration/codex-with-chatgpt');manifest=staging/'RUNTIME-MANIFEST.json'
        require(file_sha(manifest)=='8a47c7211c871ef45293b4a0fa3016c5f5182cc879d35d707c34a0432966aa72','PRESERVED_STAGING_MANIFEST')
        body=json.loads(manifest.read_text());require(len(body['files'])==595,'PRESERVED_STAGING_COUNT')
        for item in body['files']:
            from capsule import portable
            portable(item['path']);p=staging/item['path'];require(file_sha(p)==item['sha256'],'PRESERVED_STAGING_FILE_SHA');hashes[str(p)]=item['sha256']
    return {'hostname':socket.gethostname(),'bootId':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
      'memAvailableKiB':mem['MemAvailable'],'units':units,'protectedHashes':hashes,'diskFreeBytes':os.statvfs('/opt').f_bavail*os.statvfs('/opt').f_frsize}
def package(pin):
    safe(INPUT);file=INPUT/'DEPLOYMENT-PACKAGE.json';require(sha(file.read_bytes())==pin,'HUMAN_APPROVED_PACKAGE_SHA_REQUIRED')
    m=json.loads(file.read_text());require(m['schema']==1 and m['targetVmids']==[116,117] and m['authority']=='NONE' and m['productionDispatch']=='CLOSED','PACKAGE_SCOPE')
    for name,digest in m['files'].items():
        require('/' not in name and '\\' not in name and name not in ['.','..'],'PACKAGE_PATH');safe(INPUT/name)
        require(file_sha(INPUT/name)==digest,'PACKAGE_FILE_SHA')
    require(m['files']['raw-source.tar']==m['sourcePins']['sourceArchiveSha256'],'SOURCE_ARCHIVE_PROVENANCE')
    return m
def extract(archive,target,digest):
    require(not target.exists(),'TARGET_EXISTS');verify_archive(archive,digest);target.mkdir(mode=0o755)
    with tarfile.open(archive,'r:') as t:
        for member in t:
            p=target/member.name
            if member.isdir():p.mkdir(mode=0o755,parents=True,exist_ok=True)
            else:
                p.parent.mkdir(mode=0o755,parents=True,exist_ok=True);write(p,t.extractfile(member).read(),mode=member.mode)
def execute(mode,role,pin,secretInput=None):
    r=ROLES[role];require(os.geteuid()==0 and socket.gethostname()==r['hostname'],'ROOT_TARGET_IDENTITY')
    m=package(pin);receipt=INPUT/(role+'-PRE.json');created=INPUT/(role+'-CREATED.json')
    if mode=='pre':
        require(not r['root'].exists() and not r['state'].exists() and not r['secrets'].exists() and not Path('/etc/systemd/system',r['unit']).exists(),'NEW_TARGETS_ONLY')
        try:pwd.getpwnam(r['account']);raise ValueError('ACCOUNT_EXISTS')
        except KeyError:pass
        s=snapshot(role);require(s['memAvailableKiB']>=(3407872 if role=='executor' else 524288) and s['diskFreeBytes']>=8*1024**3,'RESOURCE_GATE')
        if role=='executor':
            require(Path('/sys/fs/cgroup/cgroup.controllers').exists(),'CGROUP_V2_REQUIRED');safe(Path('/usr/bin/bwrap'))
            require(Path('/usr/bin/bwrap').is_file() and Path('/usr/bin/openssl').is_file(),'HOST_TOOLS_REQUIRED')
            require(not run(['systemctl','list-units','ai-linux-qualification-*.service','--state=running','--no-legend','--no-pager']).strip(),'EXECUTOR_BUSY')
            require(not Path('/var/lib/ai-linux-qualification-broker').exists() and not Path('/etc/systemd/system/ai-linux-qualification-executor@.service').exists(),'NEW_BROKER_TARGETS_ONLY')
            require(not run(['getent','group','ai-qualification-evidence'],False).strip(),'EVIDENCE_GROUP_EXISTS')
        write(receipt,canonical({'packageSha256':pin,'snapshot':s}));return {'phase':'PRE','result':'PASS','role':role}
    require(receipt.exists(),'PRE_REQUIRED');pre=json.loads(receipt.read_text());require(pre['packageSha256']==pin,'PRE_PACKAGE_BINDING')
    if mode=='exec':
        require(not created.exists(),'EXEC_REPLAY_REJECTED');current=snapshot(role)
        require(current['bootId']==pre['snapshot']['bootId'] and current['protectedHashes']==pre['snapshot']['protectedHashes'] and current['units']==pre['snapshot']['units'],'PRE_DRIFT')
        require(current['memAvailableKiB']>=(3407872 if role=='executor' else 524288) and current['diskFreeBytes']>=8*1024**3,'RESOURCE_GATE')
        # Durable claim first. A failed install is never automatically replayed or deleted.
        write(created,canonical({'packageSha256':pin,'role':role,'targets':{k:str(r[k]) for k in ['root','state','secrets']}}))
        require(isinstance(secretInput,dict),'PRIVATE_PROVISION_INPUT_REQUIRED')
        run(['useradd','--system','--user-group','--no-create-home','--home-dir','/nonexistent','--shell','/usr/sbin/nologin',r['account']]);a=pwd.getpwnam(r['account'])
        evidence_gid=a.pw_gid
        if role=='executor':
            import grp
            run(['groupadd','--system','ai-qualification-evidence']);evidence_gid=grp.getgrnam('ai-qualification-evidence').gr_gid
        r['state'].mkdir(mode=0o700);os.chown(r['state'],a.pw_uid,evidence_gid);os.chmod(r['state'],0o2750 if role=='executor' else 0o700)
        r['secrets'].mkdir(mode=0o700 if role=='executor' else 0o750);os.chown(r['secrets'],0,0 if role=='executor' else a.pw_gid)
        r['root'].mkdir(mode=0o755)
        if role=='executor':extract(INPUT/'capsule.tar',r['root']/'runtime',m['files']['capsule.tar'])
        extract(INPUT/'host-runtime.tar',r['root']/'host-runtime',m['files']['host-runtime.tar'])
        extract(INPUT/'source.tar',r['root']/'source',m['files']['source.tar'])
        # Plain root-owned dependency files for trusted host CLI; sandbox receives the separately pinned runtime.
        # Node module resolution walks up source -> root; no symlink aliases.
        import shutil
        shutil.copytree(r['root']/'host-runtime/runtime/node_modules',r['root']/'node_modules',copy_function=shutil.copyfile)
        write(r['root']/'source-pins.json',canonical(m['sourcePins']),mode=0o644)
        keys=['client-public.pem','broker-private.pem','broker-public.pem','tls-private.pem','tls-cert.pem'] if role=='executor' else ['client-private.pem','broker-public.pem','tls-cert.pem','tls-cert.sha256']
        require(set(secretInput)==set(keys),'PRIVATE_PROVISION_SCOPE')
        for name in keys:
            require(isinstance(secretInput[name],str) and len(secretInput[name])<=16384,'PRIVATE_INPUT_LIMIT');write(r['secrets']/name,secretInput[name],gid=0 if role=='executor' else a.pw_gid,mode=0o600 if role=='executor' else 0o640)
        if role=='executor':
            Path('/var/lib/ai-linux-qualification-broker').mkdir(mode=0o700)
            write(Path('/etc/systemd/system/ai-linux-qualification-executor@.service'),(INPUT/'executor@.service').read_bytes(),mode=0o644)
        unit=(INPUT/r['unitFile']).read_bytes();write(Path('/etc/systemd/system')/r['unit'],unit,mode=0o644)
        run(['systemctl','daemon-reload'])
        # No enable/onboot: temporary campaign units; controller starts only after executor installation POST.
        return {'phase':'EXEC','result':'INSTALLED_NOT_STARTED','role':role}
    require(created.exists() and json.loads(created.read_text())['packageSha256']==pin,'CREATED_CUSTODY')
    if mode=='post':
        s=snapshot(role);require(s['bootId']==pre['snapshot']['bootId'] and s['protectedHashes']==pre['snapshot']['protectedHashes'] and s['units']==pre['snapshot']['units'],'PROTECTED_SERVICE_DRIFT')
        if role=='executor':require(sha(canonical(inventory(r['root']/'runtime')).encode())==m['sourcePins']['runtimeCapsuleSha256'],'DEPLOYED_CAPSULE_SHA')
        require(sha(canonical(inventory(r['root']/'host-runtime')).encode())==m['hostRuntimeInventorySha256'],'DEPLOYED_HOST_RUNTIME_SHA')
        manifest=json.loads((r['root']/'source/SOURCE-MANIFEST.json').read_text());actual=inventory(r['root']/'source');actual=[x for x in actual if x['path']!='SOURCE-MANIFEST.json']
        require(manifest['files']==actual and manifest['sourceCommit']==m['sourcePins']['sourceCommit'] and manifest['sourceArchiveSha256']==m['sourcePins']['sourceArchiveSha256'],'DEPLOYED_SOURCE_SHA')
        require(sha(Path('/etc/systemd/system',r['unit']).read_bytes())==m['files'][r['unitFile']],'UNIT_SHA')
        write(INPUT/(role+'-POST.json'),canonical({'phase':'POST','result':'PASS','snapshot':s,'linux13Suite':'NOT_RUN'}))
        return {'phase':'POST','result':'PASS','role':role,'linux13Suite':'NOT_RUN'}
    if mode=='rollback':
        # Keep account, source, evidence and private credentials inaccessible; never broad-delete or alter existing VM.
        run(['systemctl','stop',r['unit']]);require('ActiveState=inactive' in run(['systemctl','show',r['unit'],'-p','ActiveState']),'ROLLBACK_UNIT_NOT_STOPPED')
        if role=='executor':
            record=Path('/var/lib/ai-linux-qualification-broker/execution.json')
            if record.exists():
                task=json.loads(record.read_text())['request']['taskId'];require(__import__('re').fullmatch('linux-qualification-[a-f0-9]{32}',task),'ROLLBACK_TASK_ID')
                unit='ai-linux-qualification-executor@'+task.split('-')[-1]+'.service';run(['systemctl','stop',unit])
                require('ActiveState=inactive' in run(['systemctl','show',unit,'-p','ActiveState']),'ROLLBACK_JOB_NOT_STOPPED')
                cgroup=Path('/sys/fs/cgroup/system.slice')/unit
                if cgroup.exists():require(all(not f.read_text().strip() for f in cgroup.rglob('cgroup.procs')),'ROLLBACK_CGROUP_NOT_EMPTY')
            else:
                require(not list(r['state'].glob('linux-qualification-*')) and not run(['systemctl','list-units','ai-linux-qualification-executor@*.service','--state=running','--no-legend','--no-pager']).strip(),'ROLLBACK_EXECUTION_RECORD_MISSING')
        s=snapshot(role);require(s['bootId']==pre['snapshot']['bootId'] and s['protectedHashes']==pre['snapshot']['protectedHashes'] and s['units']==pre['snapshot']['units'],'ROLLBACK_PROTECTED_DRIFT')
        return {'phase':'ROLLBACK','result':'NEW_UNITS_STOPPED_EVIDENCE_RETAINED','role':role}
    raise ValueError('FIXED_MODE_ONLY')
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('mode',choices=['pre','exec','post','rollback']);p.add_argument('role',choices=list(ROLES));p.add_argument('approvedPackageSha256');a=p.parse_args()
    try:
        secret=None
        if a.mode=='exec':
            data=sys.stdin.buffer.read(65537);require(len(data)<=65536,'PRIVATE_INPUT_LIMIT');secret=json.loads(data)
        print(json.dumps(execute(a.mode,a.role,a.approvedPackageSha256,secret)))
    except Exception:
        print(json.dumps({'result':'BLOCKED','phase':a.mode,'role':a.role,'automaticReplay':False}));sys.exit(2)
