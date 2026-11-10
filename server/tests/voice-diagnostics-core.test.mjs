import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceDiagnostics} from '../src/voice-diagnostics.mjs';

const alice={kind:'account',accountId:'alice',id:'same-device'};
const bob={kind:'account',accountId:'bob',id:'same-device'};
const start=(d,principal=alice,sessionId='session-a')=>d.observe({principal,sessionId,event:'start',code:'connecting'});

test('trusted account and device pair isolate colliding IDs and exclude owner/legacy observations',()=>{
 const d=createVoiceDiagnostics({now:()=>1000});
 for(const principal of [{kind:'panel',id:'same-device',accountId:'alice'},{kind:'legacy',id:'same-device'},{kind:'account',id:'same-device',accountId:'owner'}])start(d,principal);
 assert.equal(d.read('alice','same-device').observed,false);
 start(d);d.observe({principal:alice,sessionId:'session-a',event:'status',code:'ready',metrics:{inputPackets:3}});
 start(d,bob,'session-b');d.observe({principal:bob,sessionId:'session-b',event:'end',code:'network_error'});
 assert.deepEqual(d.read('alice','same-device').connection,{state:'ready',code:'ready',active:true});
 assert.deepEqual(d.read('bob','same-device').connection,{state:'error',code:'network_error',active:false});
 assert.equal(d.read('alice','another-device').observed,false);
 assert.equal(d.read('owner','same-device').observed,false);
 start(d,{kind:'account',accountId:'a-b',id:'c'},'one');start(d,{kind:'account',accountId:'a',id:'b-c'},'two');
 d.remove('a-b','c');assert.equal(d.read('a','b-c').observed,true);
});

test('only fixed codes and measured safe counters survive projection; raw data never does',()=>{
 const d=createVoiceDiagnostics({now:()=>1000});start(d);
 d.observe({principal:alice,sessionId:'session-a',event:'status',code:'ready',token:'PRIVATE_SENTINEL',text:'PRIVATE_SENTINEL',metrics:{inputPackets:4,outputPackets:0,turnsCompleted:1,secret:'PRIVATE_SENTINEL',inputPcmBytes:-1,outputPcmBytes:Infinity,droppedInputPackets:1.5,playbackRejections:'7'}});
 const value=d.read('alice','same-device');
 assert.deepEqual(value.metrics,{inputPackets:4,outputPackets:0,turnsCompleted:1});
 assert.deepEqual(Object.keys(value).sort(),['connection','events','metrics','observed','retentionSeconds','schemaVersion','source','updatedAt'].sort());
 assert.equal(value.source,'server');assert.equal(value.schemaVersion,'1.0');
 assert.ok(!JSON.stringify(value).includes('PRIVATE_SENTINEL'));assert.ok(!JSON.stringify(value).includes('session-a'));assert.ok(!JSON.stringify(value).includes('alice'));
 d.observe({principal:alice,sessionId:'session-a',event:'status',code:'PRIVATE_SENTINEL'});
 assert.equal(d.read('alice','same-device').connection.code,'ready');
});

test('late old callbacks cannot replace a current session or resurrect a closed one',()=>{
 let at=1000;const d=createVoiceDiagnostics({now:()=>at});start(d);
 at++;start(d,alice,'new-session');
 d.observe({principal:alice,sessionId:'session-a',event:'end',code:'timeout',metrics:{inputPackets:999}});
 assert.equal(d.read('alice','same-device').connection.code,'connecting');
 assert.equal(d.read('alice','same-device').metrics,null);
 d.observe({principal:alice,sessionId:'new-session',event:'status',code:'ready',metrics:{inputPackets:2}});
 d.observe({principal:alice,sessionId:'new-session',event:'end',code:'closed'});
 d.observe({principal:alice,sessionId:'new-session',event:'status',code:'ready',metrics:{inputPackets:999}});
 assert.deepEqual(d.read('alice','same-device').connection,{state:'closed',code:'closed',active:false});
 assert.equal(d.read('alice','same-device').metrics.inputPackets,2);
});

test('state history and records expire without reads extending retention',()=>{
 let at=0;const d=createVoiceDiagnostics({now:()=>at});start(d);
 at=10000;d.observe({principal:alice,sessionId:'session-a',event:'status',code:'ready'});
 at=3599000;d.observe({principal:alice,sessionId:'session-a',event:'status',code:'ready',metrics:{inputPackets:1}});
 at=3601000;assert.deepEqual(d.read('alice','same-device').events.map(e=>e.code),['ready']);
 at=3611000;assert.deepEqual(d.read('alice','same-device').events,[]);assert.equal(d.read('alice','same-device').observed,true);
 at=7199001;assert.deepEqual(d.read('alice','same-device'),{schemaVersion:'1.0',source:'server',retentionSeconds:3600,observed:false,updatedAt:null,connection:null,metrics:null,events:[]});
});

