import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson } from "../task-contract/contract.js";
import { parseRequest, parseResult, type QualificationRequest, type SourcePins } from "./contract.js";
import { keyId, signReply, verifyCall, type BrokerReply } from "./broker-protocol.js";

export type VerifiedExecutor = (request:QualificationRequest)=>Promise<unknown>;
type Record = {request:QualificationRequest;state:"INTENT"|"VERIFIED"|"STOPPED";result:unknown;reason:string|null};
/** An independently provisioned broker owns this root and keys. The injected executor is trusted host
 * composition, never HTTP input. Production host adapter separately verifies systemd/cgroup evidence.
 * One campaign, one task claim. An interrupted intent permanently fences dispatch; collect never runs code.
 */
export class FixedQualificationBroker {
  constructor(private readonly root:string,private readonly source:SourcePins,private readonly clientPublic:string,
    private readonly brokerPrivate:string,private readonly brokerPublic:string,private readonly execute:VerifiedExecutor,
    private readonly now=Date.now) {if(!path.isAbsolute(root))throw new Error("BROKER_ABSOLUTE_ROOT");}
  private write(file:string,value:unknown,exclusive=false) {
    const bytes=canonicalJson(value),temp=`${file}.${randomUUID()}.tmp`,fd=fs.openSync(temp,"wx",0o600);
    try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    if(exclusive){try{fs.linkSync(temp,file);}finally{fs.unlinkSync(temp);}}else fs.renameSync(temp,file);
    if(process.platform!=="win32"){const d=fs.openSync(path.dirname(file),"r");try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
  }
  private read():Record|null {
    const file=path.join(this.root,"execution.json");
    if(!fs.existsSync(file))return null;
    if(fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size>4*1024*1024)throw new Error("BROKER_STATE_CUSTODY");
    const r=JSON.parse(fs.readFileSync(file,"utf8")) as Record;
    if(canonicalJson(Object.keys(r).sort())!==canonicalJson(["reason","request","result","state"]) ||
      !["INTENT","VERIFIED","STOPPED"].includes(r.state) || canonicalJson(parseRequest(r.request).source)!==canonicalJson(this.source) ||
      (r.state==="INTENT" && (r.result!==null || r.reason!==null)) ||
      (r.state==="STOPPED" && (r.result!==null || typeof r.reason!=="string")))throw new Error("BROKER_STATE_INVALID");
    if(r.state==="VERIFIED"){parseResult(r.result,r.request);if(r.reason!==null)throw new Error("BROKER_STATE_INVALID");}
    return r;
  }
  async handle(input:unknown):Promise<BrokerReply> {
    const now=this.now(),call=verifyCall(input,this.clientPublic,now),request=call.body.request;
    if(canonicalJson(request.source)!==canonicalJson(this.source))throw new Error("BROKER_SOURCE_PINS_REJECTED");
    fs.mkdirSync(this.root,{recursive:true,mode:0o700});
    if(fs.lstatSync(this.root).isSymbolicLink())throw new Error("BROKER_STATE_CUSTODY");
    fs.mkdirSync(path.join(this.root,"nonces"),{recursive:true,mode:0o700});
    if(fs.readdirSync(path.join(this.root,"nonces")).length>=1024)throw new Error("BROKER_NONCE_LIMIT");
    this.write(path.join(this.root,"nonces",call.body.nonce),{issuedAt:call.body.issuedAt},true);
    let r=this.read();
    if(r && r.request.requestSha256!==request.requestSha256)throw new Error("BROKER_CAMPAIGN_SINGLE_TASK_FENCE");
    if(call.body.operation==="dispatch") {
      if(r)throw new Error("BROKER_DISPATCH_REPLAY_REJECTED");
      if(now>=request.deadline || now<request.createdAt)throw new Error("BROKER_DEADLINE_REJECTED");
      // Atomic exclusive publish before invoking anything; any uncertain failure remains claimed.
      r={request,state:"INTENT",result:null,reason:null};this.write(path.join(this.root,"execution.json"),r,true);
      try {
        const result=parseResult(await this.execute(request),request);
        if(result.finishedAt>this.now())throw new Error("BROKER_FUTURE_RESULT");
        r={request,state:"VERIFIED",result,reason:null};
      } catch {r={request,state:"STOPPED",result:null,reason:"EXECUTION_FAILED_OR_UNKNOWN_NO_REPLAY"};}
      this.write(path.join(this.root,"execution.json"),r);
    }
    if(!r)throw new Error("BROKER_NOT_DISPATCHED");
    // A live asynchronous executor may still be running; never turn absence into a redispatch permit.
    const state=r.state==="VERIFIED"?"VERIFIED":r.state==="STOPPED"||this.now()>=request.deadline?"STOPPED":"WAITING";
    return signReply({domain:"LINUX_QUALIFICATION_BROKER_REPLY_V1",requestSha256:request.requestSha256,callNonce:call.body.nonce,
      brokerKeyId:keyId(this.brokerPublic),issuedAt:this.now(),state,result:state==="VERIFIED"?r.result:null,
      reason:state==="STOPPED"?(r.reason??"EXECUTION_OUTCOME_UNKNOWN_NO_REPLAY"):null},this.brokerPrivate);
  }
}
