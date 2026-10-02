// Repository-owned policy. Callers supply only a profile and file paths.
export const PROFILES = Object.freeze(["FAST", "REVIEW", "FULL"]);
const boundaries = new Set([
  "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json",
  "vitest.config.ts", "tests/helpers.ts", "scripts/copy-runtime.mjs",
  "scripts/verification-policy.mjs", "scripts/verify-ai-workspace.mjs",
  "tests/verification-policy.test.ts",
]);
const mandatoryMapping = Object.freeze([
  ["src/mcp/local-gateway.ts", ["tests/local-gateway.test.ts", "tests/mcp-integration.test.ts"]],
  ["src/mcp/autonomous-approval.ts", ["tests/autonomous-approval.test.ts", "tests/autonomous-mcp-approval.test.ts"]],
  ["src/task-contract/", ["tests/rc02-task-contract.test.ts", "tests/rc02-lifecycle.test.ts", "tests/rc02-research-capability.test.ts"]],
]);

export function validatePaths(paths) {
  if (!Array.isArray(paths)) throw new Error("Paths must be an array");
  return [...new Set(paths.map((path) => {
    if (typeof path !== "string" || !path || /[\\\x00-\x1f\x7f:]/.test(path)
      || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("-"))) {
      throw new Error(`Invalid repo-relative path: ${JSON.stringify(path)}`);
    }
    return path;
  }))].sort();
}

export function isDocsPath(path) {
  return (path.startsWith("docs/") && /\.(md|txt|rst)$/.test(path))
    || /^README(?:\.[a-z]{2}(?:-[A-Z]{2})?)?\.md$/.test(path);
}

export function selectPolicy(profile, paths) {
  if (!PROFILES.includes(profile)) throw new Error(`Unknown profile: ${profile}`);
  const changed_paths = validatePaths(paths);
  const escalation_reasons = changed_paths.filter((path) => boundaries.has(path)
    || path.startsWith("tests/support/")
    || /^scripts\/pack-.*\.mjs$/.test(path)
    || /^scripts\/verify-.*-package\.mjs$/.test(path))
    .map((path) => ({ code: "TEST_OR_PACKAGE_BOUNDARY", path }));
  const escalation_required = profile !== "FULL" && escalation_reasons.length > 0;
  const mandatory_tests = [...new Set(mandatoryMapping.flatMap(([key, tests]) =>
    changed_paths.some((path) => key.endsWith("/") ? path.startsWith(key) : path === key) ? tests : []))].sort();
  return {
    requested_profile: profile,
    effective_profile: escalation_required ? "FULL_REQUIRED" : profile,
    escalation_required, escalation_reasons, changed_paths, mandatory_tests,
    direct_tests: changed_paths.filter((path) => /^tests\/.*\.test\.ts$/.test(path)),
    related_sources: changed_paths.filter((path) => !isDocsPath(path) && !/^tests\/.*\.test\.ts$/.test(path)),
    docs_only: changed_paths.every(isDocsPath),
  };
}

export function requireTestCoverage(policy, testCount) {
  if (!policy.docs_only && testCount === 0) {
    throw new Error("ZERO_TESTS_FOR_CODE: request REVIEW/FULL or add repository-owned focused coverage");
  }
}
