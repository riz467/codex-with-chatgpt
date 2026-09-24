import fs from "node:fs";
import path from "node:path";

fs.mkdirSync("dist/mcp", { recursive: true });
fs.copyFileSync(path.join("src", "mcp", "invoke-ai-run.ps1"), path.join("dist", "mcp", "invoke-ai-run.ps1"));
