import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { z } from "zod";
import { canonicalJson, parseStrict } from "../task-contract/contract.js";
import { parseRequest, parseResult, requestSchema, type QualificationRequest } from "./contract.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const keyId = (pem: string) => createHash("sha256").update(createPublicKey(pem).export({type:"spki",format:"der"})).digest("hex");
const timestamp = z.number().int().nonnegative().safe();
const requestBody = z.object({domain:z.literal("LINUX_QUALIFICATION_BROKER_CALL_V1"),operation:z.enum(["dispatch","collect"]),
  request:requestSchema,nonce:z.string().regex(/^[a-f0-9]{64}$/),issuedAt:timestamp,expiresAt:timestamp,clientKeyId:hash}).strict();
const callSchema = z.object({body:requestBody,signature:z.string().regex(/^[A-Za-z0-9+/]{86}==$/)}).strict();
export type BrokerCall = z.infer<typeof callSchema>;
const replyBody = z.object({domain:z.literal("LINUX_QUALIFICATION_BROKER_REPLY_V1"),
  requestSha256:hash,callNonce:z.string().regex(/^[a-f0-9]{64}$/),brokerKeyId:hash,issuedAt:timestamp,
  state:z.enum(["WAITING","STOPPED","VERIFIED"]),result:z.unknown(),reason:z.string().max(100).nullable()}).strict();
const replySchema = z.object({body:replyBody,signature:z.string().regex(/^[A-Za-z0-9+/]{86}==$/)}).strict();
export type BrokerReply = z.infer<typeof replySchema>;
function privateEd(pem:string) {const key=createPrivateKey(pem);if(key.asymmetricKeyType!=="ed25519")throw new Error("BROKER_ED25519_ONLY");return key;}
function publicEd(pem:string) {const key=createPublicKey(pem);if(key.asymmetricKeyType!=="ed25519")throw new Error("BROKER_ED25519_ONLY");return key;}
export function signCall(operation:"dispatch"|"collect",request:QualificationRequest,nonce:string,now:number,privatePem:string):BrokerCall {
  const key=privateEd(privatePem),pub=createPublicKey(key).export({type:"spki",format:"pem"}).toString();
  const body=parseStrict(requestBody,{domain:"LINUX_QUALIFICATION_BROKER_CALL_V1",operation,request:parseRequest(request),nonce,
    issuedAt:now,expiresAt:now+30000,clientKeyId:keyId(pub)});
  return parseStrict(callSchema,{body,signature:sign(null,Buffer.from(canonicalJson(body)),key).toString("base64")});
}
export function verifyCall(input:unknown,clientPublicPem:string,now:number):BrokerCall {
  const call=parseStrict(callSchema,input),{body}=call;
  parseRequest(body.request);
  if(body.clientKeyId!==keyId(clientPublicPem) || body.issuedAt>now+2000 || body.expiresAt<now ||
    body.expiresAt!==body.issuedAt+30000 || !verify(null,Buffer.from(canonicalJson(body)),publicEd(clientPublicPem),Buffer.from(call.signature,"base64")))
    throw new Error("BROKER_AUTHENTICATION_REJECTED");
  return call;
}
export function signReply(body:BrokerReply["body"],privatePem:string):BrokerReply {
  const checked=parseStrict(replyBody,body),key=privateEd(privatePem);
  return parseStrict(replySchema,{body:checked,signature:sign(null,Buffer.from(canonicalJson(checked)),key).toString("base64")});
}
export function verifyReply(input:unknown,call:BrokerCall,brokerPublicPem:string,now:number):BrokerReply {
  const reply=parseStrict(replySchema,input),{body}=reply;
  if(body.brokerKeyId!==keyId(brokerPublicPem) || body.callNonce!==call.body.nonce || body.requestSha256!==call.body.request.requestSha256 ||
    body.issuedAt<call.body.issuedAt-2000 || body.issuedAt>now+2000 || now-body.issuedAt>30000 ||
    !verify(null,Buffer.from(canonicalJson(body)),publicEd(brokerPublicPem),Buffer.from(reply.signature,"base64")))
    throw new Error("BROKER_REPLY_AUTHENTICATION_REJECTED");
  if(body.state==="VERIFIED") {if(body.reason!==null)throw new Error("BROKER_REPLY_INVALID");parseResult(body.result,call.body.request);}
  else if(body.result!==null || (body.state==="WAITING" && body.reason!==null) || (body.state==="STOPPED" && body.reason===null))
    throw new Error("BROKER_REPLY_INVALID");
  return reply;
}
export function verifyDelivery(input:unknown,request:QualificationRequest,brokerPublicPem:string,now?:number) {
  const envelope=parseStrict(z.object({call:callSchema,reply:replySchema}).strict(),input);
  if(canonicalJson(envelope.call.body.request)!==canonicalJson(request))throw new Error("BROKER_DELIVERY_BINDING");
  // Persisted receipts retain signature validity after the transport freshness window expires.
  // Fresh incoming evidence uses actual local time; historical reports use authenticated issuance time.
  const reply=verifyReply(envelope.reply,envelope.call,brokerPublicPem,now??envelope.reply.body.issuedAt);
  if(reply.body.state!=="VERIFIED")throw new Error("BROKER_RESULT_NOT_VERIFIED");
  return {envelope,result:parseResult(reply.body.result,request)};
}
export function verifyObservation(input:unknown,request:QualificationRequest,brokerPublicPem:string,now:number) {
  const envelope=parseStrict(z.object({call:callSchema,reply:replySchema}).strict(),input);
  if(canonicalJson(envelope.call.body.request)!==canonicalJson(request))throw new Error("BROKER_DELIVERY_BINDING");
  return verifyReply(envelope.reply,envelope.call,brokerPublicPem,now);
}
