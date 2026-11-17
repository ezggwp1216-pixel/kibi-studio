// Maintainer-only registration of the reviewed immutable public factory cohort.
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {planFreshSdk} from '../sdk/device/fresh-profile.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const digest=b=>createHash('sha256').update(b).digest('hex');
const source=process.argv[2];if(!source)throw Error('explicit_public_source_root_required');
const plan=await planFreshSdk({root:source});
const profile={...plan.profile,files:plan.profile.files.map(file=>file.path==='resources/device-contract.json'?{...file,previousAfter:'648f5a9d701909a2472d82c9250f4c18a9249453dc905024fa69dca8feace54d'}:file)};
const filename=join(root,'sdk/device/overlays/profiles.json');
const profiles=JSON.parse(await readFile(filename,'utf8'));
if(profiles.schemaVersion!==1||!Array.isArray(profiles.profiles))throw Error('invalid_existing_profiles');
const current=profiles.profiles.find(p=>p.id===profile.id);
if(current&&JSON.stringify(current)!==JSON.stringify(profile))throw Error('existing_fresh_profile_differs');
if(!current&&profiles.profiles.length!==7)throw Error('unexpected_existing_profile_count');
for(const file of plan.files){
 if(digest(file.bytes)!==file.afterSha256)throw Error('invalid_fresh_payload');
 await writeFile(join(root,'sdk/device/overlays/files',file.afterSha256+'.txt'),file.bytes);
}
if(!current)profiles.profiles.push(profile);
await writeFile(filename,JSON.stringify(profiles,null,2)+'\n');
console.log(JSON.stringify({ok:true,profile:plan.profile.id,profiles:profiles.profiles.length,publicPaths:plan.files.length,privateProjectsRead:false}));
