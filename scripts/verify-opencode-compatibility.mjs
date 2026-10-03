// Explicit host opt-in; normal test/verification profiles never acquire packages.
import { tsImport } from "tsx/esm/api";
if (process.argv.length !== 5 || process.argv[2] !== "--acquire" || process.argv[3] !== "--candidate") {
  console.error("Usage: node scripts/verify-opencode-compatibility.mjs --acquire --candidate <exact-version-or-tag>");
  process.exitCode = 2;
} else {
  try {
    const gate = await tsImport("../src/execution-orchestrator/development/opencode-compatibility.ts", import.meta.url);
    const production = gate.observeCurrentProductionVersion();
    const resolution = await gate.resolveCandidateVersion(process.argv[4]);
    const report = await gate.certifyCandidate(resolution);
    console.log(JSON.stringify({ production, ...report }, null, 2));
    if (report.certificate.result !== "COMPATIBLE") process.exitCode = 1;
  } catch {
    console.error("OPENCODE_COMPATIBILITY_ACQUISITION_OR_HOST_FAILURE");
    process.exitCode = 1;
  }
}
