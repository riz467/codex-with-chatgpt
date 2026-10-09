import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { verifyDelivery,verifyObservation } from "./broker-protocol.js";
import { acquireProcessLock } from "../mcp/bounded-process-lock.js";
import { canonicalJson, parseStrict } from "../task-contract/contract.js";
import { contentHash, parseRequest, parseResult, qualificationId, qualificationProfile, sourcePinsSchema, requestSchema,
  type QualificationRequest, type SourcePins } from "./contract.js";

type Ledger = { version: 1; taskId: string; request: QualificationRequest;
  state: "QUEUED" | "DISPATCH_INTENT" | "WAITING_RESULT" | "REVIEWED" | "STOPPED";
  dispatchCount: 0 | 1; resultSha256: string | null; stopReason: string | null };
const ledgerSchema=z.object({version:z.literal(1),taskId:z.string().regex(qualificationId),request:requestSchema,
  state:z.enum(["QUEUED","DISPATCH_INTENT","WAITING_RESULT","REVIEWED","STOPPED"]),dispatchCount:z.union([z.literal(0),z.literal(1)]),
  resultSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),stopReason:z.literal("EXECUTION_OUTCOME_UNKNOWN_NO_REPLAY").nullable()}).strict();
/** Data-only spool. A separately authorized Linux/PVE broker owns execution and authentic result delivery.
 * Missing inbox is UNKNOWN, never NOT_STARTED; no VM credentials, root command, shell, port or authority API.
 */
