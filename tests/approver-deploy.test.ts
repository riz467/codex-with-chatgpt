import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const read = (name: string) => fs.readFileSync(fileURLToPath(new URL(`../deploy/ai-approver/${name}`, import.meta.url)), "utf8");
describe("CT-only deployment template", () => {
  it("pins Node 24 and minimal runtime dependencies", () => {
    const pkg = JSON.parse(read("package.json"));
    const lock = JSON.parse(read("package-lock.json"));
    expect(pkg.engines.node).toBe(">=24");
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@simplewebauthn/server", "express", "zod"]);
    expect(lock.packages[""].dependencies).toEqual(pkg.dependencies);
  });
  it("uses a fixed non-root loopback process and writable CT state only", () => {
    const unit = read("ai-approver.service"), installer = read("install.sh");
    expect(unit).toContain("User=ai-approver");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("ReadWritePaths=/var/lib/ai-approver");
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).toMatch(/ExecStart=\/usr\/bin\/node \/opt\/ai-approver\/runtime\/approver-service\/cli\.js serve/);
    expect(installer).toContain("npm ci --omit=dev --ignore-scripts");
    expect(installer).not.toMatch(/git clone|tailscale funnel|^systemctl enable --now/m);
  });
});
