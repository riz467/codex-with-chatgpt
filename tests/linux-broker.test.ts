import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {generateKeyPairSync,randomBytes} from "node:crypto";
import {afterEach,expect,it,vi} from "vitest";
import {FixedQualificationBroker} from "../src/linux-qualification/broker.js";
import {signCall,verifyCall,verifyReply,verifyDelivery,keyId,signReply} from "../src/linux-qualification/broker-protocol.js";
import {QualificationController} from "../src/linux-qualification/controller.js";
import {runQualification} from "../src/linux-qualification/run.js";
import {contentHash,qualificationTests,type QualificationRequest} from "../src/linux-qualification/contract.js";
import {executeQualification} from "../src/linux-qualification/worker.js";

// Synthetic trusted-host adapter, never live provider/isolation evidence.
const roots:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const p of roots.splice(0))fs.rmSync(p,{recursive:true,force:true});});
const kp=()=>generateKeyPairSync("ed25519",{publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs8",format:"pem"}});
const client=kp(),broker=kp(),stranger=kp(),source={sourceCommit:"a".repeat(40),sourceArchiveSha256:"b".repeat(64),runtimeCapsuleSha256:"c".repeat(64)};
function result(request:QualificationRequest){
  const body={domain:"LINUX_OFFLINE_QUALIFICATION_RESULT_V1",taskId:request.taskId,requestSha256:request.requestSha256,profile:request.profile,
    source:request.source,executorVmid:117,platform:"linux",uid:65534,node:"v24.16.0",exitCode:0,startedAt:1000,finishedAt:1000,
    isolation:{kind:"BWRAP_MINIMAL_IMAGE",network:"UNSHARED",hostHome:"NOT_MOUNTED",hostCredentials:"NOT_MOUNTED",noNewPrivileges:true,
      cgroupMemoryMaxBytes:3221225472,cgroupOomKill:0,tasksMax:128,cpuQuotaPercent:100,osProbe:"PASS"},reportRoot:"/candidate",
    report:{success:true,numTotalTests:13,numPassedTests:13,testResults:qualificationTests.map(name=>({name:"/candidate/"+name,status:"passed",assertionResults:[{status:"passed"}]}))}};
  return {...body,resultSha256:contentHash(body)};
}
function fixture(execute:(r:QualificationRequest)=>Promise<unknown>=async r=>result(r)){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"fixed-broker-test-"));roots.push(root);let now=1000;
  const clock=()=>now,control=new QualificationController(path.join(root,"control"),source,clock,broker.publicKey);
  const make=()=>new FixedQualificationBroker(path.join(root,"broker"),source,client.publicKey,broker.privateKey,broker.publicKey,execute,clock);
  const service=make();return {root,control,service,make,clock,setTime:(n:number)=>{now=n;},call:(op:"dispatch"|"collect",r:QualificationRequest,key=client.privateKey)=>signCall(op,r,randomBytes(32).toString("hex"),clock(),key)};
}
it("integrates persistent control dispatch -> authenticated fixed broker -> structural report",async()=>{
  let count=0;const f=fixture(async r=>{count++;return result(r);});
  const report=await runQualification(f.control,async(op,r)=>{const call=f.call(op,r);return {call,reply:await f.service.handle(call)};},f.clock);
  expect(count).toBe(1);expect(report).toMatchObject({result:"FIXED_13_SUITE_QUALIFICATION_PASS",productionDispatch:"CLOSED",authority:"NONE",done:false});
  const again=await runQualification(f.control,async()=>{throw new Error("MUST_NOT_CALL");},f.clock);expect(again).toEqual(report);
});
it("rejects wrong signing client and edits even if the new request self-hash is valid",async()=>{
  const f=fixture(),r=f.control.submit().request;
  await expect(f.service.handle(f.call("dispatch",r,stranger.privateKey))).rejects.toThrow("AUTHENTICATION");
  const call=f.call("dispatch",r);call.body.operation="collect";
  expect(()=>verifyCall(call,client.publicKey,1000)).toThrow("AUTHENTICATION");
});
it("rejects expired/future/unknown operations, arbitrary env and forbidden VMID",()=>{
  const f=fixture(),r=f.control.submit().request,call=f.call("dispatch",r);
  expect(()=>verifyCall(call,client.publicKey,40000)).toThrow();
  expect(()=>verifyCall(call,client.publicKey,0-3000)).toThrow();
  expect(()=>verifyCall({...call,body:{...call.body,operation:"shell"}},client.publicKey,1000)).toThrow();
  expect(()=>verifyCall({...call,body:{...call.body,env:{PVE_TOKEN:"fake"}}},client.publicKey,1000)).toThrow();
  expect(()=>verifyCall({...call,body:{...call.body,request:{...r,executorVmid:704}}},client.publicKey,1000)).toThrow();
});
it("persists nonce and campaign claim across broker restart; collect never executes",async()=>{
  let calls=0;const f=fixture(async r=>{calls++;return result(r);}),r=f.control.submit().request,call=f.call("dispatch",r);
  const reply=await f.service.handle(call);expect(verifyReply(reply,call,broker.publicKey,1000).body.state).toBe("VERIFIED");
  await expect(f.make().handle(call)).rejects.toThrow();
  await expect(f.make().handle(f.call("dispatch",r))).rejects.toThrow("REPLAY");
  expect((await f.make().handle(f.call("collect",r))).body.state).toBe("VERIFIED");expect(calls).toBe(1);
});
it("executor failures fence all redispatch and deliver only signed STOPPED",async()=>{
  let n=0;const f=fixture(async()=>{n++;throw new Error("fake failure");}),r=f.control.submit().request,call=f.call("dispatch",r);
  const reply=await f.service.handle(call);expect(reply.body).toMatchObject({state:"STOPPED",result:null});
  f.control.dispatch(r.taskId);expect(f.control.observeBroker(r.taskId,{call,reply}).state).toBe("STOPPED");
  await expect(f.make().handle(f.call("dispatch",r))).rejects.toThrow("REPLAY");expect(n).toBe(1);
});
it("invalid host adapter evidence is not signed as VERIFIED",async()=>{
  const f=fixture(async r=>({...result(r),uid:0})),r=f.control.submit().request,reply=await f.service.handle(f.call("dispatch",r));
  expect(reply.body.state).toBe("STOPPED");expect(reply.body.result).toBeNull();
});
it("rejects forged broker signatures, cross nonce and mismatched request bindings",async()=>{
  const f=fixture(),r=f.control.submit().request,call=f.call("dispatch",r),reply=await f.service.handle(call);
  expect(()=>verifyReply(reply,call,stranger.publicKey,1000)).toThrow("AUTHENTICATION");
  expect(()=>verifyReply(reply,f.call("collect",r),broker.publicKey,1000)).toThrow("AUTHENTICATION");
  const changed=structuredClone(reply);changed.body.result={...result(r),uid:0};
  expect(()=>verifyReply(changed,call,broker.publicKey,1000)).toThrow();
});
it("rejects raw self-hashed results and preserves pending control state",()=>{
  const f=fixture(),l=f.control.submit();f.control.dispatch(l.taskId);
  fs.writeFileSync(path.join(f.root,"control",l.taskId,"broker-result.json"),JSON.stringify(result(l.request)));
  expect(()=>f.control.recover(l.taskId)).toThrow();expect(f.control.status(l.taskId).state).toBe("WAITING_RESULT");
});
it("rejects changed outbox even when a valid signed result is available",async()=>{
  const f=fixture(),l=f.control.submit(),request=f.control.dispatch(l.taskId),call=f.call("dispatch",request),reply=await f.service.handle(call);
  fs.writeFileSync(path.join(f.root,"control",l.taskId,"request.json"),"{}");
  fs.writeFileSync(path.join(f.root,"control",l.taskId,"broker-result.json"),JSON.stringify({call,reply}));
  expect(()=>f.control.recover(l.taskId)).toThrow("OUTBOX_CHANGED");
});
it("authenticated persisted receipt remains reportable, but stale arrival is rejected",async()=>{
  const f=fixture(),l=f.control.submit(),r=f.control.dispatch(l.taskId),call=f.call("dispatch",r),reply=await f.service.handle(call);
  f.control.acceptBrokerDelivery(l.taskId,{call,reply});f.setTime(100000);
  expect(f.control.report(l.taskId).result).toBe("FIXED_13_SUITE_QUALIFICATION_PASS");
  expect(()=>verifyDelivery({call,reply},r,broker.publicKey,100000)).toThrow();
});
it("crash intent cannot lead to another execution on restart",async()=>{
  let n=0;const f=fixture(async()=>{n++;return new Promise(()=>{});}),r=f.control.submit().request;
  void f.service.handle(f.call("dispatch",r));await Promise.resolve();
  expect((await f.make().handle(f.call("collect",r))).body.state).toBe("WAITING");
  await expect(f.make().handle(f.call("dispatch",r))).rejects.toThrow("REPLAY");
  f.setTime(r.deadline);expect((await f.make().handle(f.call("collect",r))).body.state).toBe("STOPPED");expect(n).toBe(1);
});
it("transport uncertainty leads to collect only and deadline stop, never dispatch retry",async()=>{
  const f=fixture(),ops:string[]=[];
  const report=await runQualification(f.control,async op=>{ops.push(op);throw new Error("connection unknown");},f.clock,
    async()=>{f.setTime(901000);});
  expect(ops.filter(x=>x==="dispatch")).toHaveLength(1);expect(report.state).toBe("STOPPED");
});
it("worker rejects local Windows use before inspecting or spawning any executable",()=>{
  if(process.platform!=="win32")return;
  expect(()=>executeQualification({},source)).toThrow("VM117_ONLY");
});
it.each(["change","delete"])("rechecks final authenticated outbox on %s",async(action)=>{
  const f=fixture(),l=f.control.submit(),r=f.control.dispatch(l.taskId),call=f.call("dispatch",r),reply=await f.service.handle(call);
  f.control.acceptBrokerDelivery(l.taskId,{call,reply});const outbox=path.join(f.root,"control",l.taskId,"request.json");
  if(action==="delete")fs.unlinkSync(outbox);else fs.writeFileSync(outbox,"{}");
  expect(()=>f.control.report(l.taskId)).toThrow("OUTBOX_CHANGED");
});
