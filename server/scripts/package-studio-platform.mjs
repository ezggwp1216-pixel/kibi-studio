import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';

// Explicit public overlay only. Never enumerate a Studio installation or projects.
const files=[
 'studio/upgrade.mjs','studio/README.md','studio/studio-platform.mjs','studio/studio-account.mjs',
 'studio/studio-account.js','studio/studio-account.css','studio/public-resources.mjs',
 'studio/managed-assets.mjs','studio/leroyd-c309-recipe.json',
 'studio/png-raster.mjs','studio/portable-design-upgrade.mjs','studio/new-project-upgrade.mjs','studio/module-upgrade.mjs','studio/automatic-build-upgrade.mjs',
 'studio/project-readiness.mjs','studio/device-modules.mjs','studio/device-modules.json','studio/device-module-install.mjs',
 'studio/local-install-source.mjs','studio/full-install-upgrade.mjs',
 'studio/fresh-server-upgrade.mjs','studio/fresh-ui-upgrade.mjs','studio/device-variants.mjs',
 'sdk/device/source/kibi_xiaozhi_core.h','sdk/device/source/kibi_xiaozhi_client.h',
 'docs/API.md','docs/VOICE.md','docs/HARDWARE.md','docs/SERVICES.md',
 'docs/LOCAL_STUDIO.md','docs/SDK.md','docs/SDK_UPDATE.md','docs/STUDIO_CONNECTION.md',
];
const release='studio-platform-2026-11-17-complete-r3',archive='kibi-studio-complete-20261117.tar.gz';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const root=new URL('../',import.meta.url),chunks=[],hashes={};
for(const name of files){
 const bytes=await readFile(new URL(name,root)),header=Buffer.alloc(512);
 header.write(name,0,100,'utf8');
 const octal=(offset,length,value)=>header.write(value.toString(8).padStart(length-1,'0')+'\0',offset,length,'ascii');
 octal(100,8,0o644);octal(108,8,0);octal(116,8,0);octal(124,12,bytes.length);octal(136,12,0);
 header.fill(32,148,156);header[156]=48;header.write('ustar\0',257,6,'ascii');header.write('00',263,2,'ascii');
 const checksum=header.reduce((sum,value)=>sum+value,0);header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148,8,'ascii');
 chunks.push(header,bytes,Buffer.alloc((512-bytes.length%512)%512));hashes[name]=sha(bytes);
}
chunks.push(Buffer.alloc(1024));const packed=gzipSync(Buffer.concat(chunks),{level:9});
await writeFile(new URL('studio/'+archive,root),packed);
const metadata={schemaVersion:1,release,archive,bytes:packed.length,sha256:sha(packed),kind:'public-studio-overlay',fullStudio:false,files:hashes};
await writeFile(new URL('studio/release.json',root),JSON.stringify(metadata,null,2)+'\n');
console.log(JSON.stringify({ok:true,release,archive,bytes:packed.length,sha256:metadata.sha256,files:files.length}));
