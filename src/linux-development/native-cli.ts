import { fileURLToPath } from "node:url";
import { nativePublicReceiptSchema, readNativeReceipt, runAuthenticatedFixedNative } from "./native-receipt.js";

/** Fixed grammar only. No path/command/task/model/prompt/credential/enable overrides. */
export function parseNativeCli(args: readonly string[]): "run" | "status" | "readreceipt" {
  if (args.length !== 1 || !["run", "status", "readreceipt"].includes(args[0])) throw new Error("FIXED_NATIVE_ARGUMENTS");
  return args[0] as "run" | "status" | "readreceipt";
}
export async function nativeCli(args: readonly string[]) {
  const mode = parseNativeCli(args);
  return nativePublicReceiptSchema.parse(mode === "run" ? await runAuthenticatedFixedNative() : readNativeReceipt());
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void nativeCli(process.argv.slice(2)).then(r => { process.stdout.write(`${JSON.stringify(r)}\n`);
    if (r.result === "UNKNOWN_NO_REPLAY") process.exitCode = 2;
  }).catch(() => { process.stdout.write(`${JSON.stringify({ result: "BLOCKED_OR_UNKNOWN_NO_REPLAY", replay: false,
    authority: "NONE", productionDispatch: "CLOSED" })}\n`); process.exitCode = 2; });
}