test('a still-live session resumes fresh observations and records closure after retention gaps',()=>{
 let at=0;const d=createVoiceDiagnostics({now:()=>at});start(d);
 d.observe({principal:alice,sessionId:'session-a',event:'status',code:'ready',metrics:{inputPackets:1,turnsCompleted:1}});
 at=3600001;assert.equal(d.read('alice','same-device').observed,false);
 assert.equal(d.observe({principal:alice,sessionId:'session-a',event:'status',code:'ready',metrics:{inputPackets:2}}),true);
 const resumed=d.read('alice','same-device');
 assert.equal(resumed.updatedAt,'1970-01-01T01:00:00.001Z');
 assert.deepEqual(resumed.connection,{state:'ready',code:'ready',active:true});
 assert.deepEqual(resumed.metrics,{inputPackets:2});
 assert.deepEqual(resumed.events,[{at:'1970-01-01T01:00:00.001Z',state:'ready',code:'ready'}]);
 at=7200002;
 assert.equal(d.observe({principal:alice,sessionId:'session-a',event:'end',code:'network_error',metrics:{inputPackets:3}}),true);
 const ended=d.read('alice','same-device');
 assert.deepEqual(ended.connection,{state:'error',code:'network_error',active:false});
 assert.deepEqual(ended.metrics,{inputPackets:3});
 assert.deepEqual(ended.events,[{at:'1970-01-01T02:00:00.002Z',state:'error',code:'network_error'}]);
 at=10800003;assert.equal(d.read('alice','same-device').observed,false);
 for(const event of ['status','end'])assert.equal(d.observe({principal:alice,sessionId:'session-a',event,code:'closed'}),false);
 assert.equal(d.read('alice','same-device').observed,false);
});

test('expired observations do not let a superseded session replace the still-live session',()=>{
 let at=0;const d=createVoiceDiagnostics({now:()=>at});start(d);start(d,alice,'current');
 at=3600001;assert.equal(d.read('alice','same-device').observed,false);
 for(const event of ['status','end'])assert.equal(d.observe({principal:alice,sessionId:'session-a',event,code:'timeout',metrics:{inputPackets:999}}),false);
 assert.equal(d.read('alice','same-device').observed,false);
 assert.equal(d.observe({principal:alice,sessionId:'current',event:'end',code:'closed',metrics:{inputPackets:2}}),true);
 assert.deepEqual(d.read('alice','same-device').connection,{state:'closed',code:'closed',active:false});
 assert.deepEqual(d.read('alice','same-device').metrics,{inputPackets:2});
});

test('repeated traffic does not create state events and history/device caps bound memory',()=>{
 let at=1000;const d=createVoiceDiagnostics({now:()=>at});start(d);
 for(let i=0;i<40;i++){at++;d.observe({principal:alice,sessionId:'session-a',event:'status',code:i%2?'ready':'connecting'});}
 let value=d.read('alice','same-device');assert.equal(value.events.length,32);
 for(let i=0;i<100;i++){at++;d.observe({principal:alice,sessionId:'session-a',event:'status',code:'ready',metrics:{inputPackets:i}});}
 assert.equal(d.read('alice','same-device').events.length,32);
 for(let i=0;i<512;i++){at++;start(d,{kind:'account',accountId:'other',id:'device-'+i},'s-'+i);}
 assert.equal(d.read('alice','same-device').observed,false);
 assert.equal(d.read('other','device-0').observed,true);
 at++;start(d,{kind:'account',accountId:'other',id:'overflow'},'overflow');
 assert.equal(d.read('other','device-0').observed,false);assert.equal(d.read('other','device-1').observed,true);
 at+=3600001;assert.equal(d.read('other','device-1').observed,false);
 assert.equal(d.observe({principal:alice,sessionId:'session-a',event:'status',code:'ready'}),false);
 assert.equal(d.observe({principal:{kind:'account',accountId:'other',id:'device-0'},sessionId:'s-0',event:'status',code:'ready'}),false);
 assert.equal(d.observe({principal:{kind:'account',accountId:'other',id:'device-1'},sessionId:'s-1',event:'status',code:'ready'}),true);
 assert.equal(d.read('other','device-1').observed,true);
});

test('snapshots are independent and removal/close erase data without stale resurrection',()=>{
 let at=1000;const d=createVoiceDiagnostics({now:()=>at});start(d);start(d,bob,'session-b');
 d.observe({principal:alice,sessionId:'session-a',event:'status',code:'ready',metrics:{inputPackets:2}});
 const value=d.read('alice','same-device');value.connection.code='timeout';value.metrics.inputPackets=99;value.events[0].code='network_error';
 assert.equal(d.read('alice','same-device').connection.code,'ready');assert.equal(d.read('alice','same-device').metrics.inputPackets,2);
 d.remove('alice','same-device');d.observe({principal:alice,sessionId:'session-a',event:'status',code:'ready'});
 assert.equal(d.read('alice','same-device').observed,false);assert.equal(d.read('bob','same-device').observed,true);
 at+=3600001;
 for(const event of ['status','end'])assert.equal(d.observe({principal:alice,sessionId:'session-a',event,code:'closed'}),false);
 assert.equal(d.observe({principal:bob,sessionId:'session-b',event:'status',code:'ready'}),true);
 d.close();assert.equal(start(d,bob,'next'),false);
 for(const event of ['status','end'])assert.equal(d.observe({principal:bob,sessionId:'session-b',event,code:'closed'}),false);
 assert.equal(d.read('bob','same-device').observed,false);
});
