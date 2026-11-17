// A user-initiated, bounded pairing check. Construction and rendering do no I/O.
export function createXiaozhiActivation({activate,isCurrent,onResult=()=>{},onStatus=()=>{},now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}){
 if(typeof activate!=='function'||typeof isCurrent!=='function')throw new TypeError('Activation callbacks required');
 let session=null,flight=null;
 const retryable=new Set(['xiaozhi_pending','xiaozhi_timeout','request_timeout','xiaozhi_busy']);
 const publicCodes=new Set([...retryable,'xiaozhi_challenge_expired','xiaozhi_not_configured','xiaozhi_untrusted_endpoint','xiaozhi_mqtt_unsupported','xiaozhi_provider_failed','session_changed']);
 const clear=s=>{if(s.retry!==null)clearTimer(s.retry);if(s.deadlineTimer!==null)clearTimer(s.deadlineTimer);s.retry=s.deadlineTimer=null;};
 function finish(s,status,code){if(session!==s)return;session=null;clear(s);s.controller?.abort();onStatus(status,code?{code}:{});}
 function valid(s){if(session!==s)return false;if(!isCurrent()){finish(s,'cancelled');return false;}if(now()>=s.deadline){finish(s,'expired');return false;}return true;}
 function checkNow(){
  const s=session;if(!s||!valid(s))return Promise.resolve();
  if(s.retry!==null){clearTimer(s.retry);s.retry=null;}
  if(flight)return flight;
  if(s.attempts>=30){finish(s,'expired');return Promise.resolve();}
  s.attempts++;s.controller=new AbortController();s.checking=true;onStatus('checking');
  const task=Promise.resolve().then(async()=>{
   if(!valid(s))return;
   try{
    const result=await activate({signal:s.controller.signal,timeout:Math.min(15000,s.deadline-now())});
    if(!valid(s))return;
    const configured=result?.voice?.registration?.configured===true;
    onResult(result);
    if(session!==s)return;
    if(configured){finish(s,'configured');return;}
    if(!valid(s))return;
    const registration=result?.voice?.registration;
    if(registration?.status!=='pending'&&!(registration?.status==='error'&&retryable.has(registration.code))){finish(s,'error','xiaozhi_not_configured');return;}
    onStatus('waiting');
   }catch(error){
    if(!valid(s))return;
    const code=publicCodes.has(error?.code)?error.code:'xiaozhi_provider_failed';
    if(!retryable.has(code)){finish(s,code==='session_changed'?'cancelled':'error',code);return;}
    onStatus('waiting',{code});
   }
  }).finally(()=>{
   flight=null;s.checking=false;s.controller=null;
   if(session&&session!==s){void checkNow();return;}
   if(!valid(s))return;
   if(s.attempts>=30){finish(s,'expired');return;}
   s.retry=setTimer(()=>{s.retry=null;void checkNow();},Math.min(1000,s.deadline-now()));
  });
  flight=task;return task;
 }
 function stop(){if(session)finish(session,'cancelled');}
 return{
  start({expiresAt}={}){
   stop();const deadline=Math.min(now()+300000,typeof expiresAt==='number'?expiresAt:Date.parse(expiresAt));
   if(!Number.isFinite(deadline)||deadline<=now())return;
   const s={deadline,attempts:0,controller:null,checking:false,retry:null,deadlineTimer:null};session=s;
   s.deadlineTimer=setTimer(()=>finish(s,'expired'),deadline-now());void checkNow();
  },
  checkNow,stop,
  snapshot:()=>({active:session!==null,checking:session?.checking===true,attempts:session?.attempts||0}),
 };
}
