import { freeze } from "../task-contract/contract.js";
import { parseRequest } from "./contract.js";
import { sandboxNamespaceArguments } from "../execution-orchestrator/development/sandbox.js";

/** Fixed data-only profile; NO execution API, provisioner, arbitrary commands, network or root fallback.
 * Root-owned capsule, source, namespace live test and cgroup custody are external admission gates.
 */
export function qualificationSandboxPlan(requestInput: unknown) {
  const request = parseRequest(requestInput);
  const root = "/opt/ai-linux-qualification";
  return freeze({ executable: "/usr/bin/bwrap", args: [
    ...sandboxNamespaceArguments, "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv",
    "--ro-bind", `${root}/runtime`, "/", "--ro-bind", `${root}/source`, "/candidate",
    "--ro-bind", `${root}/runtime/runtime/node_modules`, "/candidate/node_modules",
    "--bind", `/var/lib/ai-linux-qualification-executor/${request.taskId}/evidence`, "/evidence",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--chdir", "/candidate",
    "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8",
    "--setenv", "HOME", "/tmp/empty-home", "--setenv", "TMPDIR", "/evidence",
    "--", "/usr/bin/node", "/candidate/scripts/verify-linux-portability-fixture.mjs"],
    env: { LANG: "C.UTF-8" }, timeoutMs: 900_000, maxOutputBytes: 8*1024*1024,
    executorVmid: 117, requestSha256: request.requestSha256,
    sourceArchiveSha256: request.source.sourceArchiveSha256, runtimeCapsuleSha256: request.source.runtimeCapsuleSha256,
    cgroup: { memoryMaxBytes: 3221225472, memorySwapMaxBytes: 0, tasksMax: 128, cpuQuotaPercent: 100 },
    qualificationOnly: true, authority: "NONE", productionDispatch: "CLOSED" });
}
