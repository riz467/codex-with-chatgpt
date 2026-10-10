import { canonicalJson } from "../task-contract/contract.js";
import { evaluateFixture, roleSchema } from "./fixture.js";

try {
  if (process.argv.length !== 3) throw new Error("FIXED_WORKER_ARGUMENTS");
  const role = roleSchema.parse(process.argv[2]);
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const data = Buffer.from(chunk); bytes += data.length;
    if (bytes > 8192) throw new Error("FIXED_WORKER_INPUT_BOUND");
    chunks.push(data);
  }
  process.stdout.write(canonicalJson(evaluateFixture(role, JSON.parse(Buffer.concat(chunks).toString("utf8")))));
} catch {
  // Never echo untrusted input, exception text, paths, environment or credential data.
  process.stderr.write("FIXED_WORKER_BLOCKED\n"); process.exitCode = 2;
}
