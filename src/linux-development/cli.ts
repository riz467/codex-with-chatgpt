import { assertNonprivilegedLinux, providerReadiness, readFixedFixture, runFixedFixture } from "./runner.js";

try {
  const [mode, root, commit, ...extra] = process.argv.slice(2);
  if (mode === "provider-readiness" && !root) console.log(JSON.stringify(providerReadiness()));
  else if (mode === "status" && root && !commit) console.log(JSON.stringify(readFixedFixture(root)));
  else if (mode === "fixture" && root && commit && (extra.length === 0 || extra.length === 1 && extra[0] === "--offline-windows-test")) {
    if (!(process.platform === "win32" && extra[0] === "--offline-windows-test")) assertNonprivilegedLinux();
    console.log(JSON.stringify(await runFixedFixture(root, commit)));
  } else throw new Error("FIXED_CLI_ARGUMENTS");
} catch {
  console.log(JSON.stringify({ result: "BLOCKED_OR_UNKNOWN_NO_REPLAY", productionDispatch: "CLOSED", authority: "NONE" }));
  process.exitCode = 2;
}