export class QualificationController {
  private readonly source: SourcePins;
  constructor(private readonly root: string, source: SourcePins, private readonly now = Date.now, private readonly brokerPublicPem?:string) {
    if (!path.isAbsolute(root)) throw new Error("QUALIFICATION_ABSOLUTE_ROOT_REQUIRED");
    this.source = parseStrict(sourcePinsSchema, source);
    this.safe(root);
    if(process.platform==="linux" && fs.existsSync(root))this.custody(root);
  }
  private custody(file:string) {
    if(process.platform!=="linux")return;const s=fs.lstatSync(file),uid=process.getuid?.();
    if(s.isSymbolicLink() || ![0,uid].includes(s.uid) || s.mode&0o022 || (s.isFile()&&s.nlink!==1))throw new Error("QUALIFICATION_CUSTODY");
    for(let p=path.dirname(file);;p=path.dirname(p)){
      const d=fs.lstatSync(p);if(d.isSymbolicLink()||![0,uid].includes(d.uid)||d.mode&0o022)throw new Error("QUALIFICATION_CUSTODY");
      if(path.dirname(p)===p)break;
    }
  }
  private safe(target: string) {
    for (let p = path.resolve(target); ; p = path.dirname(p)) {
      try { if (fs.lstatSync(p).isSymbolicLink()) throw new Error("QUALIFICATION_PATH_ALIAS"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (path.dirname(p) === p) return;
    }
  }
  private dir(id: string) {
    if (!qualificationId.test(id)) throw new Error("QUALIFICATION_TASK_ID");
    const dir = path.join(this.root, id); this.safe(dir); return dir;
  }
  private read(file: string, max = 65536) {
    this.safe(file);
    this.custody(file);
    if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > max) throw new Error("QUALIFICATION_FILE_LIMIT");
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  }
  private publish(file: string, value: unknown, replace: boolean) {
    this.safe(file);
    const bytes = canonicalJson(value), temp = `${file}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temp, "wx", 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (replace) fs.renameSync(temp, file);
    else {
      try { fs.linkSync(temp, file); } finally { fs.unlinkSync(temp); }
    }
    // Linux directory publication durability. Windows tests do not certify this guarantee.
    if (process.platform !== "win32") { const dir = fs.openSync(path.dirname(file), "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
  }
  private save(ledger: Ledger) { this.publish(path.join(this.dir(ledger.taskId), "task.json"), ledger, true); }
  private lock<T>(id: string, action: () => T): T {
    this.status(id); // Never initialize an unknown task while merely inspecting it.
    const release = acquireProcessLock(path.join(this.dir(id), "controller.lock"));
    if (!release) throw new Error("QUALIFICATION_BUSY");
    try { return action(); } finally { release(); }
  }
  submit() {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.safe(this.root);
    const release = acquireProcessLock(path.join(this.root, "admission.lock"));
    if (!release) throw new Error("QUALIFICATION_BUSY");
    try {
      for (const entry of fs.readdirSync(this.root).filter(name => qualificationId.test(name))) {
        if (this.status(entry).state !== "REVIEWED") throw new Error("QUALIFICATION_SINGLE_JOB_LIMIT");
      }
      const taskId = `linux-qualification-${randomUUID().replaceAll("-", "")}`, createdAt = this.now();
      const body = { domain: "LINUX_OFFLINE_QUALIFICATION_REQUEST_V1" as const, taskId, profile: qualificationProfile,
        executorVmid: 117 as const, source: this.source, createdAt, deadline: createdAt + 900_000 };
      const request = parseRequest({ ...body, requestSha256: contentHash(body) });
      fs.mkdirSync(this.dir(taskId), { mode: 0o700 });
      const ledger: Ledger = { version: 1, taskId, request, state: "QUEUED", dispatchCount: 0, resultSha256: null, stopReason: null };
      this.publish(path.join(this.dir(taskId), "task.json"), ledger, false);
      return this.status(taskId);
    } finally { release(); }
  }
  status(id: string): Ledger {
    const raw = this.read(path.join(this.dir(id), "task.json"));
    const l: Ledger = parseStrict(ledgerSchema,raw);
    if (!l || canonicalJson(Object.keys(l).sort()) !== canonicalJson(["dispatchCount","request","resultSha256","state","stopReason","taskId","version"]) ||
        l.version !== 1 || l.taskId !== id || l.request.taskId !== id || !["QUEUED","DISPATCH_INTENT","WAITING_RESULT","REVIEWED","STOPPED"].includes(l.state) ||
        ![0,1].includes(l.dispatchCount) || canonicalJson(parseRequest(l.request).source) !== canonicalJson(this.source) ||
        (l.state === "QUEUED" && l.dispatchCount !== 0) ||
        (!["QUEUED","STOPPED"].includes(l.state) && l.dispatchCount !== 1) ||
        (l.state==="REVIEWED") !== (l.resultSha256!==null) ||
        (l.state==="STOPPED") !== (l.stopReason!==null)) throw new Error("QUALIFICATION_LEDGER_INVALID");
    if (l.state === "REVIEWED") {
      const outbox=path.join(this.dir(id),"request.json");
      if(!fs.existsSync(outbox)||canonicalJson(this.read(outbox))!==canonicalJson(l.request))throw new Error("QUALIFICATION_OUTBOX_CHANGED");
      const result = parseResult(this.read(path.join(this.dir(id), "result.json"), 4*1024*1024), l.request);
      if (result.resultSha256 !== l.resultSha256) throw new Error("QUALIFICATION_RECEIPT_CHANGED");
      if(!this.brokerPublicPem)throw new Error("QUALIFICATION_BROKER_TRUST_REQUIRED");
      const sealed=verifyDelivery(this.read(path.join(this.dir(id),"broker-envelope.json"),5*1024*1024),l.request,this.brokerPublicPem);
      if(sealed.result.resultSha256!==l.resultSha256)throw new Error("QUALIFICATION_RECEIPT_CHANGED");
    }
    return structuredClone(l);
  }
  /** Exactly one durable dispatch intent; crash recovery republishes only identical data, never executes. */
  dispatch(id: string) {
    return this.lock(id, () => {
      const l = this.status(id);
      if (l.state !== "QUEUED") throw new Error("QUALIFICATION_DISPATCH_REPLAY");
      if (this.now() >= l.request.deadline) throw new Error("QUALIFICATION_EXPIRED");
      l.state = "DISPATCH_INTENT"; l.dispatchCount = 1; this.save(l);
      this.publish(path.join(this.dir(id), "request.json"), l.request, false);
      l.state = "WAITING_RESULT"; this.save(l);
      return structuredClone(l.request);
    });
  }
  /** Only a trusted broker may place broker-result.json. No authority/approval facts are accepted. */
  recover(id: string) {
    return this.lock(id, () => {
      const l = this.status(id);
      if (["REVIEWED","STOPPED"].includes(l.state)) return l;
      if (l.state === "QUEUED") return l;
      const outbox=path.join(this.dir(id),"request.json");
      if(fs.existsSync(outbox) && canonicalJson(this.read(outbox))!==canonicalJson(l.request))throw new Error("QUALIFICATION_OUTBOX_CHANGED");
      const delivered = path.join(this.dir(id), "broker-result.json");
      if (fs.existsSync(delivered)) {
        if(!this.brokerPublicPem)throw new Error("QUALIFICATION_BROKER_TRUST_REQUIRED");
        const sealed=verifyDelivery(this.read(delivered,5*1024*1024),l.request,this.brokerPublicPem,this.now()),result=sealed.result;
        if (result.finishedAt > this.now()) throw new Error("QUALIFICATION_FUTURE_RESULT");
        const saved = path.join(this.dir(id), "result.json");
        if (fs.existsSync(saved)) {
          if (canonicalJson(this.read(saved, 4*1024*1024)) !== canonicalJson(result)) throw new Error("QUALIFICATION_RESULT_CONFLICT");
        } else this.publish(saved, result, false);
        const envelopePath=path.join(this.dir(id),"broker-envelope.json");
        if(fs.existsSync(envelopePath)){
          if(canonicalJson(this.read(envelopePath,5*1024*1024))!==canonicalJson(sealed.envelope))throw new Error("QUALIFICATION_RESULT_CONFLICT");
        }else this.publish(envelopePath,sealed.envelope,false);
        l.resultSha256 = result.resultSha256; l.state = "REVIEWED"; this.save(l);
        return l;
      }
      if (this.now() >= l.request.deadline) {
        l.state = "STOPPED"; l.stopReason = "EXECUTION_OUTCOME_UNKNOWN_NO_REPLAY"; this.save(l); return l;
      }
      const requestFile = path.join(this.dir(id), "request.json");
      if (!fs.existsSync(requestFile)) this.publish(requestFile, l.request, false);
      else if (canonicalJson(this.read(requestFile)) !== canonicalJson(l.request)) throw new Error("QUALIFICATION_OUTBOX_CHANGED");
      l.state = "WAITING_RESULT"; this.save(l); return l;
    });
  }
  acceptBrokerDelivery(id:string,envelope:unknown) {
    const l=this.status(id);if(!this.brokerPublicPem)throw new Error("QUALIFICATION_BROKER_TRUST_REQUIRED");
    verifyDelivery(envelope,l.request,this.brokerPublicPem,this.now());
    if(!["DISPATCH_INTENT","WAITING_RESULT"].includes(l.state))throw new Error("QUALIFICATION_DELIVERY_STATE");
    this.publish(path.join(this.dir(id),"broker-result.json"),envelope,false);
    return this.recover(id);
  }
  observeBroker(id:string,envelope:unknown) {
    const l=this.status(id);if(!this.brokerPublicPem)throw new Error("QUALIFICATION_BROKER_TRUST_REQUIRED");
    const reply=verifyObservation(envelope,l.request,this.brokerPublicPem,this.now());
    if(reply.body.state==="VERIFIED")return this.acceptBrokerDelivery(id,envelope);
    if(reply.body.state==="STOPPED")return this.lock(id,()=>{
      const current=this.status(id);if(current.state==="REVIEWED"||current.state==="STOPPED")return current;
      current.state="STOPPED";current.stopReason="EXECUTION_OUTCOME_UNKNOWN_NO_REPLAY";this.save(current);return current;
    });
    return this.recover(id);
  }
  taskIds(){return fs.existsSync(this.root)?fs.readdirSync(this.root).filter(id=>qualificationId.test(id)).sort():[];}
  report(id: string) {
    const l = this.status(id);
    return { taskId: id, state: l.state, profile: qualificationProfile, result: l.state === "REVIEWED" ? "FIXED_13_SUITE_QUALIFICATION_PASS" : "NOT_PROVED",
      review: l.state === "REVIEWED" ? "STRUCTURAL_REPORT_VALIDATION_ONLY" : "NOT_RUN", resultSha256: l.resultSha256,
      providerQualification: "NOT_RUN", semanticReview: "NOT_RUN", productionDispatch: "CLOSED", authority: "NONE", done: false,
      stopReason: l.stopReason };
  }
}
