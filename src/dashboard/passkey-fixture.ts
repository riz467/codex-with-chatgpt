// Local, isolated passkey demonstration. Never consumes DONE or a task ledger.
import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { BoundedTasks } from "../mcp/bounded-task.js";

export type FixtureRequest = { kind: "PASSKEY_FIXTURE_ONLY"; request_id: string; target: "isolated-completion-record";
  action: "record-test-completion"; revision: 1; notice: "認証・承認の動作確認用。本番操作なし";
  review: "NOT_PERFORMED"; issued_at: string; expires_at: string };
type Accepted = ReturnType<BoundedTasks["acceptedSnapshot"]>;
export type BoundRequest = Omit<FixtureRequest, "kind" | "revision" | "review"> & Accepted &
  { kind: "ACCEPTED_BOUNDED_TASK_TEST_ONLY"; review: "PASS" };
type Request = FixtureRequest | BoundRequest;
const bindingKeys = ["task_id", "revision", "contract_sha256", "manifest_sha256", "diff_sha256",
  "summary", "review_id", "review_result"] as const;
const digest = (request: Request) => createHash("sha256").update(JSON.stringify(request)).digest("hex");
const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;

export class PasskeyFixture {
  private readonly requestFile: string;
  private readonly completionFile: string;
  private readonly initialHash: string;
  private readonly receiptKey = randomBytes(32); // process-local; a restart never trusts old test receipts
  private mac(value: { kind: "PASSKEY_FIXTURE_COMPLETION_ONLY"; request_id: string; request_sha256: string; result: string;
    approved_at: string; receipt_id: string; binding: Accepted | null }) {
    const { kind, request_id, request_sha256, binding, result, approved_at, receipt_id } = value;
    return createHmac("sha256", this.receiptKey).update(JSON.stringify({ kind, request_id, request_sha256,
      binding, result, approved_at, receipt_id })).digest("hex");
  }
  constructor(readonly root: string, readonly now = Date.now, private readonly accepted?: () => Accepted) {
    fs.mkdirSync(root, { recursive: true });
    this.requestFile = path.join(root, "request.json");
    this.completionFile = path.join(root, "completion.json");
    const hashFile = path.join(root, "request.sha256");
    if (fs.existsSync(this.requestFile)) {
      this.initialHash = fs.readFileSync(hashFile, "utf8");
      if (!/^[a-f0-9]{64}$/.test(this.initialHash)) throw new Error("INVALID_FIXTURE_HASH");
    } else {
      const base: FixtureRequest = { kind: "PASSKEY_FIXTURE_ONLY", request_id: `fixture-${randomUUID()}`,
        target: "isolated-completion-record", action: "record-test-completion", revision: 1,
        notice: "認証・承認の動作確認用。本番操作なし", review: "NOT_PERFORMED",
        issued_at: new Date(now()).toISOString(), expires_at: new Date(now() + 15 * 60_000).toISOString() };
      const request: Request = accepted ? { ...base, ...accepted(), kind: "ACCEPTED_BOUNDED_TASK_TEST_ONLY", review: "PASS" } : base;
      this.initialHash = digest(request);
      fs.writeFileSync(this.requestFile, JSON.stringify(request), { flag: "wx" });
      fs.writeFileSync(hashFile, this.initialHash, { flag: "wx" });
    }
  }
  status() {
    const request = read<Request>(this.requestFile);
    let current = false;
    if (this.accepted && request.kind === "ACCEPTED_BOUNDED_TASK_TEST_ONLY") {
      try {
        const live = this.accepted();
        current = bindingKeys.every(key => request[key] === live[key]) && live.review_result === "PASS";
      } catch { current = false; }
    } else current = !this.accepted && request.kind === "PASSKEY_FIXTURE_ONLY" && request.review === "NOT_PERFORMED";
    const unchanged = current && digest(request) === this.initialHash &&
      request.target === "isolated-completion-record" && request.action === "record-test-completion" &&
      Number.isInteger(request.revision);
    const completed = fs.existsSync(this.completionFile) ? read<{ request_id: string; request_sha256: string; result: string;
      approved_at: string; receipt_id: string; receipt_mac: string; binding: Accepted | null }>(this.completionFile) : null;
    const verified = completed && /^[a-f0-9]{64}$/.test(completed.receipt_mac) &&
      timingSafeEqual(Buffer.from(completed.receipt_mac), Buffer.from(this.mac({ kind: "PASSKEY_FIXTURE_COMPLETION_ONLY",
        request_id: completed.request_id, request_sha256: completed.request_sha256, result: completed.result,
        approved_at: completed.approved_at, receipt_id: completed.receipt_id, binding: completed.binding })));
    return { request, request_sha256: this.initialHash,
      state: verified && unchanged && completed.request_id === request.request_id && completed.request_sha256 === this.initialHash &&
        completed.result === "TEST_COMPLETION_RECORDED" ? "APPROVED_TEST_ONLY" :
        completed ? "INVALID_RECEIPT" : !unchanged ? "CHANGED" : this.now() >= Date.parse(request.expires_at) ? "EXPIRED" : "PENDING",
      completion: verified && unchanged && completed.request_sha256 === this.initialHash ?
        { result: completed.result, approved_at: completed.approved_at, receipt_id: completed.receipt_id, binding: completed.binding } : null };
  }
  eligible(id: string, hash: string) {
    const s = this.status();
    return s.state === "PENDING" && s.request.request_id === id && s.request_sha256 === hash;
  }
  complete(id: string, hash: string) {
    if (!this.eligible(id, hash)) return false;
    const s = this.status();
    const binding = s.request.kind === "ACCEPTED_BOUNDED_TASK_TEST_ONLY" ?
      { task_id: s.request.task_id, revision: s.request.revision, contract_sha256: s.request.contract_sha256,
        manifest_sha256: s.request.manifest_sha256, diff_sha256: s.request.diff_sha256,
        summary: s.request.summary, review_id: s.request.review_id, review_result: s.request.review_result } : null;
    const completion = { kind: "PASSKEY_FIXTURE_COMPLETION_ONLY" as const, request_id: id, request_sha256: hash, binding,
      result: "TEST_COMPLETION_RECORDED", approved_at: new Date(this.now()).toISOString(),
      receipt_id: randomBytes(16).toString("hex") };
    try { fs.writeFileSync(this.completionFile, JSON.stringify({ ...completion, receipt_mac: this.mac(completion) }), { flag: "wx" }); return true; }
    catch { return false; }
  }
}
