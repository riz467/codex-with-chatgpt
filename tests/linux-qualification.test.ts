import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {generateKeyPairSync,randomBytes} from "node:crypto";
import {keyId,signCall,signReply} from "../src/linux-qualification/broker-protocol.js";
import { afterEach, expect, it } from "vitest";
import { QualificationController } from "../src/linux-qualification/controller.js";
import { contentHash, parseRequest, parseResult, qualificationTests, type QualificationRequest } from "../src/linux-qualification/contract.js";
import { qualificationSandboxPlan } from "../src/linux-qualification/plan.js";

// Synthetic protocol evidence ONLY. No Linux/sandbox/provider qualification is claimed by these tests.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, {recursive:true,force:true}); });
const source = { sourceCommit:"a".repeat(40), sourceArchiveSha256:"b".repeat(64), runtimeCapsuleSha256:"c".repeat(64) };
const keys=()=>generateKeyPairSync("ed25519",{publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs8",format:"pem"}});
const clientKeys=keys(),brokerKeys=keys();
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"linux-qualification-test-")); roots.push(root);
  let now=1000;
  const controller = new QualificationController(root,source,()=>now,brokerKeys.publicKey);
  return {root,controller,setTime:(value:number)=>{now=value;},restart:()=>new QualificationController(root,source,()=>now,brokerKeys.publicKey)};
}
function result(request:QualificationRequest) {
  const body = {domain:"LINUX_OFFLINE_QUALIFICATION_RESULT_V1",taskId:request.taskId,requestSha256:request.requestSha256,
    profile:request.profile,source:request.source,executorVmid:117,platform:"linux",uid:65534,node:"v24.16.0",exitCode:0,
    startedAt:request.createdAt,finishedAt:request.createdAt,
    isolation:{kind:"BWRAP_MINIMAL_IMAGE",network:"UNSHARED",hostHome:"NOT_MOUNTED",hostCredentials:"NOT_MOUNTED",
      noNewPrivileges:true,cgroupMemoryMaxBytes:3221225472,cgroupOomKill:0,tasksMax:128,cpuQuotaPercent:100,osProbe:"PASS"},
    reportRoot:"/candidate",report:{success:true,numTotalTests:13,numPassedTests:13,
      testResults:qualificationTests.map(name=>({name:`/candidate/${name}`,status:"passed",assertionResults:[{status:"passed"}]}))}};
  return {...body,resultSha256:contentHash(body)};
}
function seal<T extends {resultSha256:string}>(value:T) {const {resultSha256:_hash,...body}=value;return {...body,resultSha256:contentHash(body)};}
function deliver(root:string,id:string,value:unknown) {
  const request=JSON.parse(fs.readFileSync(path.join(root,id,"task.json"),"utf8")).request;
  const call=signCall("collect",request,randomBytes(32).toString("hex"),1000,clientKeys.privateKey);
  const reply=signReply({domain:"LINUX_QUALIFICATION_BROKER_REPLY_V1",requestSha256:request.requestSha256,callNonce:call.body.nonce,
    brokerKeyId:keyId(brokerKeys.publicKey),issuedAt:1000,state:"VERIFIED",result:value,reason:null},brokerKeys.privateKey);
  fs.writeFileSync(path.join(root,id,"broker-result.json"),JSON.stringify({call,reply}),{flag:"wx"});
}

