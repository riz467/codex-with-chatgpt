import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { canonicalJson, parseStrict } from "../task-contract/contract.js";
import { sandboxIsolationFixture, sandboxNamespaceArguments } from "../execution-orchestrator/development/sandbox.js";
import { contentHash, parseRequest, parseResult, sourcePinsSchema, type SourcePins } from "./contract.js";
import { qualificationSandboxPlan } from "./plan.js";

const capsule = "/opt/ai-linux-qualification/runtime", source = "/opt/ai-linux-qualification/source";
const state = "/var/lib/ai-linux-qualification-executor";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function require(ok: unknown, reason: string): asserts ok { if (!ok) throw new Error(reason); }
function trusted(file: string) {
  for (let p = file; ; p = path.dirname(p)) {
    const s = fs.lstatSync(p);
    require(!s.isSymbolicLink() && (s.isDirectory() || s.isFile()) && s.uid === 0 && !(s.mode & 0o6022) &&
      (!s.isFile() || s.nlink === 1) && fs.realpathSync.native(p) === p, "QUALIFICATION_UNTRUSTED_IMAGE");
    if (path.dirname(p) === p) break;
  }
}
export function readHostSourcePins(file: string): SourcePins {
  require(process.platform==="linux","QUALIFICATION_LINUX_PINS_ONLY");
  trusted(file);require(fs.statSync(file).size<=4096,"QUALIFICATION_PIN_FILE_LIMIT");
  return parseStrict(sourcePinsSchema,JSON.parse(fs.readFileSync(file,"utf8")));
}
function inventory(root: string) {
  const rows: {path:string;kind:"FILE"|"DIRECTORY";sha256?:string;bytes?:number}[]=[];
  const visit = (dir: string) => {
    trusted(dir);
    for (const name of fs.readdirSync(dir).sort()) {
      require(rows.length < 50000, "QUALIFICATION_IMAGE_LIMIT");
      const file=path.join(dir,name), rel=path.relative(root,file).replaceAll(path.sep,"/");
      trusted(file);
      const s=fs.lstatSync(file);
      if(s.isDirectory()) {rows.push({path:rel,kind:"DIRECTORY"});visit(file);}
      else {require(s.size<=128*1024*1024,"QUALIFICATION_IMAGE_FILE_LIMIT");rows.push({path:rel,kind:"FILE",sha256:sha(fs.readFileSync(file)),bytes:s.size});}
    }
  };
  visit(root);return rows;
}
function cgroup() {
  const lines=fs.readFileSync("/proc/self/cgroup","utf8").trim().split("\n");
  require(lines.length===1 && /^0::\/system.slice\/ai-linux-qualification-executor@[a-f0-9]{32}\.service$/.test(lines[0]), "QUALIFICATION_FIXED_CGROUP_REQUIRED");
  const root="/sys/fs/cgroup"+lines[0].slice(3),read=(name:string)=>fs.readFileSync(path.join(root,name),"utf8").trim();
  require(read("memory.max")==="3221225472" && read("memory.swap.max")==="0" && read("pids.max")==="128", "QUALIFICATION_CGROUP_LIMITS");
  const [quota,period]=read("cpu.max").split(" ").map(Number);
  require(Number.isFinite(quota) && quota===period && quota>0,"QUALIFICATION_CPU_QUOTA");
  const events=Object.fromEntries(read("memory.events").split("\n").map(line=>line.split(" ")));
  require(events.oom_kill==="0","QUALIFICATION_OOM");
  return lines[0].slice(3);
}
function command(executable: string, args: readonly string[], timeout: number, maxBuffer=8*1024*1024) {
  const result=spawnSync(executable,[...args],{cwd:"/",env:{LANG:"C.UTF-8"},stdio:["ignore","pipe","pipe"],
    shell:false,timeout,maxBuffer,killSignal:"SIGKILL"});
  require(!result.error && !result.signal && result.status===0,"QUALIFICATION_EXECUTION_UNKNOWN_NO_REPLAY");
  return result;
}
/** Execute only after separate role/custody/capsule/cgroup approval. Never runnable as root or on VM116.
 * One task-directory claim remains even after failure; no automatic rearm or deletion.
 */
