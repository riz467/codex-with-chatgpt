# Repository-local verification profiles (V1)

```text
revision loop     -> FAST
review handoff    -> REVIEW
commit checkpoint -> FULL
milestone/release -> ACCEPTANCE (future)
```

## Usage

```sh
pnpm verify:fast
pnpm verify:review
pnpm verify:full
pnpm verify:fast --paths src/mcp/local-gateway.ts tests/local-gateway.test.ts
node scripts/verify-ai-workspace.mjs FAST --paths docs/verification-policy.md
```

With or without `--paths`, the runner unions unstaged, staged and non-ignored untracked
Git paths. Fixed NUL-delimited Git commands disable rename detection so both
old and new names are considered. Deleted paths remain in scope (failure is
safe if a deleted test cannot run). Explicit paths declare a complete immutable
file scope, which may include files not changed yet. Both declared and observed
paths are validated. Any observed dirty path outside that scope fails closed
before tests with `error_code: "EXPLICIT_SCOPE_MISMATCH"`; no caller option can
bypass this check. Policy/escalation uses the union of declared and observed
paths, even in the failure summary, so a narrow declaration cannot hide a
FULL_REQUIRED change. Without explicit scope, policy uses observed paths alone.

Paths must be repository-relative, forward-slash file names. Absolute paths,
traversal, control characters, drive/UNC paths and option-like components are
rejected. Existing symlink ancestors must resolve within the repository.
Paths go into fixed Node/Vitest argv, never shell command strings. Callers
cannot supply commands, mandatory mappings, configuration options or overrides.

## Profiles

- **FAST** runs Vitest's official `related --run` for changed non-documentation,
  non-test paths, then directly runs changed test files and policy-owned
  mandatory focused tests. Both use at most two workers. Documentation-only
  (`docs/**/*.md`, `docs/**/*.txt`, `docs/**/*.rst`, root `README.md` and locale
  variants such as `README.zh-CN.md`) or empty scope can pass without tests.
  Root README locale suffixes are two lowercase language letters, optionally
  followed by a hyphen and two uppercase region letters. No other root is
  automatically documentation-only: `skill/SKILL.md`, runtime prompts/agents
  and text fixtures outside `docs/` follow normal verification. Other changes
  with zero executed tests fail closed (`ZERO_TESTS_FOR_CODE`). A related
  empty selection is tolerated only until the aggregate zero-test guard.
  A source and mandatory selection may overlap and run a test twice.
  No full `pnpm test`, build, clean-room or production integration command runs.
  Mandatory gateway tests include the existing focused MCP integration test;
  this is not a separate production integration verification command.
- **REVIEW** runs FAST, `pnpm typecheck`, and `git diff --check` (unstaged and
  staged). REVIEW is not a commit gate and normally does not run full regression.
- **FULL** explicitly runs `pnpm test --maxWorkers=2`, `pnpm typecheck`, and
  unstaged/staged `git diff --check`. FULL is for a human-approved commit
  checkpoint, not every revision. Existing `pnpm test` semantics are unchanged.

FAST is not a substitute for FULL. Vitest related follows its static import
graph; dynamic/runtime relationships are not completely guaranteed. Repository-
owned mandatory mappings cover local-gateway, autonomous-approval and all
task-contract paths with the existing RC-02 tests. Only repository changes may
update these mappings; caller/model inputs cannot override them.

## Deterministic escalation

FAST/REVIEW become **FULL_REQUIRED** for:

- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json`,
  `vitest.config.ts`;
- `tests/helpers.ts`, `tests/support/**`;
- `scripts/copy-runtime.mjs`, `scripts/pack-*.mjs`,
  `scripts/verify-*-package.mjs`;
- the verification policy, runner and their focused test file.

Test infrastructure/package boundary changes therefore escalate to FULL.
FULL_REQUIRED cannot be downgraded by a model. The runner stops with exit 2
and machine-readable reasons; it does **not** automatically run FULL during
a revision loop. Request FULL explicitly at the approved checkpoint.

## Results and execution

The final stdout line is JSON, including `requested_profile`,
`effective_profile`, `escalation_required`, `escalation_reasons` (code/path),
`changed_paths`, actual `related_tests`, selected `mandatory_tests` and
`direct_tests`, `commands` (executable/argv/status), `result` and `pass`.
Scope diagnostics include `declared_paths` (null without `--paths`),
`observed_git_paths`, and `out_of_scope_paths`. `changed_paths` is the union used
for policy/test selection, including future declared files. Scope mismatch
includes `error_code: "EXPLICIT_SCOPE_MISMATCH"` and always returns FAIL.
Failures include `error`; exit 1 indicates failure, exit 0 PASS. FULL does not
perform related selection, so its `related_tests` is empty. Test output and
progress may precede the final JSON. Commands stop at the first failure.

Execution is synchronous, with a ten-minute per-command deadline. Timeout
means NOT COMPLETED/failure, never deferred success. On Windows only constant
repository-owned pnpm commands use the command interpreter; Git and path-bearing
Vitest commands use direct argv with no shell.

During policy development use the focused policy/runner tests, typecheck and
diff-check, not repeated full regression. Run FULL once when review-ready for
this infrastructure slice. If it fails, fix and run affected focused tests
before deciding whether another FULL is needed.

Milestone clean-clone/package verification belongs to a separate future
**ACCEPTANCE** layer, not FAST/REVIEW/FULL. This V1 does not wire profiles into
BoundedTasks, MCP schemas, OpenCode controllers, production task contracts,
Trust Control Plane behavior, GitHub Actions or remote CI. No tests or coverage
are removed.
