import { QualificationController } from "./controller.js";
import { type QualificationRequest } from "./contract.js";
export type BrokerTransport=(operation:"dispatch"|"collect",request:QualificationRequest)=>Promise<unknown>;
/** Fresh run or process-restart recovery. Network errors never trigger dispatch replay. */
export async function runQualification(controller:QualificationController,transport:BrokerTransport,
  now=Date.now,sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))) {
  const ids=controller.taskIds();if(ids.length>1)throw new Error("QUALIFICATION_ONE_SHOT_SINGLE_TASK");
  const id=ids[0]??controller.submit().taskId;
  let l=controller.status(id);
  if(l.state==="QUEUED") {
    const request=controller.dispatch(id);
    try{controller.observeBroker(id,await transport("dispatch",request));}catch{/* Intent persists; collect ONLY. */}
  }
  for(;;){
    l=controller.status(id);
    if(["REVIEWED","STOPPED"].includes(l.state))return controller.report(id);
    if(now()>=l.request.deadline){controller.recover(id);return controller.report(id);}
    try{controller.observeBroker(id,await transport("collect",l.request));}catch{/* Auth/transport errors cannot advance state. */}
    l=controller.status(id);if(["REVIEWED","STOPPED"].includes(l.state))return controller.report(id);
    await sleep(Math.min(2000,Math.max(1,l.request.deadline-now())));
  }
}
