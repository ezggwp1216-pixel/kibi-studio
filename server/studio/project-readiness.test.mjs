import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeProjectReadiness} from './project-readiness.mjs';

const report=(status='passed',extra={})=>({status,provider:null,checks:[],checkedAt:'2026-11-12T00:00:00.000Z',sourceHash:'a'.repeat(64),configurationRevision:3,...extra});
const implementation=(extra={})=>({sourcePassed:true,implementationRequested:true,approved:true,currentImage:true,configuration:{wifiConfigured:true,apiConfigured:true,revision:3},requirements:{wifi:true,api:true},diagnostics:report(),targetPassed:true,...extra});
const codes=result=>result.blockers.map(blocker=>blocker.code);

test('native design checks pass independently of private settings, service diagnostics and target compilation',()=>{
 const result=summarizeProjectReadiness(implementation({implementationRequested:false,approved:false,configuration:{wifiConfigured:false,apiConfigured:false,revision:3},diagnostics:report('failed'),targetPassed:false}));
 assert.equal(result.phase,'design');assert.equal(result.passed,true);
 assert.deepEqual(result.stages,{native:'passed',preview:'passed',design:'pending',implementation:'pending',settings:'pending',target:'pending'});
 assert.deepEqual(result.blockers,[]);assert.equal(result.service.status,'pending');
 const deferred=result.pending.map(reason=>reason.code);
 for(const code of ['design_approval_required','implementation_request_required','wifi_not_configured','api_not_configured','target_check_required'])assert.ok(deferred.includes(code),code);
 assert.deepEqual(result.evidence,{physical:'unknown',provider:'unknown'});
});

test('a complete current implementation describes software evidence without claiming physical or provider success',()=>{
 const result=summarizeProjectReadiness(implementation());
 assert.equal(result.phase,'implementation');assert.equal(result.passed,true);
 assert.deepEqual(result.stages,{native:'passed',preview:'passed',design:'passed',implementation:'passed',settings:'passed',target:'passed'});
 assert.deepEqual(result.blockers,[]);assert.deepEqual(result.pending,[]);
 assert.equal(result.service.status,'passed');assert.equal(result.configurationRevision,3);
 assert.deepEqual(result.evidence,{physical:'unknown',provider:'unknown'});
});

test('implementation reports named Wi-Fi and API blockers while preserving passed native checks',()=>{
 const result=summarizeProjectReadiness(implementation({configuration:{wifiConfigured:false,apiConfigured:false,revision:3}}));
 assert.equal(result.passed,false);assert.equal(result.stages.native,'passed');assert.equal(result.stages.preview,'passed');assert.equal(result.stages.settings,'blocked');
 assert.deepEqual(codes(result),['wifi_not_configured','api_not_configured']);
 for(const blocker of result.blockers){assert.equal(blocker.stage,'settings');assert.match(blocker.message,/Wi-Fi|API/);}
});

test('offline applications do not require Wi-Fi or API values',()=>{
 const result=summarizeProjectReadiness(implementation({requirements:{wifi:false,api:false},configuration:{wifiConfigured:false,apiConfigured:false,revision:3},diagnostics:report('not_required')}));
 assert.equal(result.passed,true);assert.equal(result.stages.settings,'passed');assert.equal(result.service.status,'not_required');assert.deepEqual(result.blockers,[]);
});

test('native, preview, approval and target failures remain separately identifiable',()=>{
 const result=summarizeProjectReadiness(implementation({sourcePassed:false,currentImage:false,approved:false,targetPassed:false}));
 assert.equal(result.passed,false);
 assert.deepEqual(codes(result),['native_check_failed','preview_required','design_approval_required','target_check_failed']);
 for(const stage of ['native','preview','design','target'])assert.equal(result.stages[stage],'blocked');
 assert.equal(result.stages.implementation,'passed');
});

