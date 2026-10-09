import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { canonicalJson } from "../task-contract/contract.js";
import { parseRequest, parseResult, type QualificationRequest } from "./contract.js";

function inspect(unit:string) {
  const r=spawnSync("/usr/bin/systemctl",["show",unit,"-p","Result","-p","ExecMainStatus","-p","User","-p","Group",
    "-p","MemoryMax","-p","MemorySwapMax","-p","TasksMax","-p","NRestarts","-p","NoNewPrivileges","-p","ControlGroup",
    "-p","ActiveState","-p","SubState","-p","CPUQuotaPerSecUSec"],{env:{LANG:"C"},encoding:"utf8",shell:false,timeout:10000,maxBuffer:65536});
  if(r.error||r.status!==0)throw new Error("BROKER_HOST_PROOF_MISSING");
  return Object.fromEntries(r.stdout.trim().split("\n").map(line=>line.split("=")));
}
function emptyCgroup(group:string) {
  if(!/^\/system.slice\/ai-linux-qualification-executor@[a-f0-9]{32}\.service$/.test(group))throw new Error("BROKER_CGROUP_IDENTITY");
  const root="/sys/fs/cgroup"+group;
  const visit=(dir:string)=>{if(fs.readFileSync(path.join(dir,"cgroup.procs"),"utf8").trim())throw new Error("BROKER_CGROUP_NOT_EMPTY");
    for(const entry of fs.readdirSync(dir,{withFileTypes:true}))if(entry.isDirectory())visit(path.join(dir,entry.name));};
  if(fs.existsSync(root))visit(root);
}
export async function systemdQualificationExecutor(input:QualificationRequest):Promise<unknown> {
  const request=parseRequest(input);
  if(process.platform!=="linux"||process.getuid?.()!==0||os.hostname()!=="rc02-executor-117")throw new Error("BROKER_HOST_IDENTITY");
  const suffix=request.taskId.slice("linux-qualification-".length),unit=`ai-linux-qualification-executor@${suffix}.service`;
  const requestDir="/var/lib/ai-linux-qualification-broker/requests";
  fs.mkdirSync(requestDir,{mode:0o700,recursive:true});
  const fd=fs.openSync(`${requestDir}/${suffix}.json`,"wx",0o600);
  try{fs.writeFileSync(fd,canonicalJson(request));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const d=fs.openSync(requestDir,"r");try{fs.fsyncSync(d);}finally{fs.closeSync(d);}
  let group=`/system.slice/${unit}`;
  try {
    await new Promise<void>((resolve,reject)=>{
      const child=spawn("/usr/bin/systemctl",["start",unit],{cwd:"/",env:{LANG:"C"},stdio:"ignore",shell:false});
      const timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error("BROKER_EXECUTION_UNKNOWN"));},Math.max(1,request.deadline-Date.now())+15000);
      child.on("error",()=>{clearTimeout(timer);reject(new Error("BROKER_EXECUTION_UNKNOWN"));});
      child.on("close",code=>{clearTimeout(timer);code===0?resolve():reject(new Error("BROKER_EXECUTION_UNKNOWN"));});
    });
    const p=inspect(unit);group=p.ControlGroup;
    for(const [name,value] of Object.entries({Result:"success",ExecMainStatus:"0",User:"ai-qualification-executor",Group:"ai-qualification-executor",
      MemoryMax:"3221225472",MemorySwapMax:"0",TasksMax:"128",NRestarts:"0",NoNewPrivileges:"yes",ActiveState:"active",SubState:"exited",CPUQuotaPerSecUSec:"1s"}))
      if(p[name]!==value)throw new Error("BROKER_HOST_PROOF_REJECTED");
    emptyCgroup(group);
    const saved=`/var/lib/ai-linux-qualification-executor/${request.taskId}/result.json`,s=fs.lstatSync(saved);
    if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>4*1024*1024||s.mode&0o027||s.gid!==process.getgid?.())throw new Error("BROKER_RESULT_CUSTODY");
    const result=parseResult(JSON.parse(fs.readFileSync(saved,"utf8")),request);
    if(s.uid!==result.uid||s.uid!==fs.statSync("/var/lib/ai-linux-qualification-executor").uid)throw new Error("BROKER_RESULT_UID");
    return result;
  }finally{
    // systemctl client timeout is NOT whole-job cancellation; always terminate the fixed service cgroup.
    const stopped=spawnSync("/usr/bin/systemctl",["stop",unit],{env:{LANG:"C"},stdio:"ignore",shell:false,timeout:20000});
    if(stopped.error||stopped.status!==0||inspect(unit).ActiveState!=="inactive")throw new Error("BROKER_CLEANUP_UNKNOWN_NO_REPLAY");
    emptyCgroup(group);
  }
}
