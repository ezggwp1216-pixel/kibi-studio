import {mkdtempSync,readFileSync,chmodSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

// Test credentials exist only in an OS temporary directory during generation.
// No supplied keys, production paths, downloads or provider requests are used.
export function createTestTls(){
 const directory=mkdtempSync(join(realpathSync(tmpdir()),'kibi-test-tls-'));
 chmodSync(directory,0o700);
 const keyFile=join(directory,'key.pem'),certFile=join(directory,'cert.pem');
 try{
  const result=spawnSync('/usr/bin/openssl',[
   'req','-x509','-newkey','rsa:2048','-sha256','-nodes','-batch','-days','1',
   '-subj','/CN=localhost',
   '-addext','subjectAltName=DNS:localhost,DNS:kibi-voice.internal,IP:127.0.0.1',
   '-addext','basicConstraints=critical,CA:TRUE',
   '-keyout',keyFile,'-out',certFile
  ],{cwd:directory,env:{PATH:'/usr/bin:/bin'},stdio:'ignore',timeout:15000});
  if(result.error||result.status!==0)throw new Error('test_tls_requires_system_openssl');
  chmodSync(keyFile,0o600);chmodSync(certFile,0o600);
  return {key:readFileSync(keyFile),cert:readFileSync(certFile)};
 }finally{rmSync(directory,{recursive:true,force:true});}
}
