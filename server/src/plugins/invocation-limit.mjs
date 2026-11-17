// One admission covers the entire trusted host pipeline, across tenant services.
// Adapters settle only after stopping their work. An uncertain cleanup poisons
// the admission until process restart, while allowing a bounded shutdown.
let active=0;
const keys=new Set();

export function acquirePluginInvocation({key,code='plugin_busy',status=429}={}){
 if(active>=4||(key!==undefined&&keys.has(key)))throw Object.assign(new Error(code),{code,status});
 active++;if(key!==undefined)keys.add(key);
 let released=false,quarantined=false;
 return Object.freeze({
  quarantine(){if(!released)quarantined=true;},
  release(){
   if(released)return;released=true;
   if(quarantined)return;
   active--;if(key!==undefined)keys.delete(key);
  }
 });
}
