import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createFinalizerService } from "./server.js";

/** Isolated bootstrap only. Standalone CLI supports deny-all; a trusted host
 * embedding supplies the fenced provider and live bridge before issuance/use. */
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length !== 1) throw new Error("Expected one host-owned configuration file");
  const service = createFinalizerService(JSON.parse(readFileSync(args[0], "utf8")));
  try { await service.listen(); } catch (error) { await service.close(); throw error; }
  const stop = () => { void service.close().catch(() => { process.exitCode = 1; }); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("CT701 isolated finalizer startup failed"); process.exitCode = 1; });
}