it("persists submit/dispatch/result/review/report and recovers without dispatching twice",()=>{
  const f=fixture(), started=f.controller.submit(), request=f.controller.dispatch(started.taskId);
  expect(f.restart().recover(started.taskId).state).toBe("WAITING_RESULT");
  expect(()=>f.restart().dispatch(started.taskId)).toThrow("REPLAY");
  deliver(f.root,started.taskId,result(request));
  expect(f.restart().recover(started.taskId).state).toBe("REVIEWED");
  expect(f.restart().recover(started.taskId).dispatchCount).toBe(1);
  expect(f.restart().report(started.taskId)).toMatchObject({result:"FIXED_13_SUITE_QUALIFICATION_PASS",done:false,
    productionDispatch:"CLOSED",authority:"NONE",providerQualification:"NOT_RUN",semanticReview:"NOT_RUN",
    review:"STRUCTURAL_REPORT_VALIDATION_ONLY"});
});
it("bounds admission to a single job and fences uncertain timed-out execution",()=>{
  const f=fixture(), l=f.controller.submit(); f.controller.dispatch(l.taskId);
  expect(()=>f.controller.submit()).toThrow("SINGLE_JOB_LIMIT");
  f.setTime(l.request.deadline);
  expect(f.restart().recover(l.taskId)).toMatchObject({state:"STOPPED",stopReason:"EXECUTION_OUTCOME_UNKNOWN_NO_REPLAY"});
  expect(()=>f.restart().submit()).toThrow("SINGLE_JOB_LIMIT");
  expect(f.restart().report(l.taskId).result).toBe("NOT_PROVED");
});
it("projects persisted dispatch intent only as identical outbox data after interruption",()=>{
  const f=fixture(), l=f.controller.submit();
  const file=path.join(f.root,l.taskId,"task.json");
  fs.writeFileSync(file,JSON.stringify({...l,state:"DISPATCH_INTENT",dispatchCount:1}));
  expect(f.restart().recover(l.taskId).state).toBe("WAITING_RESULT");
  expect(JSON.parse(fs.readFileSync(path.join(f.root,l.taskId,"request.json"),"utf8"))).toEqual(l.request);
  expect(f.restart().recover(l.taskId).dispatchCount).toBe(1);
});
it("does not revive STOPPED unknown work even if a late report appears",()=>{
  const f=fixture(), l=f.controller.submit(), request=f.controller.dispatch(l.taskId);
  f.setTime(request.deadline);f.controller.recover(l.taskId);
  deliver(f.root,l.taskId,result(request));
  expect(f.restart().recover(l.taskId).state).toBe("STOPPED");
});
it("does not mutate filesystem for an unknown task lookup",()=>{
  const f=fixture(),id=`linux-qualification-${"f".repeat(32)}`;
  expect(()=>f.controller.recover(id)).toThrow();
  expect(fs.existsSync(path.join(f.root,id))).toBe(false);
});
it("rejects broker/result tampering and preserves the pending ledger",()=>{
  const f=fixture(),l=f.controller.submit(),request=f.controller.dispatch(l.taskId);
  const value=result(request); value.node="v24.17.0";
  deliver(f.root,l.taskId,seal(value));
  expect(()=>f.restart().recover(l.taskId)).toThrow();
  expect(f.controller.status(l.taskId).state).toBe("WAITING_RESULT");
});
it("rehashes reviewed result bytes on every final report",()=>{
  const f=fixture(),l=f.controller.submit(),request=f.controller.dispatch(l.taskId);
  deliver(f.root,l.taskId,result(request));f.controller.recover(l.taskId);
  const file=path.join(f.root,l.taskId,"result.json");
  const value=JSON.parse(fs.readFileSync(file,"utf8"));value.uid=0;fs.writeFileSync(file,JSON.stringify(value));
  expect(()=>f.restart().report(l.taskId)).toThrow();
});
it("rejects changed outbox, source pins and malformed ledger",()=>{
  const f=fixture(),l=f.controller.submit();f.controller.dispatch(l.taskId);
  fs.writeFileSync(path.join(f.root,l.taskId,"request.json"),"{}");
  expect(()=>f.restart().recover(l.taskId)).toThrow("OUTBOX_CHANGED");
  const other=new QualificationController(f.root,{...source,sourceCommit:"d".repeat(40)});
  expect(()=>other.status(l.taskId)).toThrow("LEDGER_INVALID");
});
it.each(["skipped","pending","todo","failed"])("rejects %s assertions instead of downgrading qualification",status=>{
  const f=fixture(),r=f.controller.submit().request,v=result(r);v.report.testResults[0].assertionResults[0].status=status;
  expect(()=>parseResult(seal(v),r)).toThrow("TEST_FAILURE");
});
it("rejects missing/duplicate/contradictory suites",()=>{
  const f=fixture(),r=f.controller.submit().request;
  const missing=result(r);missing.report.testResults.pop();expect(()=>parseResult(seal(missing),r)).toThrow();
  const duplicate=result(r);duplicate.report.testResults[1]=duplicate.report.testResults[0];expect(()=>parseResult(seal(duplicate),r)).toThrow();
  const count=result(r);count.report.numTotalTests=14;count.report.numPassedTests=14;expect(()=>parseResult(seal(count),r)).toThrow();
});
it("rejects cross-task/source/result hashes and invalid clocks",()=>{
  const f=fixture(),r=f.controller.submit().request;
  const cross=result(r);cross.taskId=`linux-qualification-${"0".repeat(32)}`;expect(()=>parseResult(seal(cross),r)).toThrow();
  const pins=result(r);pins.source={...source,sourceArchiveSha256:"f".repeat(64)};expect(()=>parseResult(seal(pins),r)).toThrow();
  const hash=result(r);hash.resultSha256="0".repeat(64);expect(()=>parseResult(hash,r)).toThrow();
  const late=result(r);late.finishedAt=r.deadline+1;expect(()=>parseResult(seal(late),r)).toThrow();
});
it("rejects root/Windows/network-capable/OOM/not-cgroup evidence",()=>{
  const f=fixture(),r=f.controller.submit().request;
  for(const patch of [{uid:0},{platform:"win32"},{isolation:{...result(r).isolation,network:"HOST"}},
    {isolation:{...result(r).isolation,cgroupOomKill:1}}, {isolation:{...result(r).isolation,osProbe:"NOT_RUN"}}])
    expect(()=>parseResult(seal({...result(r),...patch}),r)).toThrow();
});
it("exposes only the fixed sandbox plan with no caller commands/env/mounts or soft fallback",()=>{
  const f=fixture(),r=f.controller.submit().request,p=qualificationSandboxPlan(r);
  expect(qualificationTests).toHaveLength(13);
  expect(p.args).toContain("--unshare-all");expect(p.args).toContain("--unshare-user");expect(p.args).toContain("--disable-userns");
  expect(p.args.slice(-2)).toEqual(["/usr/bin/node","/candidate/scripts/verify-linux-portability-fixture.mjs"]);
  expect(p).toMatchObject({executorVmid:117,authority:"NONE",productionDispatch:"CLOSED",cgroup:{memoryMaxBytes:3221225472,tasksMax:128,cpuQuotaPercent:100}});
  expect(()=>qualificationSandboxPlan({...r,command:"id"})).toThrow();
  expect(()=>qualificationSandboxPlan({...r,executorVmid:704})).toThrow();
  expect(()=>parseRequest({...r,env:{TOKEN:"fake"}})).toThrow();
});
