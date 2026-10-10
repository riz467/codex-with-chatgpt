import { nativeWorkerInputSchema, nativeTransportResultSchema, type NativeTransportResult } from "./native-worker.js";
import { prepareFixedNativeData } from "./native-fixed-data.js";
import { assertAuthenticatedNativeWorkerTurn } from "./native-receipt.js";
import { admitFixedNative, nativeBlocked } from "./native-admission.js";
import { acquireNativeHostOAuthCredential, acquireNativeHostTurnCapability } from "./native-credential.js";
import { runNativeFixedDataTurn } from "../execution-orchestrator/development/opencode-transport.js";

/** Fixed root-pinned production worker module. No injected services, credentials,
 * code, task paths or prompts. CLI DATA is never an in-process capability. */
export async function dispatchFixedNativeRole(input: unknown): Promise<NativeTransportResult> {
  try {
    const i = nativeWorkerInputSchema.parse(input), p = prepareFixedNativeData(i);
    const auth = admitFixedNative(); if (auth.taskId !== i.taskId) throw nativeBlocked();
    assertAuthenticatedNativeWorkerTurn(i.role, p.inputDigest);
    const capability = acquireNativeHostTurnCapability(i.role);
    const credential = await acquireNativeHostOAuthCredential();
    assertAuthenticatedNativeWorkerTurn(i.role, p.inputDigest);
    const result = await runNativeFixedDataTurn(i, credential, capability);
    if (result.result !== "NATIVE_FIXED_DATA_RECEIVED") throw nativeBlocked();
    return nativeTransportResultSchema.parse({ version: 1, role: i.role, sessionId: result.sessionId,
      proposal: result.proposal, review: result.review });
  } catch { throw nativeBlocked(); }
}
