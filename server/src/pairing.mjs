import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';

const hash=value=>createHash('sha256').update(value).digest();
const fail=(status,code)=>Object.assign(new Error(code),{status,code});
const equal=(a,b)=>typeof b==='string'&&timingSafeEqual(a,hash(b));
const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Pending claims are deliberately ephemeral: restarting never resurrects a code.
// Only token hashes persist in the target tenant's device store.
export function createPairings({issueDevice,apiBase,now=Date.now,ttlMs=300000,maxPending=64}){
 const entries=new Map();
 const prune=()=>{for(const [id,e] of entries)if(e.expires<=now()&&!e.claiming)entries.delete(id);};
 return {
  start({name}={}){
   if(typeof name!=='string'||!name.trim()||name.length>64)throw fail(400,'invalid_input');
   prune();if(entries.size>=maxPending)throw fail(429,'pairing_limit');
   let code;
   do{code=Array.from(randomBytes(8),n=>alphabet[n&31]).join('');}while([...entries.values()].some(e=>equal(e.codeHash,code)));
   const id=randomUUID(),pollToken=randomBytes(32).toString('base64url'),expires=now()+ttlMs;
   entries.set(id,{name:name.trim(),codeHash:hash(code),pollHash:hash(pollToken),expires,claiming:false,result:null});
   return {pairingId:id,code:`${code.slice(0,4)}-${code.slice(4)}`,pollToken,expiresAt:new Date(expires).toISOString(),intervalSeconds:3};
  },
  async claim(ownerId,input){
   if(typeof input!=='string'||input.length>32)throw fail(400,'pairing_invalid_code');
   const code=input.replace(/[\s-]/g,'').toUpperCase();
   if(!/^[A-HJ-NP-Z2-9]{8}$/.test(code))throw fail(400,'pairing_invalid_code');
   prune();const e=[...entries.values()].find(e=>equal(e.codeHash,code));
   if(!e||e.expires<=now())throw fail(410,'pairing_not_found');
   if(e.claiming||e.result)throw fail(409,'pairing_claimed');
   e.claiming=true;
   try{
    e.result=await issueDevice(ownerId,e.name);
    return {ok:true,device:e.result.device};
   }finally{e.claiming=false;}
  },
  poll({pairingId,pollToken}={}){
   prune();const e=typeof pairingId==='string'&&entries.get(pairingId);
   if(!e||e.expires<=now()||typeof pollToken!=='string'||pollToken.length!==43||!equal(e.pollHash,pollToken))throw fail(410,'pairing_not_found');
   if(!e.result)return {status:'pending',expiresAt:new Date(e.expires).toISOString()};
   entries.delete(pairingId);
   return {status:'paired',...e.result,apiBase};
  },
  clear(){entries.clear();}
 };
}
