"""Bounded append-only sanitized operation evidence. No argv, messages, secrets or output bodies."""
import errno,json,os,re,stat,time,subprocess,hashlib
from pathlib import Path

class EvidenceFailure(RuntimeError):pass
class OperationFailure(RuntimeError):
    def __init__(self,classification,**fields):
        self.classification=classification;self.fields=fields
        super().__init__('OBSERVED_OPERATION_FAILURE')
def require_external_fence():
    """No trusted external fence verifier exists for the historical root/QGA execution.

    Deliberately no boolean, file, Human-reference or new-lock bypass. Enabling live
    execution requires a separately reviewed implementation backed by technical fencing.
    """
    error=OperationFailure('UNKNOWN',settled=False)
    error.external_fence_unverified=True
    raise error
CLASSES={'SUCCESS','NONZERO_EXIT','SIGNAL','TIMEOUT','DISCONNECTED','UNKNOWN','PERMISSION','VALIDATION','IO','INTERNAL','EVIDENCE_FAILURE'}
KEYS={'pid','parentPid','guestPid','vmid','exitCode','signal','errno','timeoutSeconds','stdoutBytes','stderrBytes','stdoutSha256','stderrSha256','exited','settled','requestId','classification','errorClass'}
def clean(fields):
    if set(fields)-KEYS:raise EvidenceFailure('EVIDENCE_FIELD_SCOPE')
    result={}
    for key,value in fields.items():
        if value is None or isinstance(value,(bool,int)):result[key]=value
        elif key.endswith('Sha256') and isinstance(value,str) and re.fullmatch('[a-f0-9]{64}',value):result[key]=value
        elif key=='classification' and value in CLASSES:result[key]=value
        elif key=='errorClass' and value in ['EvidenceFailure','OperationFailure','TimeoutError','TimeoutExpired','PermissionError','ConnectionError','BrokenPipeError','ConnectionResetError','OSError','ValueError','AssertionError','KeyError','RuntimeError','Exception']:result[key]=value
        else:raise EvidenceFailure('EVIDENCE_VALUE_SCOPE')
    return result
def failure(error):
    if isinstance(error,EvidenceFailure):return {'classification':'EVIDENCE_FAILURE','errorClass':'EvidenceFailure'}
    if isinstance(error,OperationFailure):return clean({'classification':error.classification,'errorClass':'OperationFailure',**error.fields})
    name=type(error).__name__;name=name if name in ['TimeoutError','TimeoutExpired','PermissionError','ConnectionError','BrokenPipeError','ConnectionResetError','OSError','ValueError','AssertionError','KeyError','RuntimeError'] else 'Exception'
    classification='TIMEOUT' if name in ['TimeoutError','TimeoutExpired'] else 'PERMISSION' if isinstance(error,PermissionError) else 'DISCONNECTED' if isinstance(error,ConnectionError) else 'VALIDATION' if isinstance(error,(ValueError,AssertionError)) else 'IO' if isinstance(error,OSError) else 'INTERNAL'
    fields={'classification':classification,'errorClass':name}
    if isinstance(error,OSError) and isinstance(error.errno,int):fields['errno']=error.errno
    return fields
