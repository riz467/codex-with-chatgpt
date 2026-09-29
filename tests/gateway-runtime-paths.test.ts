import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (relative: string) => fs.readFileSync(`${root}${relative}`, 'utf8');

describe('AI-Workspace gateway runtime paths', () => {
  it('pins execution to the permanent runtime and keeps review on normal dist', () => {
    const common = read('scripts/ai-workspace-gateway.ps1');
    const supervisor = read('scripts/run-ai-workspace-gateway.mjs');
    const stop = read('scripts/stop-ai-workspace-gateway.ps1');
    const install = read('scripts/install-ai-workspace-gateway.ps1');

    expect(common).toContain(
      '$GatewayExecutionCli = "$GatewayRoot\\.tooling\\ai-workspace-execution-runtime\\dist\\cli\\index.js"',
    );
    expect(common).toContain(
      '$GatewayReviewCli = "$GatewayRoot\\dist\\cli\\index.js"',
    );

    expect(supervisor).toContain(
      "const executionCli = 'C:\\\\work\\\\codex-with-chatgpt\\\\.tooling\\\\ai-workspace-execution-runtime\\\\dist\\\\cli\\\\index.js';",
    );
    expect(supervisor).not.toContain('bounded-review-release-step2');

    expect(stop).toContain('$GatewayExecutionCli');
    expect(stop).toContain('$GatewayReviewCli');
    expect(stop).not.toContain(
      "$cli = 'C:\\\\work\\\\codex-with-chatgpt\\\\dist\\\\cli\\\\index.js'",
    );

    expect(install).toContain('$GatewayExecutionCli');
    expect(install).toContain('$GatewayReviewCli');
  });
});
