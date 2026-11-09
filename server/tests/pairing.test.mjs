import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPairings} from '../src/pairing.mjs';

test('pairing separates the visible code from the secret and completes exactly once', async()=>{
 let calls=0;
 const p=createPairings({apiBase:'https://kibi.example/server/',issueDevice:async(owner,name)=>{calls++;return {device:{id:`${owner}-device`,name},token:'private-device-token'};}});
 const start=p.start({name:'Моя Киби'});
 assert.match(start.code,/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
 assert.equal(start.intervalSeconds,3);
 assert.equal(p.poll({pairingId:start.pairingId,pollToken:start.pollToken}).status,'pending');
 assert.throws(()=>p.poll({pairingId:start.pairingId,pollToken:start.code}),{code:'pairing_not_found'});
 assert.throws(()=>p.poll({pairingId:start.pairingId,pollToken:'z'.repeat(43)}),{code:'pairing_not_found'});
 const claims=await Promise.allSettled([p.claim('alice',start.code),p.claim('bob',start.code)]);
 assert.equal(claims.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(calls,1);
 assert.ok(!JSON.stringify(claims).includes('private-device-token'));
 const result=p.poll({pairingId:start.pairingId,pollToken:start.pollToken});
 assert.equal(result.status,'paired');assert.equal(result.token,'private-device-token');
 assert.equal(result.apiBase,'https://kibi.example/server/');
 assert.throws(()=>p.poll({pairingId:start.pairingId,pollToken:start.pollToken}),{code:'pairing_not_found'});
});

test('expiry, quota and failed provisioning fail safely',async()=>{
 let now=1000, fail=true;
 const p=createPairings({apiBase:'https://kibi.example/',now:()=>now,ttlMs:100,maxPending:1,issueDevice:async()=>{if(fail)throw new Error('disk');return {device:{id:'one'},token:'secret'};}});
 const a=p.start({name:'Киби'});
 assert.throws(()=>p.start({name:'Ещё'}),{code:'pairing_limit'});
 await assert.rejects(p.claim('alice',a.code));
 assert.equal(p.poll({pairingId:a.pairingId,pollToken:a.pollToken}).status,'pending');
 fail=false;await p.claim('alice',a.code);
 now=1101;
 assert.throws(()=>p.poll({pairingId:a.pairingId,pollToken:a.pollToken}),{code:'pairing_not_found'});
 assert.throws(()=>p.start({name:''}),{code:'invalid_input'});
 assert.ok(p.start({name:'Новая'}));
});