class Journal:
    def __init__(self,directory):
        self.directory=Path(directory);self.sequence=0;self.broken=False;self.first_failure=None
        try:
            if self.directory.parent.is_symlink():raise EvidenceFailure('EVIDENCE_PARENT_LINK')
            self.directory.mkdir(mode=0o700)
            self._custody()
            if os.name=='posix':
                fd=os.open(self.directory.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
                try:os.fsync(fd)
                finally:os.close(fd)
        except Exception as error:raise EvidenceFailure('EVIDENCE_INIT_FAILED') from None
    def _custody(self):
        s=self.directory.lstat()
        if not stat.S_ISDIR(s.st_mode) or self.directory.is_symlink():raise EvidenceFailure('EVIDENCE_DIRECTORY')
        if os.name=='posix' and (s.st_uid!=os.geteuid() or stat.S_IMODE(s.st_mode)!=0o700):raise EvidenceFailure('EVIDENCE_DIRECTORY_MODE')
    def emit(self,step,state,**fields):
        if self.broken:raise EvidenceFailure('EVIDENCE_ALREADY_FAILED')
        if not re.fullmatch('[a-z][a-z0-9_.-]{0,95}',step) or state not in ['BEGIN','SUCCESS','FAIL','UNKNOWN','STATUS']:raise EvidenceFailure('EVIDENCE_EVENT_SCOPE')
        data={'schema':1,'sequence':self.sequence,'timeNs':time.time_ns(),'monotonicNs':time.monotonic_ns(),'pid':os.getpid(),'parentPid':os.getppid(),'step':step,'state':state,'fields':clean(fields)}
        try:
            self._custody();self.sequence+=1
            if self.sequence>10000:raise EvidenceFailure('EVIDENCE_EVENT_LIMIT')
            payload=json.dumps(data,sort_keys=True,separators=(',',':')).encode();assert len(payload)<=8192
            fd=os.open(self.directory/(str(self.sequence).zfill(6)+'.json'),os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
            try:
                with os.fdopen(os.dup(fd),'wb') as f:f.write(payload);f.flush();os.fsync(fd)
            finally:os.close(fd)
            if os.name=='posix':
                fd=os.open(self.directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
                try:os.fsync(fd)
                finally:os.close(fd)
        except Exception:self.broken=True;raise EvidenceFailure('EVIDENCE_SAVE_FAILED') from None
        if state in ['FAIL','UNKNOWN'] and self.first_failure is None:self.first_failure=data
        return data
    def run(self,step,action):
        self.emit(step,'BEGIN')
        try:result=action()
        except EvidenceFailure:raise
        except Exception as error:
            fields=failure(error);self.emit(step,'UNKNOWN' if fields['classification']=='UNKNOWN' else 'FAIL',**fields);raise
        self.emit(step,'SUCCESS');return result

UNSETTLED_CHILDREN=[]
def process(journal,step,args,timeout,input=None,**kwargs):
    journal.emit(step,'BEGIN')
    child=None
    try:
        child=subprocess.Popen(args,stdin=subprocess.PIPE if input is not None else None,stdout=subprocess.PIPE,stderr=subprocess.PIPE,**kwargs)
        journal.emit(step,'STATUS',pid=child.pid,parentPid=os.getpid(),settled=False)
        try:stdout,stderr=child.communicate(input=input,timeout=timeout)
        except subprocess.TimeoutExpired:
            UNSETTLED_CHILDREN.append(child) # No kill/replay; child termination remains unproven.
            raise OperationFailure('TIMEOUT',pid=child.pid,timeoutSeconds=timeout,settled=False) from None
        fields={'pid':child.pid,'exitCode':child.returncode if child.returncode>=0 else None,'signal':-child.returncode if child.returncode<0 else None,'settled':True}
        for name,value in [('stdout',stdout),('stderr',stderr)]:
            data=value.encode() if isinstance(value,str) else value
            fields[name+'Bytes']=len(data);fields[name+'Sha256']=hashlib.sha256(data).hexdigest()
        journal.emit(step,'STATUS',**fields)
        if child.returncode:
            error=OperationFailure('SIGNAL' if child.returncode<0 else 'NONZERO_EXIT',**fields)
            error.completed=subprocess.CompletedProcess(args,child.returncode,stdout,stderr)
            raise error
        journal.emit(step,'SUCCESS');return subprocess.CompletedProcess(args,child.returncode,stdout,stderr)
    except EvidenceFailure:
        if child and child.poll() is None:UNSETTLED_CHILDREN.append(child)
        raise
    except Exception as error:journal.emit(step,'FAIL',**failure(error));raise
