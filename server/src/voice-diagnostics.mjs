const TTL=3600000,EVENTS=32,RECORDS=512;
const ids=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
export const VOICE_DIAGNOSTIC_CODES=Object.freeze(['idle','connecting','connected','ready','closed','cancelled','configuration_required','unsupported_endpoint','device_protocol_invalid','codec_failed','input_backpressure','output_backpressure','authentication_required','quota_or_rate_limit','provider_error','provider_protocol_invalid','network_error','tls_failed','timeout','gateway_busy','gateway_closed','not_found','listening']);
const codes=new Set(VOICE_DIAGNOSTIC_CODES),pending=new Set(['idle','connecting','connected','listening']),ended=new Set(['closed','cancelled','gateway_closed']);
const metricNames=['inputPackets','inputPcmBytes','droppedInputPackets','outputPackets','outputPcmBytes','turnsCompleted','playbackRejections'];
const empty=()=>({schemaVersion:'1.0',source:'server',retentionSeconds:3600,observed:false,updatedAt:null,connection:null,metrics:null,events:[]});
export function sanitizeVoiceDiagnosticMetrics(input){
 if(!input||typeof input!=='object'||Array.isArray(input))return null;
 const result={};
 for(const key of metricNames)if(Number.isSafeInteger(input[key])&&input[key]>=0)result[key]=input[key];
 return Object.keys(result).length?result:null;
}
function connection(code){
 const state=pending.has(code)?'connecting':code==='ready'?'ready':ended.has(code)?'closed':'error';
 return {state,code,active:state==='connecting'||state==='ready'};
}

/** Memory-only, account-bound observations. It never receives a provider payload. */
export function createVoiceDiagnostics({now=Date.now}={}){
 const records=new Map(),liveSessions=new Map();let closed=false;
 const key=(accountId,deviceId)=>ids(accountId)&&accountId!=='owner'&&ids(deviceId)?JSON.stringify([accountId,deviceId]):null;
 function time(){const value=now();return Number.isSafeInteger(value)&&value>=0&&value<=8640000000000000?value:null;}
 function prune(at){
  for(const [id,row] of records){
   if(at-row.at>=TTL){records.delete(id);continue;}
   row.events=row.events.filter(event=>at-event.ms<TTL);
  }
 }
 return {
  observe(input){
   try{
    const {principal,sessionId,event,code,metrics}=input||{};
    if(closed||principal?.kind!=='account'||!ids(sessionId)||!codes.has(code)||!['start','status','end'].includes(event))return false;
    const id=key(principal.accountId,principal.id),at=time();if(id===null||at===null)return false;
    prune(at);let row=records.get(id);
    if(event!=='start'&&liveSessions.get(id)!==sessionId)return false;
    const next=connection(code);
    if(event==='end'&&next.active)return false;
    // Live identity survives observation expiry, without retaining old counters/events.
    liveSessions.delete(id);
    if(event!=='end'){
     liveSessions.set(id,sessionId);
     while(liveSessions.size>RECORDS)liveSessions.delete(liveSessions.keys().next().value);
    }
    if(event==='start'||!row){
     row={at,connection:null,metrics:null,events:row?.events||[]};
    }
    if(!row.connection||row.connection.code!==code||row.connection.state!==next.state){
     row.events.push({ms:at,at:new Date(at).toISOString(),state:next.state,code});
     if(row.events.length>EVENTS)row.events.splice(0,row.events.length-EVENTS);
    }
    const values=sanitizeVoiceDiagnosticMetrics(metrics);if(values)row.metrics={...(row.metrics||{}),...values};
    row.connection=next;row.at=at;
    records.delete(id);records.set(id,row);
    while(records.size>RECORDS)records.delete(records.keys().next().value);
    return true;
   }catch{return false;}
  },
  read(accountId,deviceId){
   const id=key(accountId,deviceId),at=time();if(closed||id===null||at===null)return empty();
   prune(at);const row=records.get(id);if(!row)return empty();
   return {schemaVersion:'1.0',source:'server',retentionSeconds:3600,observed:true,updatedAt:new Date(row.at).toISOString(),connection:{...row.connection},metrics:row.metrics?{...row.metrics}:null,events:row.events.map(({at,state,code})=>({at,state,code}))};
  },
  remove(accountId,deviceId){const id=key(accountId,deviceId);if(id!==null){records.delete(id);liveSessions.delete(id);}},
  close(){closed=true;records.clear();liveSessions.clear();}
 };
}
