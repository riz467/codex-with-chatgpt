import { spawn } from "node:child_process";
if (process.platform !== "linux") throw new Error("LINUX_FIXTURE_REQUIRED");
process.on("SIGTERM", () => {});
if (process.argv[2] === "leaf") {
  process.stdout.write(JSON.stringify({ parent: process.ppid, leaf: process.pid }) + "\n");
} else {
  spawn(process.execPath, [import.meta.filename, "leaf"], { stdio: "inherit" });
}
setInterval(() => {}, 1000);
