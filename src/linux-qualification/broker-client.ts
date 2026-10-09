import fs from "node:fs";
import https from "node:https";
import { createHash, randomBytes } from "node:crypto";
import { signCall, verifyReply } from "./broker-protocol.js";
import { type QualificationRequest } from "./contract.js";

export type BrokerClientConfig={clientPrivatePem:string;brokerPublicPem:string;tlsCertificatePem:string;tlsCertificateSha256:string};
export async function callFixedBroker(operation:"dispatch"|"collect",request:QualificationRequest,config:BrokerClientConfig) {
  if(createHash("sha256").update(config.tlsCertificatePem).digest("hex")!==config.tlsCertificateSha256)throw new Error("BROKER_TLS_PIN");
  const call=signCall(operation,request,randomBytes(32).toString("hex"),Date.now(),config.clientPrivatePem),data=JSON.stringify(call);
  const input=await new Promise<unknown>((resolve,reject)=>{
    const req=https.request({hostname:"192.168.0.54",port:48769,path:"/v1/qualification",method:"POST",minVersion:"TLSv1.3",
      ca:config.tlsCertificatePem,rejectUnauthorized:true,agent:false,headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(data)}},res=>{
      let bytes=0,text="";res.on("data",(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>5*1024*1024){res.destroy();reject(new Error("BROKER_REPLY_LIMIT"));}else text+=chunk.toString("utf8");});
      res.on("end",()=>{try{if(res.statusCode!==200)throw new Error("BROKER_REJECTED_NO_REPLAY");resolve(JSON.parse(text));}catch{reject(new Error("BROKER_REPLY_REJECTED"));}});
      res.on("error",reject);
    });
    req.setTimeout(operation==="dispatch"?920000:10000,()=>req.destroy(new Error("BROKER_OUTCOME_UNKNOWN_NO_REPLAY")));
    req.on("error",reject);req.end(data);
  });
  return {call,reply:verifyReply(input,call,config.brokerPublicPem,Date.now())};
}
export function readClientConfig():BrokerClientConfig {
  const root="/etc/ai-linux-qualification-controller",read=(name:string)=>{
    const p=`${root}/${name}`,s=fs.lstatSync(p),d=fs.lstatSync(root);
    if(!s.isFile()||s.isSymbolicLink()||s.size>16384||s.mode&0o027||s.uid!==0||d.uid!==0||d.mode&0o027||d.isSymbolicLink())throw new Error("BROKER_CLIENT_CUSTODY");
    return fs.readFileSync(p,"utf8");
  };
  return {clientPrivatePem:read("client-private.pem"),brokerPublicPem:read("broker-public.pem"),tlsCertificatePem:read("tls-cert.pem"),
    tlsCertificateSha256:read("tls-cert.sha256").trim()};
}