export function executeQualification(requestInput: unknown, hostExpectedInput: SourcePins) {
  require(process.platform==="linux" && os.hostname()==="rc02-executor-117" && process.getuid?.()!==0 &&
    process.getuid?.()===process.geteuid?.(),"QUALIFICATION_UNPRIVILEGED_VM117_ONLY");
  const uid=process.getuid?.(); require(uid!==undefined && uid>0,"QUALIFICATION_UID_REQUIRED");
  require(/^NoNewPrivs:\s+1$/m.test(fs.readFileSync("/proc/self/status","utf8")),"QUALIFICATION_HOST_NO_NEW_PRIVILEGES");
  const request=parseRequest(requestInput),expected=parseStrict(sourcePinsSchema,hostExpectedInput);
  require(canonicalJson(request.source)===canonicalJson(expected),"QUALIFICATION_HOST_PINS");
  const startedAt=Date.now();require(startedAt>=request.createdAt && startedAt<request.deadline,"QUALIFICATION_EXPIRED");
  trusted("/usr/bin/bwrap");cgroup();
  require(cgroup().endsWith(request.taskId.slice("linux-qualification-".length)+".service"),"QUALIFICATION_CGROUP_TASK_BINDING");
  require(fs.readdirSync(capsule).every(name=>["usr","bin","lib","lib64","runtime","candidate","proc","dev","tmp","etc","opt","evidence"].includes(name)),"QUALIFICATION_NONMINIMAL_IMAGE");
  for(const mount of ["candidate","proc","dev","tmp","evidence"]) require(fs.readdirSync(path.join(capsule,mount)).length===0,"QUALIFICATION_DIR_NOT_EMPTY");
  require(fs.readdirSync(path.join(capsule,"etc")).every(name=>["hosts","nsswitch.conf"].includes(name)),"QUALIFICATION_IMAGE_CONFIG");
  const image=inventory(capsule);require(contentHash(image)===expected.runtimeCapsuleSha256,"QUALIFICATION_CAPSULE_SHA");
  const sourceManifest=JSON.parse(fs.readFileSync(path.join(source,"SOURCE-MANIFEST.json"),"utf8"));
  const observed=inventory(source).filter(row=>row.path!=="SOURCE-MANIFEST.json");
  require(sourceManifest.sourceCommit===expected.sourceCommit && sourceManifest.sourceArchiveSha256===expected.sourceArchiveSha256 &&
    canonicalJson(sourceManifest.files)===canonicalJson(observed),"QUALIFICATION_SOURCE_SHA");
  require(!fs.readFileSync("/proc/self/mountinfo","utf8").split("\n").some(line=>{
    const mount=line.split(" ")[4];return mount && [capsule,source].some(root=>mount===root || mount.startsWith(root+"/"));
  }),"QUALIFICATION_MOUNT_ALIAS");
  require(fs.lstatSync(state).uid===uid && (fs.lstatSync(state).mode&0o7777)===0o2750 && !fs.lstatSync(state).isSymbolicLink(),"QUALIFICATION_STATE_CUSTODY");
  const dir=path.join(state,request.taskId);fs.mkdirSync(dir,{mode:0o750});fs.chmodSync(dir,0o2750);
  require(fs.statSync(dir).gid===fs.statSync(state).gid,"QUALIFICATION_EVIDENCE_GROUP");
  const claim=fs.openSync(path.join(dir,"request.json"),"wx",0o600);
  try{fs.writeFileSync(claim,canonicalJson(request));fs.fsyncSync(claim);}finally{fs.closeSync(claim);}
  for(const directory of [dir,state]){const fd=fs.openSync(directory,"r");try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
  const probeDir=path.join(dir,"probe"),evidence=path.join(dir,"evidence");
  fs.mkdirSync(probeDir,{mode:0o700});fs.mkdirSync(evidence,{mode:0o700});
  const namespaces=Object.fromEntries(["mnt","net","pid","user","ipc","uts","cgroup"].map(n=>[n,fs.readlinkSync(`/proc/self/ns/${n}`)]));
  const args=[...sandboxNamespaceArguments,"--die-with-parent","--new-session","--cap-drop","ALL","--clearenv",
    "--ro-bind",capsule,"/","--bind",probeDir,"/candidate","--proc","/proc","--dev","/dev","--chdir","/candidate",
    "--setenv","PATH","/usr/bin","--setenv","LANG","C","--","/usr/bin/node","--no-addons","--no-warnings","-e",sandboxIsolationFixture,
    JSON.stringify({canonical:source,home:os.userInfo().homedir,hostPid:process.pid,namespaces})];
  const probe=command("/usr/bin/bwrap",args,10000,65536);
  require(probe.stdout.toString().trim()==="RC02_ISOLATION_FIXTURE_PASS","QUALIFICATION_OS_PROBE_FAILED");
  const plan=qualificationSandboxPlan(request);
  require(Date.now()<request.deadline,"QUALIFICATION_DEADLINE_AFTER_PREFLIGHT");
  const output=command(plan.executable,plan.args,Math.max(1,request.deadline-Date.now()),plan.maxOutputBytes);
  const summary=JSON.parse(output.stdout.toString());
  require(summary.pass===true && /^\/evidence\/linux-portability-evidence-[A-Za-z0-9]+$/.test(summary.evidence_directory),"QUALIFICATION_INCOMPLETE_REPORT");
  const resultDir=path.join(evidence,path.basename(summary.evidence_directory));
  require(!fs.lstatSync(resultDir).isSymbolicLink(),"QUALIFICATION_EVIDENCE_ALIAS");
  const reportPath=path.join(resultDir,"vitest.json");
  require(fs.lstatSync(reportPath).isFile() && !fs.lstatSync(reportPath).isSymbolicLink() && fs.statSync(reportPath).size<=4*1024*1024,"QUALIFICATION_REPORT_LIMIT");
  const report=JSON.parse(fs.readFileSync(reportPath,"utf8"));
  const receiptPath=path.join(resultDir,"receipt.json"),receiptStat=fs.lstatSync(receiptPath);
  require(receiptStat.isFile()&&!receiptStat.isSymbolicLink()&&receiptStat.nlink===1&&receiptStat.size<=65536,"QUALIFICATION_RECEIPT_LIMIT");
  const receipt=JSON.parse(fs.readFileSync(receiptPath,"utf8"));
  require(receipt.pass===true && receipt.platform==="linux" && receipt.node==="v24.16.0" && receipt.provider_qualification==="NOT_RUN", "QUALIFICATION_RUNNER_RECEIPT");
  cgroup();require(contentHash(inventory(capsule))===expected.runtimeCapsuleSha256 &&
    canonicalJson(inventory(source).filter(row=>row.path!=="SOURCE-MANIFEST.json"))===canonicalJson(observed),"QUALIFICATION_POST_DRIFT");
  const body={domain:"LINUX_OFFLINE_QUALIFICATION_RESULT_V1",taskId:request.taskId,requestSha256:request.requestSha256,profile:request.profile,
    source:request.source,executorVmid:117,platform:"linux",uid,node:"v24.16.0",exitCode:0,startedAt,finishedAt:Date.now(),
    isolation:{kind:"BWRAP_MINIMAL_IMAGE",network:"UNSHARED",hostHome:"NOT_MOUNTED",hostCredentials:"NOT_MOUNTED",noNewPrivileges:true,
      cgroupMemoryMaxBytes:3221225472,cgroupOomKill:0,tasksMax:128,cpuQuotaPercent:100,osProbe:"PASS"},reportRoot:"/candidate",report};
  const result=parseResult({...body,resultSha256:contentHash(body)},request);
  const fd=fs.openSync(path.join(dir,"result.json"),"wx",0o600);
  try {fs.writeFileSync(fd,canonicalJson(result));fs.fchmodSync(fd,0o640);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const directory=fs.openSync(dir,"r");try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
  return result;
}
