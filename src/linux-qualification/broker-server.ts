import fs from "node:fs";
import os from "node:os";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { FixedQualificationBroker } from "./broker.js";
import { systemdQualificationExecutor } from "./host-executor.js";
import { readHostSourcePins } from "./worker.js";

export function brokerMain() {
  if(process.platform!=="linux" || process.getuid?.()!==0 || os.hostname()!=="rc02-executor-117")throw new Error("BROKER_ROOT_HOST_ONLY");
  const secrets="/etc/ai-linux-qualification-broker";
  const load=(name:string)=>{
    const file=`${secrets}/${name}`,s=fs.lstatSync(file),dir=fs.lstatSync(secrets);
    if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||s.mode&0o077||s.size>16384||dir.uid!==0||dir.mode&0o077||dir.isSymbolicLink())throw new Error("BROKER_KEY_CUSTODY");
    return fs.readFileSync(file,"utf8");
  };
  const pins=readHostSourcePins("/opt/ai-linux-qualification/source-pins.json");
  const broker=new FixedQualificationBroker("/var/lib/ai-linux-qualification-broker",pins,load("client-public.pem"),
    load("broker-private.pem"),load("broker-public.pem"),systemdQualificationExecutor);
  const server=https.createServer({key:load("tls-private.pem"),cert:load("tls-cert.pem"),minVersion:"TLSv1.3"},(req,res)=>{
    if(req.socket.remoteAddress!=="192.168.0.45" || req.method!=="POST" || req.url!=="/v1/qualification" ||
      req.headers["content-type"]!=="application/json"){res.writeHead(403);res.end();return;}
    let bytes=0,body="";
    req.on("data",(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>16384)req.destroy();else body+=chunk.toString("utf8");});
    req.on("end",()=>{
      void (async()=>{try{const reply=await broker.handle(JSON.parse(body));res.writeHead(200,{"Content-Type":"application/json","Cache-Control":"no-store"});res.end(JSON.stringify(reply));}
        catch{res.writeHead(409,{"Content-Type":"application/json"});res.end('{"error":"BROKER_REJECTED_NO_REPLAY"}');}})();
    });
  });
  server.requestTimeout=10000;server.headersTimeout=5000;server.keepAliveTimeout=1000;
  server.maxConnections=4;server.listen(48769,"192.168.0.54");
  return server;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){try{brokerMain();}catch{console.error("BROKER_START_BLOCKED");process.exitCode=2;}}
