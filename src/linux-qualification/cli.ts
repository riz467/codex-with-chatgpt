import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { QualificationController } from "./controller.js";
import { executeQualification, readHostSourcePins } from "./worker.js";
import {callFixedBroker,readClientConfig} from "./broker-client.js";
import {runQualification} from "./run.js";

// Separate qualification CLI. Does NOT change/start/import Gateway, Dashboard, MCP or production bootstrap.
export async function qualificationMain(argv=process.argv.slice(2)) {
  if(process.platform!=="linux" || process.getuid?.()===0) throw new Error("QUALIFICATION_NONROOT_LINUX_ONLY");
  const [mode,id]=argv;
  if(mode==="executor" && argv.length===1 && os.hostname()==="rc02-executor-117") {
    const pins=readHostSourcePins("/opt/ai-linux-qualification/source-pins.json");
    const buffer=Buffer.alloc(4097);let size=0,n=0;while(size<buffer.length && (n=fs.readSync(0,buffer,size,buffer.length-size,null))>0)size+=n;
    if(size>4096)throw new Error("QUALIFICATION_INPUT_LIMIT");const request=buffer.subarray(0,size).toString("utf8");
    console.log(JSON.stringify(executeQualification(JSON.parse(request),pins)));return;
  }
  if(os.hostname()!=="ai-control-116" || !["run","submit","dispatch","collect","report"].includes(mode) ||
    argv.length!==(["run","submit"].includes(mode)?1:2)) throw new Error("QUALIFICATION_FIXED_CLI_ONLY");
  const pins=readHostSourcePins("/opt/ai-linux-qualification-controller/source-pins.json");
  const config=readClientConfig(),controller=new QualificationController("/var/lib/ai-linux-qualification-controller",pins,Date.now,config.brokerPublicPem);
  let result:unknown;
  if(mode==="run")result=await runQualification(controller,(operation,request)=>callFixedBroker(operation,request,config));
  else if(mode==="submit")result=controller.submit();
  else if(mode==="report")result=controller.report(id);
  else {
    const request=mode==="dispatch"?controller.dispatch(id):controller.status(id).request;
    const envelope=await callFixedBroker(mode==="dispatch"?"dispatch":"collect",request,config);
    result=controller.observeBroker(id,envelope);
  }
  console.log(JSON.stringify(result));
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  void qualificationMain().catch(()=>{console.error("LINUX_QUALIFICATION_BLOCKED");process.exitCode=2;});
}
