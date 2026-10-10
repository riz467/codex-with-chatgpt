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
import stat
import re
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from capsule import canonical, inventory, require, sha, file_sha, verify_archive
from evidence import Journal,EvidenceFailure,failure,process,require_external_fence
EVENTS=None
CURRENT_STEP=None
def stage(step):
    global CURRENT_STEP
    if EVENTS:
        if CURRENT_STEP:EVENTS.emit(CURRENT_STEP,'SUCCESS')
        EVENTS.emit(step,'BEGIN')
    CURRENT_STEP=step

INPUT=Path('/var/lib/ai-linux-qualification-retest-20261010-input')
V2_INPUT=Path('/var/lib/ai-linux-qualification-custody-v2-input')
OLD_INPUT=Path('/var/lib/ai-linux-qualification-approved-input')
PUBLIC_NAMES=frozenset(['DEPLOYMENT-PACKAGE.json','capsule.tar','host-runtime.tar','raw-source.tar','source.tar','deploy.py','capsule.py','evidence.py','broker.service','controller.service','executor@.service','provision-keys.py','pve-operation.py','run-approved.py'])
def input_directory():
    require(all(INPUT!=p and INPUT not in p.parents and p not in INPUT.parents for p in [OLD_INPUT,V2_INPUT]),'FRESH_INPUT_PATH_COLLISION')
    safe(INPUT);s=INPUT.lstat()
    require(stat.S_ISDIR(s.st_mode) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o700,'INPUT_DIRECTORY_CUSTODY')
    return s
def upload_identity(name):
    require(name in PUBLIC_NAMES,'FIXED_UPLOAD_NAME');input_directory();p=INPUT/name;s=p.lstat()
    require(stat.S_ISREG(s.st_mode) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o600 and s.st_nlink==1,'UPLOAD_FILE_CUSTODY')
    return {'device':s.st_dev,'inode':s.st_ino}
