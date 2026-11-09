#pragma once
#include <cstdint>
#include <cstddef>
#include <atomic>

namespace Tamagotchi::DeviceWifi {
enum class Phase:uint8_t {WaitingForPlatform,NotConfigured,InvalidConfiguration,Starting,Connecting,ObtainingAddress,Connected,Disconnected,Error};
enum class StartResult:uint8_t {Accepted,AlreadyStarted,NotReady,NotConfigured,InvalidConfiguration,DriverError};
enum class RetryResult:uint8_t {Accepted,AlreadyConnected,Connecting,Cooldown,InvalidConfiguration,NotReady,Busy,DriverError};
enum class ScanRequestResult:uint8_t {Accepted,AlreadyConnected,Connecting,Cooldown,InvalidConfiguration,NotReady,Busy};
enum class ScanStatus:uint8_t {Idle,Queued,Running,Complete,Busy,Cancelled,TimedOut,Failed,CleanupFailed};
struct Configuration {bool valid=false,ssidPresent=false,passwordPresent=false;};
struct Country {bool known=false;uint8_t firstChannel=0,channelCount=0,policy=0;};
struct Link {int status=255;bool started=false,associated=false,ipReady=false,rssiKnown=false;int rssi=0,channel=0;};
enum class EventKind:uint8_t {None,Started,Associated,GotIp,Disconnected,LostIp,Stopped};
struct Event {EventKind kind=EventKind::None;int reason=-1;uint32_t sequence=0;};
struct Snapshot {
 Phase phase=Phase::WaitingForPlatform;
 bool platformReady=false,started=false,valid=false,ssidPresent=false,passwordPresent=false;
 bool associated=false,ipReady=false,rssiKnown=false,countryKnown=false;
 int status=255,reason=-1,error=0,rssi=0,channel=0;
 uint8_t countryFirstChannel=0,countryChannelCount=0,countryPolicy=0;
 uint32_t attempts=0,eventSequence=0,lastChangeMs=0,lastAttemptAt=0;
 RetryResult lastRetry=RetryResult::NotReady;
};
struct ScanSnapshot {
 ScanStatus status=ScanStatus::Idle;
 bool known=false,found=false,cleanupComplete=true;
 int rssi=0,channel=0,authmode=0,error=0;
 uint32_t requestedAt=0,finishedAt=0;
};
inline constexpr uint32_t kRetryCooldownMs=30000,kScanCooldownMs=30000,kScanBudgetMs=8000,kScanCleanupBudgetMs=500;
inline bool scanOwnsResources(const ScanSnapshot& scan) {
 return scan.status==ScanStatus::Queued || scan.status==ScanStatus::Running || !scan.cleanupComplete;
}
inline RetryResult retryDecision(const Snapshot& state,const ScanSnapshot& scan,uint32_t now) {
 if(scanOwnsResources(scan))return RetryResult::Busy;
 if(state.platformReady&&(!state.valid||!state.ssidPresent))return RetryResult::InvalidConfiguration;
 if(!state.platformReady)return RetryResult::NotReady;
 if(state.ipReady)return RetryResult::AlreadyConnected;
 if(state.associated||state.phase==Phase::Starting||state.phase==Phase::Connecting)return RetryResult::Connecting;
 if(state.attempts&&uint32_t(now-state.lastAttemptAt)<kRetryCooldownMs)return RetryResult::Cooldown;
 return RetryResult::Accepted;
}
inline ScanRequestResult scanDecision(const Snapshot& state,const ScanSnapshot& scan,uint32_t now,bool attempted) {
 if(scanOwnsResources(scan))return ScanRequestResult::Busy;
 if(state.platformReady&&(!state.valid||!state.ssidPresent))return ScanRequestResult::InvalidConfiguration;
 if(!state.platformReady||!state.started)return ScanRequestResult::NotReady;
 if(state.ipReady)return ScanRequestResult::AlreadyConnected;
 if(state.associated||state.phase==Phase::Starting||state.phase==Phase::Connecting)return ScanRequestResult::Connecting;
 if(attempted&&uint32_t(now-scan.requestedAt)<kScanCooldownMs)return ScanRequestResult::Cooldown;
 return ScanRequestResult::Accepted;
}
enum class ScanStart:uint8_t {Accepted,Busy,Failed};
enum class ScanPollStatus:uint8_t {Running,Complete,Failed};
struct ScanPoll {ScanPollStatus status=ScanPollStatus::Running;bool found=false;int rssi=0,channel=0,authmode=0,error=0;};
enum class Cleanup:uint8_t {Complete,Pending,Failed};

// Single-owner policy core. The Arduino facade serializes its pump and publishes
// value snapshots. Backend operations never receive a public SSID/key argument.
template<class Backend> class Controller {
 public:
  explicit Controller(Backend& backend):backend_(backend) {}
  StartResult begin(uint32_t now) {
   requested_=true;
   if(!state_.platformReady)return StartResult::NotReady;
   return start(now);
  }
  StartResult platformReady(uint32_t now) {
   state_.platformReady=true;requested_=true;return start(now);
  }
  RetryResult retry(uint32_t now) {
   refresh(now,true);
   const auto decision=retryDecision(state_,scan_,now);
   if(decision!=RetryResult::Accepted){state_.lastRetry=decision;return decision;}
   if(!state_.started){
    // A stopped/failed driver cannot connect. Only this admitted explicit
    // retry may restart it; ordinary ticks never reconfigure the radio.
    const auto result=start(now,true);
    state_.lastRetry=result==StartResult::Accepted?RetryResult::Accepted:
        result==StartResult::NotConfigured||result==StartResult::InvalidConfiguration?RetryResult::InvalidConfiguration:RetryResult::DriverError;
    return state_.lastRetry;
   }
   state_.lastAttemptAt=now;++state_.attempts;
   int error=0;const auto result=backend_.connect(error);
   state_.lastRetry=result;state_.error=error;
   if(result==RetryResult::Accepted||result==RetryResult::Connecting)setPhase(Phase::Connecting,now);
   return result;
  }
  ScanRequestResult requestScan(uint32_t now) {
   refresh(now,true);
   const auto decision=scanDecision(state_,scan_,now,scanAttempted_);
   if(decision!=ScanRequestResult::Accepted){
    if(!scanOwnsResources(scan_)){
     const uint32_t previous=scan_.requestedAt;scan_={};scan_.status=ScanStatus::Busy;scan_.requestedAt=previous;scan_.finishedAt=now;
    }
    return decision;
   }
   scan_={};scan_.status=ScanStatus::Queued;scan_.requestedAt=now;
   scanAttempted_=true;cancel_=false;return decision;
  }
  bool cancelScan() {
   if(!scanOwnsResources(scan_))return false;
   if(scan_.status==ScanStatus::CleanupFailed)cleanupRestart_=true;
   cancel_=true;return true;
  }
  void tick(uint32_t now) {
   if(requested_&&state_.platformReady&&!startAttempted_)start(now);
   refresh(now,false);
   if(cleanupRestart_){cleanupRestart_=false;scan_.status=ScanStatus::Running;finish(ScanStatus::Cancelled,now,true);return;}
   if(cleaning_){clean(now);return;}
   if(scan_.status==ScanStatus::Queued){
    if(cancel_){finish(ScanStatus::Cancelled,now,false);return;}
    if(state_.associated||state_.ipReady||state_.phase==Phase::Connecting){finish(ScanStatus::Busy,now,false);return;}
    int error=0;const auto result=backend_.startTargetScan(error);scan_.error=error;
    if(result!=ScanStart::Accepted){scan_.status=result==ScanStart::Busy?ScanStatus::Busy:ScanStatus::Failed;scan_.finishedAt=now;return;}
    scanOwned_=true;scan_.cleanupComplete=false;scan_.status=ScanStatus::Running;
    scanEventSequence_=state_.eventSequence;
   }
   if(scan_.status!=ScanStatus::Running)return;
   if(cancel_){finish(ScanStatus::Cancelled,now,true);return;}
   if(state_.associated||state_.ipReady||state_.eventSequence!=scanEventSequence_){finish(ScanStatus::Cancelled,now,true);return;}
   if(uint32_t(now-scan_.requestedAt)>=kScanBudgetMs){finish(ScanStatus::TimedOut,now,true);return;}
   const auto result=backend_.pollTargetScan();
   if(result.status==ScanPollStatus::Running)return;
   scan_.error=result.error;
   if(result.status==ScanPollStatus::Failed){finish(ScanStatus::Failed,now,true);return;}
   scan_.found=result.found;scan_.rssi=result.found?result.rssi:0;
   scan_.channel=result.found?result.channel:0;scan_.authmode=result.found?result.authmode:0;
   finish(ScanStatus::Complete,now,false);
  }
  Snapshot snapshot() const {return state_;}
  ScanSnapshot scanSnapshot() const {return scan_;}
 private:
  StartResult start(uint32_t now,bool explicitRetry=false) {
   if(startAttempted_&&!explicitRetry)return state_.started?StartResult::AlreadyStarted:lastStart_==StartResult::Accepted?StartResult::DriverError:lastStart_;
   startAttempted_=true;
   const auto config=backend_.configuration();state_.valid=config.valid;state_.ssidPresent=config.ssidPresent;state_.passwordPresent=config.passwordPresent;
   if(!config.ssidPresent&&!config.passwordPresent){setPhase(Phase::NotConfigured,now);lastStart_=StartResult::NotConfigured;return lastStart_;}
   if(!config.valid){setPhase(Phase::InvalidConfiguration,now);lastStart_=StartResult::InvalidConfiguration;return lastStart_;}
   setPhase(Phase::Starting,now);++state_.attempts;state_.lastAttemptAt=now;
   state_.started=backend_.start(state_.error);lastStart_=state_.started?StartResult::Accepted:StartResult::DriverError;
   state_.status=backend_.link().status;
   setPhase(state_.started?Phase::Connecting:Phase::Error,now);refresh(now,true);return lastStart_;
  }
  void setPhase(Phase phase,uint32_t now){if(state_.phase!=phase){state_.phase=phase;state_.lastChangeMs=now;}}
  void refresh(uint32_t now,bool force) {
   // Keep observing a stopped driver: a later SDK Started/GotIp must be
   // publishable without another application boot hook or radio operation.
   if(!startAttempted_||!state_.valid||!state_.ssidPresent)return;
   const auto event=backend_.latestEvent();const bool changed=event.sequence!=state_.eventSequence;
   if(!force&&!changed&&refreshed_&&uint32_t(now-refreshedAt_)<100)return;
   refreshed_=true;refreshedAt_=now;
   const auto link=backend_.link();state_.started=link.started;state_.status=link.status;state_.associated=link.associated;state_.ipReady=link.ipReady;
   state_.rssiKnown=link.rssiKnown;state_.rssi=link.rssiKnown?link.rssi:0;state_.channel=link.rssiKnown?link.channel:0;
   // The bounded event snapshot may coalesce a disconnect and recovery before
   // this pump. The backend retains its latest reason independently of kind.
   if(changed){state_.eventSequence=event.sequence;state_.reason=event.reason;}
   if(!link.started)setPhase(Phase::Error,now);
   else if(link.ipReady){state_.error=0;setPhase(Phase::Connected,now);}
   else if(link.associated)setPhase(Phase::ObtainingAddress,now);
   else if(changed){
    if(event.kind==EventKind::Disconnected)setPhase(Phase::Disconnected,now);
    else if(event.kind==EventKind::Stopped)setPhase(Phase::Error,now);
    else if(event.kind==EventKind::Started)setPhase(Phase::Connecting,now);
   }
   if(force||!countryRead_||uint32_t(now-countryAt_)>=1000){
    const auto region=backend_.country();countryRead_=true;countryAt_=now;
    state_.countryKnown=region.known;state_.countryFirstChannel=region.firstChannel;state_.countryChannelCount=region.channelCount;state_.countryPolicy=region.policy;
   }
  }
  void finish(ScanStatus status,uint32_t now,bool abort) {
   if(!scanOwned_){scan_.status=status;scan_.finishedAt=now;scan_.known=false;return;}
   finishingStatus_=status;scanOperationError_=status==ScanStatus::Failed?scan_.error:0;
   abortScan_=abort;cleaning_=true;cleanupAt_=now;cleanupTried_=false;
   clean(now);
  }
  void clean(uint32_t now) {
   if(cleanupTried_&&uint32_t(now-cleanupAt_)>=kScanCleanupBudgetMs){
    scan_.status=ScanStatus::CleanupFailed;scan_.known=false;scan_.finishedAt=now;cleaning_=false;return;
   }
   if(cleanupTried_&&uint32_t(now-lastCleanupTry_)<50)return;
   cleanupTried_=true;lastCleanupTry_=now;
   int error=0;const auto result=backend_.cleanupTargetScan(abortScan_,error);
   if(result!=Cleanup::Complete){scan_.error=error;return;}
   scanOwned_=false;cleaning_=false;scan_.cleanupComplete=true;
   scan_.error=scanOperationError_;
   scan_.status=finishingStatus_;scan_.known=finishingStatus_==ScanStatus::Complete;scan_.finishedAt=now;
  }
  Backend& backend_;Snapshot state_;ScanSnapshot scan_;
  bool requested_=false,startAttempted_=false,refreshed_=false,countryRead_=false,scanAttempted_=false,scanOwned_=false,cancel_=false,cleaning_=false,abortScan_=false,cleanupTried_=false,cleanupRestart_=false;
  StartResult lastStart_=StartResult::NotReady;ScanStatus finishingStatus_=ScanStatus::Idle;
  int scanOperationError_=0;
  uint32_t refreshedAt_=0,countryAt_=0,scanEventSequence_=0,cleanupAt_=0,lastCleanupTry_=0;
};
}
#ifdef ARDUINO
#include <Arduino.h>
#include <WiFiMulti.h>
#include <Preferences.h>
#include <esp_wifi.h>
#include <time.h>
#include <sys/time.h>
#include <cstring>
#ifdef KIBI_PROJECT_CONFIG
#if __has_include("kibi_project_config.h")
#include "kibi_project_config.h"
#endif
#endif
namespace Tamagotchi {
namespace WifiDetail {
inline std::atomic<bool> timeSynchronized{false},ntpStarted{false};
}
#ifdef KIBI_PROJECT_CONFIG
inline bool wifiSettingsValid() {
  const size_t ssidLength=std::strlen(KIBI_WIFI_SSID),passwordLength=std::strlen(KIBI_WIFI_PASSWORD);
  if(!ssidLength || ssidLength>32 || passwordLength>64) return false;
  if(passwordLength && passwordLength<8) return false;
  if(passwordLength==64) for(size_t i=0;i<passwordLength;++i) {
    const char c=KIBI_WIFI_PASSWORD[i];
    if(!((c>='0' && c<='9') || (c>='a' && c<='f') || (c>='A' && c<='F'))) return false;
  }
  return true;
}
#endif
namespace DeviceWifi {
class StandardBackend {
 public:
  Configuration configuration() {
#ifndef KIBI_PROJECT_CONFIG
   if(!ownerLoaded_){ownerLoaded_=true;Preferences settings;if(settings.begin("kibi_owner",true)){
    ownerSsid_=settings.getString("ssid","");ownerPassword_=settings.getString("password","");settings.end();
   }}
#endif
   const size_t name=std::strlen(ssid()),password=std::strlen(secret());
   bool valid=name>0&&name<=32&&password<=64&&(!password||password>=8);
   if(password==64)for(size_t i=0;i<password;++i){const char c=secret()[i];if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')||(c>='A'&&c<='F')))valid=false;}
   return {valid,name>0,password>0};
  }
  bool start(int& error) {
   if(!listening_){active_=this;WiFi.onEvent(onEvent);listening_=true;}
   WiFi.persistent(false);
   if(!WiFi.mode(WIFI_STA)){error=-1001;return false;}
   // Preserve the established platform behavior. No application-level override
   // of the SDK's reconnect policy, country, protection or persisted settings.
   WiFi.setAutoReconnect(true);
   const int result=int(WiFi.begin(ssid(),*secret()?secret():nullptr));
   if(result==WL_CONNECT_FAILED){error=-1002;return false;}
   error=0;return true;
  }
  RetryResult connect(int& error) {
   // Re-check actual link flags immediately before the operation. Never use
   // reconnect(): it can disconnect a link that won a race after admission.
   if(WiFi.STA.connected()){
    error=0;return WiFi.STA.hasIP()&&WiFi.status()==WL_CONNECTED?RetryResult::AlreadyConnected:RetryResult::Connecting;
   }
   const esp_err_t result=esp_wifi_connect();error=int(result);
   return result==ESP_OK?RetryResult::Accepted:result==ESP_ERR_WIFI_STATE?RetryResult::Connecting:RetryResult::DriverError;
  }
  Event latestEvent(){portENTER_CRITICAL(&mux_);const auto result=event_;portEXIT_CRITICAL(&mux_);return result;}
  Link link() {
   Link value;value.status=int(WiFi.status());value.started=WiFi.STA.started();
   value.associated=WiFi.STA.connected();
   value.ipReady=value.started&&value.associated&&WiFi.STA.hasIP()&&value.status==WL_CONNECTED;
   value.rssiKnown=value.associated;
   if(value.rssiKnown){value.rssi=int(WiFi.RSSI());value.channel=int(WiFi.channel());}
   return value;
  }
  Country country(){wifi_country_t value{};const bool okay=esp_wifi_get_country(&value)==ESP_OK;return{okay,okay?value.schan:uint8_t(0),okay?value.nchan:uint8_t(0),okay?uint8_t(value.policy):uint8_t(0)};}
  ScanStart startTargetScan(int& error) {
   if(WiFi.scanComplete()==WIFI_SCAN_RUNNING){error=ESP_ERR_WIFI_STATE;return ScanStart::Busy;}
   if(WiFi.STA.connected()||WiFi.status()==WL_CONNECTED){error=ESP_ERR_WIFI_STATE;return ScanStart::Busy;}
   scanRecordsKnown_=false;scanRemaining_=0;summary_={};scanStopped_=false;
   portENTER_CRITICAL(&mux_);scanOwned_=true;scanDone_=false;scanDriverStatus_=0;portEXIT_CRITICAL(&mux_);
   wifi_scan_config_t config{};config.ssid=reinterpret_cast<uint8_t*>(const_cast<char*>(ssid()));
   config.show_hidden=true;config.scan_type=WIFI_SCAN_TYPE_ACTIVE;config.scan_time.active.max=120;
   const esp_err_t result=esp_wifi_scan_start(&config,false);error=int(result);
   if(result==ESP_OK)return ScanStart::Accepted;
   portENTER_CRITICAL(&mux_);scanOwned_=false;portEXIT_CRITICAL(&mux_);
   return result==ESP_ERR_WIFI_STATE?ScanStart::Busy:ScanStart::Failed;
  }
  ScanPoll pollTargetScan() {
   portENTER_CRITICAL(&mux_);const bool done=scanDone_;const uint32_t status=scanDriverStatus_;portEXIT_CRITICAL(&mux_);
   if(!done)return {};
   if(status)return{ScanPollStatus::Failed,false,0,0,0,int(status)};
   if(!scanRecordsKnown_){
    const esp_err_t result=esp_wifi_scan_get_ap_num(&scanRemaining_);
    if(result!=ESP_OK)return{ScanPollStatus::Failed,false,0,0,0,int(result)};
    if(scanRemaining_>256)return{ScanPollStatus::Failed,false,0,0,0,-1003};
    scanRecordsKnown_=true;
   }
   // Drain a bounded batch per pump; get_ap_record frees each SDK record.
   for(unsigned work=0;work<8&&scanRemaining_;++work){
    wifi_ap_record_t record{};const esp_err_t result=esp_wifi_scan_get_ap_record(&record);
    if(result!=ESP_OK)return{ScanPollStatus::Failed,false,0,0,0,int(result)};
    --scanRemaining_;
    const char* candidate=reinterpret_cast<const char*>(record.ssid);
    const size_t length=strnlen(candidate,sizeof(record.ssid)),targetLength=std::strlen(ssid());
    if(length!=targetLength||std::memcmp(candidate,ssid(),length))continue;
    if(!summary_.found||record.rssi>summary_.rssi){summary_.found=true;summary_.rssi=int(record.rssi);summary_.channel=int(record.primary);summary_.authmode=int(record.authmode);}
   }
   summary_.status=scanRemaining_?ScanPollStatus::Running:ScanPollStatus::Complete;return summary_;
  }
  Cleanup cleanupTargetScan(bool abort,int& error) {
   portENTER_CRITICAL(&mux_);const bool owned=scanOwned_,done=scanDone_;portEXIT_CRITICAL(&mux_);
   if(!owned){error=0;return Cleanup::Complete;}
   if(abort&&!done&&!scanStopped_){
    const esp_err_t result=esp_wifi_scan_stop();error=int(result);
    if(result!=ESP_OK)return result==ESP_ERR_WIFI_STATE?Cleanup::Pending:Cleanup::Failed;
    scanStopped_=true;
   }
   if(!done&&!scanStopped_){error=ESP_ERR_WIFI_STATE;return Cleanup::Pending;}
   const esp_err_t result=esp_wifi_clear_ap_list();error=int(result);
   if(result!=ESP_OK)return Cleanup::Failed;
   portENTER_CRITICAL(&mux_);scanOwned_=false;scanDone_=false;portEXIT_CRITICAL(&mux_);
   return Cleanup::Complete;
  }
 private:
  const char* ssid()const {
#ifdef KIBI_PROJECT_CONFIG
   return KIBI_WIFI_SSID;
#else
   return ownerSsid_.c_str();
#endif
  }
  const char* secret()const {
#ifdef KIBI_PROJECT_CONFIG
   return KIBI_WIFI_PASSWORD;
#else
   return ownerPassword_.c_str();
#endif
  }
  static void onEvent(arduino_event_id_t id,arduino_event_info_t info) {
   if(!active_)return;auto& backend=*active_;
   portENTER_CRITICAL(&backend.mux_);
   EventKind kind=EventKind::None;
   switch(id){
    case ARDUINO_EVENT_WIFI_STA_START:kind=EventKind::Started;break;
    case ARDUINO_EVENT_WIFI_STA_CONNECTED:kind=EventKind::Associated;break;
    case ARDUINO_EVENT_WIFI_STA_GOT_IP:kind=EventKind::GotIp;break;
    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:kind=EventKind::Disconnected;backend.event_.reason=int(info.wifi_sta_disconnected.reason);break;
    case ARDUINO_EVENT_WIFI_STA_LOST_IP:kind=EventKind::LostIp;break;
    case ARDUINO_EVENT_WIFI_STA_STOP:kind=EventKind::Stopped;break;
    case ARDUINO_EVENT_WIFI_SCAN_DONE:if(backend.scanOwned_){backend.scanDone_=true;backend.scanDriverStatus_=info.wifi_scan_done.status;}break;
    default:break;
   }
   if(kind!=EventKind::None){backend.event_.kind=kind;++backend.event_.sequence;}
   portEXIT_CRITICAL(&backend.mux_);
  }
  inline static StandardBackend* active_=nullptr;
  portMUX_TYPE mux_=portMUX_INITIALIZER_UNLOCKED;Event event_;
  bool listening_=false,scanOwned_=false,scanDone_=false,scanStopped_=false,scanRecordsKnown_=false;
  uint32_t scanDriverStatus_=0;uint16_t scanRemaining_=0;ScanPoll summary_;
#ifndef KIBI_PROJECT_CONFIG
  bool ownerLoaded_=false;String ownerSsid_,ownerPassword_;
#endif
};
namespace Detail {
inline StandardBackend backend;
inline Controller<StandardBackend> controller(backend);
inline portMUX_TYPE mux=portMUX_INITIALIZER_UNLOCKED;
inline Snapshot published;inline ScanSnapshot publishedScan;
inline bool pumping=false,startPending=false,readyPending=false,retryPending=false,scanPending=false,cancelPending=false,scanAttempted=false;
inline StartResult lastStart=StartResult::NotReady;
}
inline Snapshot snapshot(){portENTER_CRITICAL(&Detail::mux);const auto value=Detail::published;portEXIT_CRITICAL(&Detail::mux);return value;}
inline ScanSnapshot scanSnapshot(){portENTER_CRITICAL(&Detail::mux);const auto value=Detail::publishedScan;portEXIT_CRITICAL(&Detail::mux);return value;}
inline void requestStart(){portENTER_CRITICAL(&Detail::mux);Detail::startPending=true;portEXIT_CRITICAL(&Detail::mux);}
inline RetryResult requestRetry(uint32_t now) {
 portENTER_CRITICAL(&Detail::mux);
 RetryResult result=(Detail::pumping||Detail::retryPending||Detail::scanPending)?RetryResult::Busy:retryDecision(Detail::published,Detail::publishedScan,now);
 if(result==RetryResult::Accepted)Detail::retryPending=true;
 portEXIT_CRITICAL(&Detail::mux);return result;
}
inline ScanRequestResult requestTargetScan(uint32_t now) {
 portENTER_CRITICAL(&Detail::mux);
 const auto result=(Detail::pumping||Detail::retryPending||Detail::scanPending)?ScanRequestResult::Busy:scanDecision(Detail::published,Detail::publishedScan,now,Detail::scanAttempted);
 if(result==ScanRequestResult::Accepted){Detail::scanPending=true;Detail::publishedScan.status=ScanStatus::Queued;Detail::publishedScan.known=false;}
 portEXIT_CRITICAL(&Detail::mux);return result;
}
inline bool cancelTargetScan() {
 portENTER_CRITICAL(&Detail::mux);const bool accepted=Detail::scanPending||scanOwnsResources(Detail::publishedScan);
 if(accepted)Detail::cancelPending=true;
 portEXIT_CRITICAL(&Detail::mux);return accepted;
}
inline void tick(uint32_t now) {
 portENTER_CRITICAL(&Detail::mux);
 if(Detail::pumping){portEXIT_CRITICAL(&Detail::mux);return;}
 Detail::pumping=true;
 const bool start=Detail::startPending,ready=Detail::readyPending,retry=Detail::retryPending,scan=Detail::scanPending,cancel=Detail::cancelPending;
 StartResult startResult=Detail::lastStart;
 Detail::startPending=Detail::readyPending=Detail::retryPending=Detail::scanPending=Detail::cancelPending=false;
 portEXIT_CRITICAL(&Detail::mux);
 if(ready)startResult=Detail::controller.platformReady(now);
 else if(start)startResult=Detail::controller.begin(now);
 Detail::controller.tick(now);
 if(retry)Detail::controller.retry(now);
 if(scan)Detail::controller.requestScan(now);
 if(cancel)Detail::controller.cancelScan();
 Detail::controller.tick(now);
 const auto state=Detail::controller.snapshot();const auto trace=Detail::controller.scanSnapshot();
 portENTER_CRITICAL(&Detail::mux);
 Detail::published=state;Detail::publishedScan=trace;
 Detail::lastStart=startResult;
 if(trace.status!=ScanStatus::Idle)Detail::scanAttempted=true;
 Detail::pumping=false;portEXIT_CRITICAL(&Detail::mux);
}
// Platform-only: state_info calls this after the original ADC2 battery series.
inline StartResult beginAfterPlatformReady() {
 portENTER_CRITICAL(&Detail::mux);Detail::readyPending=true;portEXIT_CRITICAL(&Detail::mux);
 tick(millis());portENTER_CRITICAL(&Detail::mux);const auto result=Detail::lastStart;portEXIT_CRITICAL(&Detail::mux);return result;
}
}
// Compatibility API: a premature application call only requests startup. It
// never starts RF ahead of the platform-owned ADC2 initialization.
inline void beginWifi(){DeviceWifi::requestStart();}
inline void acceptTrustedServerTime(uint32_t epoch) {
  if(epoch<1700000000u) return;
  timeval value{static_cast<time_t>(epoch),0};
  if(settimeofday(&value,nullptr)==0) WifiDetail::timeSynchronized=true;
}
inline void updateWifi(int& hour,int& minute,int& level) {
  DeviceWifi::tick(millis());
  level=0;
  if(WiFi.status()==WL_CONNECTED) {
    const int rssi=WiFi.RSSI();level=rssi>-60?3:rssi>-75?2:1;
    if(!WifiDetail::ntpStarted.exchange(true)) {
      configTime(0,0,"pool.ntp.org","time.cloudflare.com");
    }
  }
  const time_t now=time(nullptr);WifiDetail::timeSynchronized=now>1700000000;
  if(WifiDetail::timeSynchronized) {
    tm t{};localtime_r(&now,&t);hour=t.tm_hour;minute=t.tm_min;
  }
}
}
#else
namespace Tamagotchi { namespace WifiDetail { inline bool timeSynchronized=false; } }
#endif
