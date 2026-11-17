const messages=Object.freeze({
 native_check_failed:'Нативная проверка приложения не пройдена или ещё не завершена.',
 preview_required:'Откройте актуальный нативный экран и проверьте макет.',
 design_approval_required:'Утвердите актуальный макет приложения.',
 implementation_request_required:'Нажмите «Проект готов», чтобы подготовить код приложения.',
 wifi_not_configured:'Добавьте Wi-Fi в настройках проекта.',
 api_not_configured:'Добавьте API-ключ в настройках проекта.',
 service_check_failed:'Проверка сервиса не пройдена или устарела. Откройте диагностику сервиса.',
 target_check_required:'Проверка сборки под Киби ещё не выполнена.',
 target_check_failed:'Проверка сборки под Киби завершилась ошибкой.',
});
const record=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const revision=value=>Number.isSafeInteger(value) && value>=0 ? value : null;
const reason=(stage,code)=>({stage,code,message:messages[code]});
const proofStatus=value=>value===true ? 'passed' : value===false ? 'blocked' : 'unknown';
const serviceStatuses=new Set(['passed','not_required','unsupported','failed']);

// Only read fixed public status fields. Provider names, messages, timestamps,
// source text, logs, credentials and arbitrary check codes never leave this file.
function serviceStatus(diagnostics,configurationRevision){
 if(!record(diagnostics) || !Array.isArray(diagnostics.checks) || diagnostics.checks.length>64)return 'unknown';
 if(diagnostics.checks.some(check=>record(check) && check.code==='invalid_service_contract'))return 'failed';
 if(!serviceStatuses.has(diagnostics.status))return 'unknown';
 if(configurationRevision===null || revision(diagnostics.configurationRevision)!==configurationRevision)return 'unknown';
 if(diagnostics.checks.some(check=>!record(check) || !serviceStatuses.has(check.status)))return 'unknown';
 if(diagnostics.status==='passed' && diagnostics.checks.some(check=>check.status==='failed'))return 'failed';
 return diagnostics.status;
}

/** Pure software-readiness projection; performs no transport or provider calls.
 * The host supplies booleans for current source/preview/approval/target evidence
 * and must already reject a diagnostic report for a different source hash.
 * A passed projection never attests to physical audio or provider access.
 */
export function summarizeProjectReadiness({sourcePassed,implementationRequested,approved,currentImage,configuration,requirements,diagnostics,targetPassed}={}) {
 const implementing=implementationRequested===true;
 const configurationRevision=revision(configuration?.revision);
 const requirementsValid=record(requirements) && typeof requirements.wifi==='boolean' && typeof requirements.api==='boolean';
 const missing=[];
 if(requirements?.wifi===true && configuration?.wifiConfigured!==true)missing.push('wifi_not_configured');
 if(requirements?.api===true && configuration?.apiConfigured!==true)missing.push('api_not_configured');
 const stages={
  native:proofStatus(sourcePassed),
  preview:proofStatus(currentImage),
  design:approved===true ? 'passed' : implementing ? 'blocked' : 'pending',
  implementation:implementing ? 'passed' : 'pending',
  settings:implementing ? requirementsValid ? missing.length ? 'blocked' : 'passed' : 'unknown' : 'pending',
  target:implementing ? targetPassed===true ? 'passed' : targetPassed===false ? 'blocked' : 'pending' : 'pending',
 };
 const blockers=[],pending=[];
 if(sourcePassed!==true)blockers.push(reason('native','native_check_failed'));
 if(currentImage!==true)blockers.push(reason('preview','preview_required'));
 if(approved!==true)(implementing ? blockers : pending).push(reason('design','design_approval_required'));
 if(!implementing)pending.push(reason('implementation','implementation_request_required'));
 for(const code of missing)(implementing ? blockers : pending).push(reason('settings',code));
 const service={status:implementing ? serviceStatus(diagnostics,configurationRevision) : 'pending'};
 if(implementing){
  if(!requirementsValid)blockers.push(reason('settings','service_check_failed'));
  if(!['passed','not_required','unsupported'].includes(service.status))blockers.push(reason('service','service_check_failed'));
  if(targetPassed!==true)blockers.push(reason('target',targetPassed===false ? 'target_check_failed' : 'target_check_required'));
 }else pending.push(reason('target','target_check_required'));
 return{phase:implementing ? 'implementation' : 'design',passed:blockers.length===0,stages,blockers,pending,service,configurationRevision,evidence:{physical:'unknown',provider:'unknown'}};
}