test('an absent target check is pending and blocks only the implementation phase',()=>{
 const result=summarizeProjectReadiness(implementation({targetPassed:null}));
 assert.equal(result.passed,false);assert.equal(result.stages.target,'pending');assert.deepEqual(codes(result),['target_check_required']);
 const design=summarizeProjectReadiness(implementation({implementationRequested:false,targetPassed:null}));
 assert.equal(design.passed,true);assert.deepEqual(design.blockers,[]);assert.equal(design.stages.design,'passed');assert.equal(design.stages.implementation,'pending');
});

test('failed service checks yield a fixed explanation without returning diagnostic text or provider data',()=>{
 const secret='PRIVATE_CONFIGURATION_DO_NOT_ECHO';
 const result=summarizeProjectReadiness(implementation({diagnostics:report('failed',{provider:secret,checks:[{id:'local',status:'failed',code:'local_diagnostic_unavailable',message:secret}],sourceHash:secret,checkedAt:secret})}));
 assert.equal(result.passed,false);assert.equal(result.service.status,'failed');assert.deepEqual(codes(result),['service_check_failed']);
 assert.match(result.blockers[0].message,/сервис/i);assert.equal(JSON.stringify(result).includes(secret),false);
});

test('unsupported service checks stay unsupported rather than becoming passed or blocking target compilation',()=>{
 const result=summarizeProjectReadiness(implementation({diagnostics:report('unsupported',{checks:[{id:'local',status:'failed',code:'local_diagnostic_unavailable',message:'not implemented'}]})}));
 assert.equal(result.passed,true);assert.equal(result.service.status,'unsupported');assert.deepEqual(result.blockers,[]);
 assert.deepEqual(result.evidence,{physical:'unknown',provider:'unknown'});
});

test('an invalid service contract blocks even a contradictory passed or unsupported report',()=>{
 for(const status of ['passed','unsupported']){
  const result=summarizeProjectReadiness(implementation({diagnostics:report(status,{checks:[{id:'contract',status:'failed',code:'invalid_service_contract',message:'PRIVATE'}]})}));
  assert.equal(result.service.status,'failed');assert.equal(result.passed,false);assert.deepEqual(codes(result),['service_check_failed']);
 }
});

test('missing, malformed and stale service evidence remains unknown with a named blocker',()=>{
 for(const diagnostics of [null,{},report('anything'),report('passed',{checks:null}),report('passed',{configurationRevision:2})]){
  const result=summarizeProjectReadiness(implementation({diagnostics}));
  assert.equal(result.passed,false);assert.equal(result.service.status,'unknown');assert.deepEqual(codes(result),['service_check_failed']);
 }
});

test('truthy strings never authorize readiness or satisfy required private settings',()=>{
 const result=summarizeProjectReadiness(implementation({sourcePassed:'yes',currentImage:'yes',approved:'yes',configuration:{wifiConfigured:'yes',apiConfigured:1,revision:'PRIVATE'},targetPassed:'yes'}));
 assert.equal(result.passed,false);assert.equal(result.stages.native,'unknown');assert.equal(result.stages.preview,'unknown');assert.equal(result.configurationRevision,null);
 for(const code of ['native_check_failed','preview_required','design_approval_required','wifi_not_configured','api_not_configured','target_check_required'])assert.ok(codes(result).includes(code),code);
 assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
});

test('unsupported requirements do not silently disable configuration checks in implementation',()=>{
 const result=summarizeProjectReadiness(implementation({requirements:{wifi:'yes',api:false}}));
 assert.equal(result.passed,false);assert.equal(result.stages.settings,'unknown');assert.ok(codes(result).includes('service_check_failed'));
});

test('readiness is a pure projection and never retains mutable input objects',()=>{
 const input=implementation(),snapshot=structuredClone(input);const result=summarizeProjectReadiness(input);
 assert.deepEqual(input,snapshot);input.configuration.revision=99;input.diagnostics.status='failed';assert.equal(result.configurationRevision,3);assert.equal(result.service.status,'passed');
});