def prepare_upload(name):
    require(name in PUBLIC_NAMES,'FIXED_UPLOAD_NAME');input_directory()
    fd=os.open(INPUT/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        s=os.fstat(fd);require(stat.S_ISREG(s.st_mode) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o600 and s.st_nlink==1 and s.st_size==0,'UPLOAD_CREATE_CUSTODY')
        identity={'device':s.st_dev,'inode':s.st_ino}
        os.fsync(fd)
    finally:os.close(fd)
    directory=os.open(INPUT,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(directory)
    finally:os.close(directory)
    require(upload_identity(name)==identity,'UPLOAD_CREATE_INODE_CHANGED');return identity
def check_upload(name,identity,size,digest=None):
    require(upload_identity(name)==identity,'UPLOAD_INODE_CHANGED')
    fd=os.open(INPUT/name,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        s=os.fstat(fd);require({'device':s.st_dev,'inode':s.st_ino}==identity and s.st_nlink==1 and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o600 and s.st_size==size,'UPLOAD_FD_CUSTODY_OR_SIZE')
        if digest is not None:
            os.fsync(fd)
            with os.fdopen(os.dup(fd),'rb') as f:require(hashlib.file_digest(f,'sha256').hexdigest()==digest,'UPLOAD_FINAL_SHA')
    finally:os.close(fd)
    require(upload_identity(name)==identity,'UPLOAD_POST_CUSTODY')
    return {'result':'UPLOAD_VERIFIED' if digest is not None else 'UPLOAD_CUSTODY_PASS','bytes':size}
ROLES={
 'executor':{'hostname':'rc02-executor-117','account':'ai-qualification-executor','root':Path('/opt/ai-linux-qualification'),
   'state':Path('/var/lib/ai-linux-qualification-executor'),'secrets':Path('/etc/ai-linux-qualification-broker'),
   'unit':'ai-linux-qualification-broker.service','unitFile':'broker.service'},
 'controller':{'hostname':'ai-control-116','account':'ai-qualification-controller','root':Path('/opt/ai-linux-qualification-controller'),
   'state':Path('/var/lib/ai-linux-qualification-controller'),'secrets':Path('/etc/ai-linux-qualification-controller'),
   'unit':'ai-linux-qualification-controller.service','unitFile':'controller.service'}}
KEEP=['ai-linux-gateway-staging.service','ai-linux-dashboard-staging.service','ai-control-bridge.service','ai-control-cloudflared.service']
CAMPAIGN_UNITS={'ai-linux-qualification-broker.service','ai-linux-qualification-controller.service'}
CAMPAIGN_ACCOUNTS={'ai-qualification-executor','ai-qualification-controller','ai-qualification-evidence'}
def campaign_unit(name):return name in CAMPAIGN_UNITS or name.startswith('ai-linux-qualification-executor@')
def tree_digest(root,file_limit=256*1024**2):
    """Bounded existing-state digest. Return metadata/hash only; never secret bodies or symlink target bytes."""
    rows=[];total=0;active=set()
    def visit(p):
        nonlocal total
        s=p.lstat();require(len(rows)<100000,'BASELINE_FILE_COUNT')
        row={'path':str(p),'uid':s.st_uid,'gid':s.st_gid,'mode':stat.S_IMODE(s.st_mode),'device':s.st_dev,'inode':s.st_ino,'links':s.st_nlink}
        if p.is_symlink():
            row['linkSha256']=sha(os.readlink(p).encode())
            require(p.exists(),'BASELINE_DANGLING_LINK')
            target=p.resolve(strict=True);t=target.stat()
            require(not str(target).startswith(('/proc/','/sys/','/dev/')),'BASELINE_UNSAFE_LINK_TARGET')
            row['targetMetadata']={'uid':t.st_uid,'gid':t.st_gid,'mode':stat.S_IMODE(t.st_mode)}
            if p.is_file():
                require(t.st_size<=file_limit,'BASELINE_LINK_FILE_SIZE');total+=t.st_size;require(total<=4*1024**3,'BASELINE_TREE_SIZE');row['targetSha256']=file_sha(p)
            elif p.is_dir():
                rows.append(row);visit(target);return
            else:raise ValueError('BASELINE_SPECIAL_LINK_TARGET')
        elif p.is_dir():
            real=str(p.resolve(strict=True));require(real not in active,'BASELINE_LINK_CYCLE');active.add(real)
            row['kind']='directory';rows.append(row)
            for child in sorted(p.iterdir()):
                if str(p) in ['/etc/systemd/system','/run/systemd/system'] and campaign_unit(child.name):continue
                visit(child)
            active.remove(real)
            return
        elif p.is_file():
            require(s.st_size<=file_limit,'BASELINE_FILE_SIZE');total+=s.st_size;require(total<=4*1024**3,'BASELINE_TREE_SIZE')
            row.update(kind='file',bytes=s.st_size,sha256=file_sha(p))
        else:raise ValueError('BASELINE_SPECIAL_FILE')
        rows.append(row)
    if not root.exists() and not root.is_symlink():return {'present':False}
    visit(root);return {'present':True,'entries':len(rows),'sha256':sha(canonical(rows).encode())}
def stable_network(value):
    if isinstance(value,list):return sorted((stable_network(v) for v in value),key=canonical)
    if isinstance(value,dict):return {k:stable_network(v) for k,v in value.items() if k not in ['valid_life_time','preferred_life_time','expires']}
    return value
def effective_config_paths(service,profile):
    paths=set(profile)
    # Main config precedence and drop-in search paths include volatile/local-vendor roots.
    for family in ['journald','logind','networkd','resolved','timesyncd']:
        if service=='systemd-'+family+'.service':
            for prefix in ['/etc','/run','/usr/local/lib','/usr/lib']:
                paths.update([prefix+'/systemd/'+family+'.conf',prefix+'/systemd/'+family+'.conf.d'])
    if service=='systemd-networkd.service':paths.update(prefix+'/systemd/network' for prefix in ['/etc','/run','/usr/local/lib','/usr/lib'])
    if service=='systemd-udevd.service':paths.update(prefix+'/udev/rules.d' for prefix in ['/etc','/run','/usr/local/lib','/usr/lib'])
    if service=='dbus.service':paths.add('/usr/local/share/dbus-1/system.d')
    if service=='ssh.service' or service.startswith(('getty@','serial-getty@')) or service=='systemd-logind.service':
        # Preserve every included common-* module and security policy rather than just entry files.
        paths.update(['/etc/pam.d','/etc/security'])
    for prefix in ['/etc','/run','/usr/local/lib','/usr/lib']:
        paths.update([prefix+'/systemd/system.conf',prefix+'/systemd/system.conf.d'])
    return paths
def executor_baseline():
    names=[line.split()[0] for line in run(['systemctl','list-units','--type=service','--state=running','--no-legend','--no-pager']).splitlines()]
    names=sorted((set(names)|{'ssh.service','qemu-guest-agent.service'})-CAMPAIGN_UNITS)
    names=[n for n in names if not campaign_unit(n)]
    services={};files={};service_configs=set()
    config_profiles={
      'ssh.service':['/etc/ssh','/etc/default/ssh'],
      'qemu-guest-agent.service':['/etc/qemu','/etc/qemu-ga','/etc/default/qemu-guest-agent'],
      'dbus.service':['/etc/dbus-1','/usr/share/dbus-1/system.conf','/usr/share/dbus-1/system.d','/usr/share/dbus-1/system-services'],
      'systemd-journald.service':['/etc/systemd/journald.conf','/etc/systemd/journald.conf.d','/usr/lib/systemd/journald.conf.d'],
      'systemd-logind.service':['/etc/systemd/logind.conf','/etc/systemd/logind.conf.d','/usr/lib/systemd/logind.conf.d','/etc/pam.d/systemd-user'],
      'systemd-networkd.service':['/etc/systemd/networkd.conf','/etc/systemd/networkd.conf.d','/usr/lib/systemd/networkd.conf.d','/usr/lib/systemd/network','/etc/systemd/network'],
      'systemd-resolved.service':['/etc/systemd/resolved.conf','/etc/systemd/resolved.conf.d','/usr/lib/systemd/resolved.conf.d'],
      'systemd-timesyncd.service':['/etc/systemd/timesyncd.conf','/etc/systemd/timesyncd.conf.d','/usr/lib/systemd/timesyncd.conf.d'],
      'systemd-udevd.service':['/etc/udev','/usr/lib/udev/rules.d'],
      'unattended-upgrades.service':['/etc/apt/apt.conf','/etc/apt/apt.conf.d','/etc/apt/sources.list','/etc/apt/sources.list.d'],
      'getty@':['/etc/login.defs','/etc/issue','/etc/issue.net','/etc/default/locale','/etc/pam.d/login'],
      'serial-getty@':['/etc/login.defs','/etc/issue','/etc/issue.net','/etc/default/locale','/etc/pam.d/login']}
    for name in names:
        profile=next((paths for key,paths in config_profiles.items() if name==key or key.endswith('@') and name.startswith(key)),None)
        require(profile is not None,'BASELINE_SERVICE_PROFILE_UNKNOWN');service_configs.update(effective_config_paths(name,profile))
        text=run(['systemctl','show',name,'-p','ActiveState','-p','SubState','-p','MainPID','-p','ExecMainStartTimestampMonotonic','-p','FragmentPath','-p','DropInPaths','-p','EnvironmentFiles','-p','ExecStart'])
        props=dict(line.split('=',1) for line in text.splitlines() if '=' in line)
        require(props.get('FragmentPath'),'BASELINE_UNIT_UNRESOLVED')
        services[name]={k:props.get(k,'') for k in ['ActiveState','SubState','MainPID','ExecMainStartTimestampMonotonic']}
        services[name]['definitionSha256']=sha(text.encode())
        paths=[props['FragmentPath'],*props.get('DropInPaths','').split()]
        env=props.get('EnvironmentFiles','');paths+=re.findall(r'(/[^\s;]+)\s+\(ignore_errors=(?:yes|no)\)',env)
        require(not env or re.fullmatch(r'(?:\s*/[^\s;]+\s+\(ignore_errors=(?:yes|no)\)\s*)+',env),'BASELINE_ENVIRONMENT_PATH_UNRESOLVED')
        # systemctl renders LoadCredential as [unprintable] even when empty. Inspect only directives
        # in the hashed unit/drop-ins internally; never emit inline values or credential bodies.
        credential_sources=[]
        for unitfile in [props['FragmentPath'],*props.get('DropInPaths','').split()]:
            for line in Path(unitfile).read_text().splitlines():
                if re.match(r'^\s*LoadCredential(?:Encrypted)?\s*=',line):
                    value=line.split('=',1)[1].strip()
                    if not value:continue
                    match=re.fullmatch(r'[A-Za-z0-9_.-]+:(/[^\s%]+)',value)
                    require(match is not None,'BASELINE_CREDENTIAL_SOURCE_UNRESOLVED');credential_sources.append(match.group(1))
        paths+=credential_sources
        services[name]['runtimeCredentialDigest']=tree_digest(Path('/run/credentials')/name)
        pid=int(props.get('MainPID','0'))
        if pid:
            exe=Path('/proc/'+str(pid)+'/exe').resolve(strict=True);paths.append(str(exe))
            cmd=Path('/proc/'+str(pid)+'/cmdline').read_bytes();services[name]['commandSha256']=sha(cmd)
            for arg in cmd.split(b'\0'):
                value=arg.decode(errors='strict')
                if value.startswith('-') and '=/' in value:value=value.split('=',1)[1]
                p=Path(value)
                if p.is_absolute() and p.is_file():paths.append(str(p))
        for namepath in paths:
            p=Path(namepath);require(p.is_absolute(),'BASELINE_SERVICE_FILE_UNRESOLVED');files[str(p)]=tree_digest(p)
    require(services['qemu-guest-agent.service']['ActiveState']=='active','BASELINE_QGA_NOT_ACTIVE')
    roots=[Path(p) for p in ['/etc/ssh','/etc/sudoers','/etc/sudoers.d','/etc/systemd/system','/run/systemd/system','/etc/systemd/network','/etc/network','/etc/netplan','/etc/nftables.conf','/etc/qemu','/etc/qemu-ga','/etc/resolv.conf','/etc/hosts','/etc/hostname','/etc/machine-id']]
    roots += [p for parent in ['/opt','/srv','/usr/local/bin','/var/lib'] for p in Path(parent).iterdir()
      if p.name.startswith(('rc02','node-v26'))]
    for a in pwd.getpwall():
        if a.pw_name in CAMPAIGN_ACCOUNTS:continue
        if a.pw_uid==0 or 1000<=a.pw_uid<65534:
            roots += [Path(a.pw_dir)/r for r in ['.ssh','.config/opencode','.local/share/opencode','.codex','.config/codex','.aws','.azure','.kube','.config/gh','.npmrc','.git-credentials']]
    trees={str(p):tree_digest(p) for p in sorted(set(roots)|{Path(p) for p in service_configs})}
    identity={}
    for file in ['/etc/passwd','/etc/group','/etc/shadow','/etc/gshadow']:
        body=Path(file).read_bytes();filtered=b'\n'.join(row for row in body.splitlines() if row.split(b':',1)[0].decode() not in CAMPAIGN_ACCOUNTS)
        identity[file]=sha(filtered)
    network={key:stable_network(json.loads(run(args))) for key,args in {
        'addresses':['ip','-j','address'],'routes4':['ip','-j','route'],'routes6':['ip','-j','-6','route']}.items()}
    return {'services':services,'serviceFileHashes':files,'trees':trees,'identityFileHashes':identity,'network':network,
      'scope':'Running services plus SSH/QGA; exact existing config/runtime/known credential roots. Not exhaustive secret absence or KVM certification.'}
def check_baseline(old,new):
    for key in ['hostname','bootId','units','protectedHashes','executorProtection','oldCampaignInputs']:
        require(old.get(key)==new.get(key),'PROTECTED_BASELINE_DRIFT:'+key)
def resource_gate(role,s):
    require(s['memAvailableKiB']>=(3407872 if role=='executor' else 524288) and s['diskFreeBytes']>=8*1024**3,'RESOURCE_GATE')
    require(all('avg10=0.00' in row for row in Path('/proc/pressure/memory').read_text().splitlines()),'GUEST_MEMORY_PRESSURE')
def run(args,check=True):
    if EVENTS and check:
        return process(EVENTS,'child.'+(CURRENT_STEP or 'entry'),args,30,text=True,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C'}).stdout
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
      'oldCampaignInputs':{'release':old_guest_custody(role),'custodyV2':v2_guest_custody(role)},
      'executorProtection':executor_baseline() if role=='executor' else None,
      'memAvailableKiB':mem['MemAvailable'],'units':units,'protectedHashes':hashes,'diskFreeBytes':os.statvfs('/opt').f_bavail*os.statvfs('/opt').f_frsize}
def old_guest_custody(role):
    if role=='controller':
        require(not OLD_INPUT.exists() and not OLD_INPUT.is_symlink(),'OLD_CONTROLLER_INPUT_UNEXPECTED')
        return {'present':False}
    safe(OLD_INPUT);s=OLD_INPUT.lstat()
    require(stat.S_ISDIR(s.st_mode) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o700,'OLD_EXECUTOR_INPUT_CUSTODY')
    require({p.name for p in OLD_INPUT.iterdir()}==(PUBLIC_NAMES-{'evidence.py'})|{'executor-PRE.json'},'OLD_INPUT_INVENTORY')
    require(file_sha(OLD_INPUT/'DEPLOYMENT-PACKAGE.json')=='35a3cb96e791f0e42d8e658dc54c4a676f6464b1e7ea22fa37ca16eff7c9068d','OLD_INPUT_PACKAGE_SHA')
    require(file_sha(OLD_INPUT/'executor-PRE.json')=='1011773724108ad94dc99939f0afc457fa6ddf471c857ac5e74adc8da9c6491d','OLD_INPUT_PRE_SHA')
    manifest=json.loads((OLD_INPUT/'DEPLOYMENT-PACKAGE.json').read_text())
    for name in (PUBLIC_NAMES-{'evidence.py'})|{'executor-PRE.json'}:
        p=OLD_INPUT/name;s=p.lstat();expected_mode=0o600 if name=='executor-PRE.json' else 0o666
        # Known old0666 inputs are sealed by the root0700 directory, not repaired or reused.
        require(stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==expected_mode,'OLD_INPUT_RETAINED_METADATA')
        if name in manifest['files']:require(file_sha(p)==manifest['files'][name],'OLD_INPUT_RETAINED_SHA')
    return tree_digest(OLD_INPUT,file_limit=1024**3) # Known pinned843MB public archive, not service-config bound.
def v2_guest_custody(role):
    if role=='controller':
        require(not V2_INPUT.exists() and not V2_INPUT.is_symlink(),'V2_CONTROLLER_INPUT_UNEXPECTED')
        return {'present':False}
    safe(V2_INPUT);s=V2_INPUT.lstat()
    require(stat.S_ISDIR(s.st_mode) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o700,'V2_INPUT_CUSTODY')
    names=(PUBLIC_NAMES-{'evidence.py'})|{'executor-PRE.json'}
    require({p.name for p in V2_INPUT.iterdir()}==names,'V2_INPUT_INVENTORY')
    require(file_sha(V2_INPUT/'DEPLOYMENT-PACKAGE.json')=='e14d769a068725eb6d108f625d69915bc4aa12dbcd4940487e3e9aa771639a05','V2_INPUT_PACKAGE_SHA')
    manifest=json.loads((V2_INPUT/'DEPLOYMENT-PACKAGE.json').read_text())
    for name in names:
        p=V2_INPUT/name;s=p.lstat()
        require(stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600,'V2_INPUT_RETAINED_METADATA')
        if name in manifest['files']:require(file_sha(p)==manifest['files'][name],'V2_INPUT_RETAINED_SHA')
    return tree_digest(V2_INPUT,file_limit=1024**3)
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
    if mode=='exec':
        stage('external-fence');require_external_fence()
    stage('identity')
    r=ROLES[role];require(os.geteuid()==0 and socket.gethostname()==r['hostname'],'ROOT_TARGET_IDENTITY')
    stage('package');m=package(pin);receipt=INPUT/(role+'-PRE.json');created=INPUT/(role+'-CREATED.json')
    if mode=='pre':
        raise ValueError('USE_READONLY_PRE_NO_GUEST_PACKAGE_OR_WRITES')
    stage('pre-binding');require(receipt.exists(),'PRE_REQUIRED');pre=json.loads(receipt.read_text());require(pre['packageSha256']==pin,'PRE_PACKAGE_BINDING')
    if mode=='exec':
        stage('replay-gate');require(not created.exists(),'EXEC_REPLAY_REJECTED');stage('snapshot');current=snapshot(role)
        stage('baseline');check_baseline(pre['snapshot'],current);stage('resource');resource_gate(role,current)
        # Durable claim first. A failed install is never automatically replayed or deleted.
        stage('install-claim');write(created,canonical({'packageSha256':pin,'role':role,'targets':{k:str(r[k]) for k in ['root','state','secrets']}}))
        require(isinstance(secretInput,dict),'PRIVATE_PROVISION_INPUT_REQUIRED')
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
        stage('account');run(['useradd','--system','--user-group','--no-create-home','--home-dir','/nonexistent','--shell','/usr/sbin/nologin',r['account']]);a=pwd.getpwnam(r['account'])
        evidence_gid=a.pw_gid
        if role=='executor':
            import grp
            run(['groupadd','--system','ai-qualification-evidence']);evidence_gid=grp.getgrnam('ai-qualification-evidence').gr_gid
        stage('directories');r['state'].mkdir(mode=0o700);os.chown(r['state'],a.pw_uid,evidence_gid);os.chmod(r['state'],0o2750 if role=='executor' else 0o700)
        r['secrets'].mkdir(mode=0o700 if role=='executor' else 0o750);os.chown(r['secrets'],0,0 if role=='executor' else a.pw_gid)
        r['root'].mkdir(mode=0o755)
        stage('runtime');
        if role=='executor':extract(INPUT/'capsule.tar',r['root']/'runtime',m['files']['capsule.tar'])
        extract(INPUT/'host-runtime.tar',r['root']/'host-runtime',m['files']['host-runtime.tar'])
        extract(INPUT/'source.tar',r['root']/'source',m['files']['source.tar'])
        # Plain root-owned dependency files for trusted host CLI; sandbox receives the separately pinned runtime.
        # Node module resolution walks up source -> root; no symlink aliases.
        import shutil
        shutil.copytree(r['root']/'host-runtime/runtime/node_modules',r['root']/'node_modules',copy_function=shutil.copyfile)
        write(r['root']/'source-pins.json',canonical(m['sourcePins']),mode=0o644)
        stage('private-config');keys=['client-public.pem','broker-private.pem','broker-public.pem','tls-private.pem','tls-cert.pem'] if role=='executor' else ['client-private.pem','broker-public.pem','tls-cert.pem','tls-cert.sha256']
        require(set(secretInput)==set(keys),'PRIVATE_PROVISION_SCOPE')
        for name in keys:
            require(isinstance(secretInput[name],str) and len(secretInput[name])<=16384,'PRIVATE_INPUT_LIMIT');write(r['secrets']/name,secretInput[name],gid=0 if role=='executor' else a.pw_gid,mode=0o600 if role=='executor' else 0o640)
        stage('units');
        if role=='executor':
            Path('/var/lib/ai-linux-qualification-broker').mkdir(mode=0o700)
            write(Path('/etc/systemd/system/ai-linux-qualification-executor@.service'),(INPUT/'executor@.service').read_bytes(),mode=0o644)
        unit=(INPUT/r['unitFile']).read_bytes();write(Path('/etc/systemd/system')/r['unit'],unit,mode=0o644)
        stage('daemon-reload');run(['systemctl','daemon-reload'])
        # No enable/onboot: temporary campaign units; controller starts only after executor installation POST.
        return {'phase':'EXEC','result':'INSTALLED_NOT_STARTED','role':role}
    require(created.exists() and json.loads(created.read_text())['packageSha256']==pin,'CREATED_CUSTODY')
    if mode=='post':
        stage('post')
        s=snapshot(role);check_baseline(pre['snapshot'],s);resource_gate(role,s)
        if role=='executor':require(sha(canonical(inventory(r['root']/'runtime')).encode())==m['sourcePins']['runtimeCapsuleSha256'],'DEPLOYED_CAPSULE_SHA')
        require(sha(canonical(inventory(r['root']/'host-runtime')).encode())==m['hostRuntimeInventorySha256'],'DEPLOYED_HOST_RUNTIME_SHA')
        manifest=json.loads((r['root']/'source/SOURCE-MANIFEST.json').read_text());actual=inventory(r['root']/'source');actual=[x for x in actual if x['path']!='SOURCE-MANIFEST.json']
        require(manifest['files']==actual and manifest['sourceCommit']==m['sourcePins']['sourceCommit'] and manifest['sourceArchiveSha256']==m['sourcePins']['sourceArchiveSha256'],'DEPLOYED_SOURCE_SHA')
        require(sha(Path('/etc/systemd/system',r['unit']).read_bytes())==m['files'][r['unitFile']],'UNIT_SHA')
        write(INPUT/(role+'-POST.json'),canonical({'phase':'POST','result':'PASS','snapshot':s,'linux13Suite':'NOT_RUN'}))
        return {'phase':'POST','result':'PASS','role':role,'linux13Suite':'NOT_RUN'}
    if mode=='rollback':
        stage('rollback')
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
        s=snapshot(role);check_baseline(pre['snapshot'],s)
        return {'phase':'ROLLBACK','result':'NEW_UNITS_STOPPED_EVIDENCE_RETAINED','role':role}
    raise ValueError('FIXED_MODE_ONLY')
def management_preconditions(role):
    r=ROLES[role]
    require(not run(['getent','group',r['account']],False).strip(),'ACCOUNT_GROUP_EXISTS')
    caps=dict(line.split(':',1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
    effective=int(caps['CapEff'].strip(),16);required=sum(1<<bit for bit in [0,1,3,4,6,7])
    require(effective&required==required,'QGA_PROVISION_CAPABILITIES_REQUIRED')
    for parent in [Path('/opt'),Path('/var/lib'),Path('/etc/systemd/system'),Path('/etc')]:
        safe(parent);require(not os.statvfs(parent).f_flag&os.ST_RDONLY,'PROVISION_FILESYSTEM_READONLY')
    if role=='executor':
        require(Path('/sys/fs/cgroup/cgroup.controllers').exists(),'CGROUP_V2_REQUIRED');safe(Path('/usr/bin/bwrap'))
        require(Path('/usr/bin/bwrap').is_file() and Path('/usr/bin/openssl').is_file(),'HOST_TOOLS_REQUIRED')
        require(not Path('/var/lib/ai-linux-qualification-broker').exists() and not Path('/etc/systemd/system/ai-linux-qualification-executor@.service').exists(),'NEW_BROKER_TARGETS_ONLY')
        require(not run(['getent','group','ai-qualification-evidence'],False).strip(),'EVIDENCE_GROUP_EXISTS')
def readonly_pre(role,pin):
    r=ROLES[role];require(os.geteuid()==0 and socket.gethostname()==r['hostname'],'ROOT_TARGET_IDENTITY')
    for p in [r['root'],r['state'],r['secrets'],INPUT,Path('/etc/systemd/system',r['unit'])]:require(not p.exists() and not p.is_symlink(),'NEW_TARGETS_ONLY')
    try:pwd.getpwnam(r['account']);raise ValueError('ACCOUNT_EXISTS')
    except KeyError:pass
    management_preconditions(role)
    s=snapshot(role);resource_gate(role,s)
    return {'phase':'PRE','result':'PASS','role':role,'packageSha256':pin,'snapshot':s}
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('mode',choices=['pre','exec','post','rollback']);p.add_argument('role',choices=list(ROLES));p.add_argument('approvedPackageSha256');a=p.parse_args()
    try:
        if a.mode=='exec':
            CURRENT_STEP='external-fence';require_external_fence() # Before journal creation or private stdin reads.
        EVENTS=Journal(INPUT/(a.role+'-'+a.mode+'-events'))
        stage('private-input')
        secret=None
        if a.mode=='exec':
            data=sys.stdin.buffer.read(65537);require(len(data)<=65536,'PRIVATE_INPUT_LIMIT');secret=json.loads(data)
        result=execute(a.mode,a.role,a.approvedPackageSha256,secret)
        if EVENTS and CURRENT_STEP:EVENTS.emit(CURRENT_STEP,'SUCCESS')
        print(json.dumps(result))
    except Exception as error:
        fields=failure(error)
        if EVENTS and not EVENTS.broken:
            try:EVENTS.emit(CURRENT_STEP or 'entry','FAIL',**fields)
            except EvidenceFailure:fields=failure(EvidenceFailure())
        print(json.dumps({'result':'BLOCKED','phase':a.mode,'role':a.role,'automaticReplay':False,'failedStep':CURRENT_STEP or 'entry','failure':fields,'pid':os.getpid(),'parentPid':os.getppid()}));sys.exit(2)
