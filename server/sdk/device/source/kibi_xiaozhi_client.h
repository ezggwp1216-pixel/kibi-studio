#pragma once
// One device-wide, application-independent client extracted from the latest
// user-approved working voice path. Keep it in one owning Feature lifecycle.
// Native builds provide an unavailable fallback; they never open services.
#include "kibi_xiaozhi_core.h"
#include <cstring>
#include <cstdio>
#ifdef ARDUINO
#include "wifi.h"
#include <esp_sntp.h>
#include "http_json.h"
#include "server_transport.h"
#include "audio_codec_power.h"
#include "power_management.h"
#include "KibiOpus.h"
#include <Preferences.h>
#include <mbedtls/sha1.h>
#include <mbedtls/base64.h>
#include <esp_system.h>
#include <esp_heap_caps.h>
#include <freertos/queue.h>
#include <cerrno>
#include <new>
#endif

namespace Kibi::XiaozhiClient {
struct Config {
 // Trusted application configuration only. Pairing cannot change this origin.
 const char* apiBase="https://sldvkibi.ru/server/";
 const char* deviceName="Киби";
 const char* nvsNamespace="kibi_voice";
};
enum class State:uint8_t {Uninitialized,Idle,Connecting,Pairing,Listening,Speaking,Greeting,Stopping,Error,Quarantined,Unavailable,ResettingPairing};
struct Snapshot {
 State state=State::Uninitialized;bool configured=false,hardwareAvailable=false,running=false,paired=false,pairedKnown=false;
 uint32_t generation=0;uint8_t volume=100,error=0;bool volumeApplied=false;
 char pairingCode[10]={};Core::Pairing::Diagnostic diagnostic;
 bool metricsKnown=false;uint32_t writeErrors=0,writeTimeouts=0;int primaryCode=0,cleanupCode=0;
};
namespace Internal {
struct Configuration {Core::Endpoint endpoint;char name[65]={},storage[16]={};};
inline Configuration configuration;inline Snapshot snapshot;
inline void clearGenerationEvidence(Snapshot& state){
 state.metricsKnown=false;state.writeErrors=0;state.writeTimeouts=0;
 state.volumeApplied=false;state.primaryCode=0;state.cleanupCode=0;
}
inline void advanceCancellationGeneration(Snapshot& state){
 ++state.generation;if(!state.generation)++state.generation;
 clearGenerationEvidence(state);state.state=State::Stopping;
}
inline bool validConfig(const Config& value,Configuration& out){
 Configuration checked;if(!Core::parseApiBase(value.apiBase,checked.endpoint)||!Core::Pairing::opaque(value.deviceName,64)||!value.nvsNamespace)return false;
 size_t size=std::strlen(value.nvsNamespace);if(!size||size>=sizeof(checked.storage))return false;
 for(const char* p=value.nvsNamespace;*p;++p)if(!((*p>='a'&&*p<='z')||(*p>='A'&&*p<='Z')||(*p>='0'&&*p<='9')||*p=='_'))return false;
 std::snprintf(checked.name,sizeof(checked.name),"%s",value.deviceName);std::snprintf(checked.storage,sizeof(checked.storage),"%s",value.nvsNamespace);out=checked;return true;
}
inline bool sameConfig(const Configuration& a,const Configuration& b){return !std::strcmp(a.endpoint.apiBase,b.endpoint.apiBase)&&!std::strcmp(a.name,b.name)&&!std::strcmp(a.storage,b.storage);}
}
#ifdef ARDUINO
namespace Detail {
using namespace Core;
struct Command {uint32_t generation=0;Audio::Settings settings=Audio::ordinaryVoiceSettings();uint8_t level=100;bool resetPairing=false;};
struct Result {uint32_t generation=0;uint8_t phase=0,error=0;bool paired=false;char code[10]={};Pairing::Diagnostic diagnostic;};
inline std::atomic<uint32_t> wanted{0};
inline QueueHandle_t commands=nullptr,results=nullptr,metrics=nullptr;
struct MetricFrame {uint32_t generation;uint8_t phase;Audio::Settings settings;Audio::Stats stats;};
inline TaskHandle_t audioTask=nullptr;
inline Command job{};inline Audio::Stats audioStats,finalStats;inline Audio::FirstWriteFailure firstWriteFailure;
inline std::atomic<uint32_t> stopEpoch{0},checksumFailures{0},orderFailures{0},incomingHigh{0},outgoingHigh{0};
inline bool runFailed=false;inline Conversation::Failures failures;inline std::atomic<uint32_t> audioReady{0};inline int prepareError=0;
inline std::atomic<bool> busy{false},fatal{false},sessionStop{false},outputPending{false};
inline std::atomic<uint32_t> audioDone{0},networkClosed{0},listenEpoch{0},freshReadyGeneration{0},freshReadyTurn{0},maxRxGap{0},maxNetworkMs{0};
inline std::atomic<uint8_t> audioPhase{0},audioError{0};inline std::atomic<int> audioDetail{0};
inline Conversation::Queue<Conversation::Event,32> incoming;inline Conversation::Queue<Conversation::Event,8> outgoing;
inline Conversation::Event* incomingStorage=nullptr;inline Conversation::Event* outgoingStorage=nullptr;
inline void maximum(std::atomic<uint32_t>& value,uint32_t n){uint32_t old=value.load();while(n>old&&!value.compare_exchange_weak(old,n)){}}
inline bool alive(uint32_t generation){return Conversation::currentGeneration(generation,wanted.load(),sessionStop.load(),fatal.load());}
inline Conversation::VoiceLevel voiceLevel;
inline bool attempted=false;inline Tamagotchi::DeviceAudio::Session audio;inline Kibi::Xiaozhi::Codec codec;
inline uint32_t activeGeneration=0;inline char deviceToken[513]={};inline Pairing::Diagnostic diagnostic;
inline std::atomic<int> disconnectReason{0};inline std::atomic<bool> baseSntpStarted{false};inline ClockRecovery::Budget clockRetryBudget;
inline bool ipReady(){return WiFi.status()==WL_CONNECTED&&WiFi.localIP()!=IPAddress(0,0,0,0);}
inline void observedWifi(arduino_event_id_t event,arduino_event_info_t info){if(event==ARDUINO_EVENT_WIFI_STA_DISCONNECTED)disconnectReason.store(info.wifi_sta_disconnected.reason);}
inline void notePrimary(int code){if(wanted.load()==activeGeneration)failures.note(code);}
inline bool current(){return alive(activeGeneration);}
inline void publish(uint8_t phase,uint8_t error=0,const char* code=""){
 Result result{};result.generation=activeGeneration;result.phase=phase;result.error=error;result.paired=deviceToken[0];result.diagnostic=diagnostic;
 if(error!=9&&error&&result.diagnostic.code==Pairing::Code::None){result.diagnostic.stage=Pairing::Stage::Voice;result.diagnostic.code=Pairing::Code::Local;result.diagnostic.detail=error;}
 std::snprintf(result.code,sizeof(result.code),"%s",code);if(xQueueSend(results,&result,0)!=pdTRUE){fatal.store(true);sessionStop.store(true);}
}
inline bool safe(const char* s,size_t max){if(!s||!s[0]||strlen(s)>max)return false;for(;*s;++s)if(!((*s>='a'&&*s<='z')||(*s>='A'&&*s<='Z')||(*s>='0'&&*s<='9')||*s=='-'||*s=='_'))return false;return true;}
struct RequestResult {bool ok=false;int http=0;};
inline RequestResult request(const char* path,int expected,Pairing::Stage stage,const JsonDocument& body,JsonDocument& out){
using namespace Tamagotchi;using namespace Pairing;
diagnostic={};diagnostic.stage=stage;out.clear();
auto fail=[&](Code code,int detail=0){diagnostic.code=code;diagnostic.detail=detail;out.clear();return RequestResult{false,diagnostic.http};};
if(!current())return fail(Code::Cancelled);
if(!ipReady()){diagnostic.wifiStatus=int(WiFi.status());diagnostic.wifiMode=int(WiFi.getMode());diagnostic.reason=disconnectReason.load();return fail(Code::Link);}
char url[320],payload[1024];int target=snprintf(url,sizeof(url),"%sapi/%s",Internal::configuration.endpoint.apiBase,path);if(target<0||size_t(target)>=sizeof(url))return fail(Code::Local,4);
if(body.overflowed()||measureJson(body)>=sizeof(payload))return fail(Code::Local,1);
size_t bytes=serializeJson(body,payload,sizeof(payload));if(bytes!=measureJson(body))return fail(Code::Local,2);
Https::DeadlineClient client(20000,NetworkGate::Priority::Voice,current);
client.useBuiltinCACertBundle();client.setHandshakeTimeout(8);client.setTimeout(5000);
HTTPClient http;http.setConnectTimeout(6000);http.setTimeout(5000);http.setReuse(false);
http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
if(!http.begin(client,url))return fail(Code::Local,3);
http.addHeader("Content-Type","application/json");http.addHeader("Accept","application/json");http.addHeader("Accept-Encoding","identity");
const int status=http.POST(reinterpret_cast<uint8_t*>(payload),bytes);diagnostic.http=status>0?status:0;
if(status<=0){
char discard[1]={};diagnostic.tls=client.lastError(discard,sizeof(discard));
bool timed=client.timedOut();http.end();
if(!current())return fail(Code::Cancelled);
return fail(timed?Code::Timeout:diagnostic.tls<=-4096?Code::Tls:Code::Link,status);
}
if(status!=expected){http.end();return fail(Code::Http);}
const int announced=http.getSize();if(announced>4096){http.end();return fail(Code::TooLarge,announced);}
char response[4097];Https::BoundedStream sink(response,sizeof(response));
const int received=http.writeToStream(&sink);
const bool timed=client.timedOut();const size_t stored=sink.size();const bool overflow=sink.overflow;
http.end();
if(!current())return fail(Code::Cancelled);
const Code bodyCode=bodyStatus(status,expected,announced,received,stored,overflow,timed);
if(bodyCode!=Code::None)return fail(bodyCode,received);
const Code jsonCode=decodeBody(static_cast<const char*>(response),stored,out);
if(jsonCode!=Code::None)return fail(jsonCode);
return {true,status};
}
inline bool pair(){
using namespace Pairing;
JsonDocument in,out;in["name"]=Internal::configuration.name;
diagnostic={};diagnostic.stage=Stage::Start;publish(1);
auto result=request("pairing/start",201,Stage::Start,in,out);
if(!result.ok){if(current())publish(0,4);return false;}
Start start;
if(!out.is<JsonObject>()||!readStart(out.as<JsonObjectConst>(),start)){diagnostic.code=Code::Fields;publish(0,4);return false;}
JsonDocument poll;poll["pairingId"]=start.id;poll["pollToken"]=start.pollToken;
uint32_t began=millis(),last=began;publish(2,0,start.code);
while(current()&&uint32_t(millis()-began)<295000){
if(uint32_t(millis()-last)<start.intervalMs){vTaskDelay(pdMS_TO_TICKS(20));continue;}last=millis();
JsonDocument answer;auto polled=request("pairing/poll",200,Stage::Poll,poll,answer);
if(!current())return false;
if(!polled.ok){if(polled.http==410)diagnostic.code=Code::Expired;publish(0,polled.http==410?5:4);return false;}
auto state=readPoll(answer.as<JsonObjectConst>(),Internal::configuration.endpoint);
if(state==Poll::Pending)continue;
if(state!=Poll::Paired){diagnostic.code=Code::Fields;publish(0,4);return false;}
diagnostic={};diagnostic.stage=Stage::Store;
const char* token=answer["token"]|"";
Preferences prefs;
if(!prefs.begin(Internal::configuration.storage,false)){diagnostic.code=Code::Storage;diagnostic.detail=1;publish(0,6);return false;}
// Origin and token are one atomic NVS value. A later trusted server change
// must never send an earlier server's bare token to its new destination.
JsonDocument binding;binding["apiBase"]=Internal::configuration.endpoint.apiBase;binding["token"]=token;
String encoded;size_t encodedSize=serializeJson(binding,encoded);
bool saved=!binding.overflowed()&&encodedSize>0&&encodedSize<=1024&&prefs.putString("binding",encoded)==encodedSize;prefs.end();
if(!saved){diagnostic.code=Code::Storage;diagnostic.detail=2;publish(0,6);return false;}
snprintf(deviceToken,sizeof(deviceToken),"%s",token);publish(0,2);return false;
}
if(current()){diagnostic.stage=Stage::Poll;diagnostic.code=Code::Expired;publish(0,5);}return false;
}
class WebSocket {
public:
Tamagotchi::ServerTransport::BasicSocket<NetworkClientSecure,true> client;
uint32_t activityAt=0;int failure=0;

uint8_t wire[8192]{},message[4096]{};size_t used=0,size=0;uint8_t kind=0,fragment=0;
 static_assert(sizeof(message)>=1920&&sizeof(wire)>=1920+14,"PCM downlink exceeds WebSocket buffers");
bool send(uint8_t op,const uint8_t* data,size_t n){
if(n>4096||!current())return false;
uint8_t packet[4110];size_t h=0;packet[h++]=0x80|op;
if(n<126)packet[h++]=0x80|n;else{packet[h++]=0xfe;packet[h++]=n>>8;packet[h++]=n;}
uint32_t mask=esp_random();uint8_t key[4];memcpy(key,&mask,4);memcpy(packet+h,key,4);h+=4;
for(size_t i=0;i<n;++i)packet[h+i]=data[i]^key[i%4];

uint32_t at=millis();size_t written=0;bool complete=Conversation::writeFrame(client,packet,h+n,written);maximum(maxNetworkMs,uint32_t(millis()-at));
if(written)activityAt=millis();
if(!complete){failure=921;return false;}return true;
}
bool text(const char* s){return send(1,reinterpret_cast<const uint8_t*>(s),strlen(s));}
bool open(){
using namespace VoiceOpen;
size_t written=0,expected=0;int httpStatus=0;
auto observe=[&](Step step,bool okay){
char discarded[1]={};int sdk=client.lastError(discarded,sizeof(discarded));
if(!okay){
notePrimary(int(step));diagnostic={};diagnostic.stage=Pairing::Stage::Voice;diagnostic.code=code(step);
diagnostic.detail=int(step);diagnostic.http=httpStatus;diagnostic.tls=sdk;
}
return okay;
};

client.useBuiltinCACertBundle();client.setHandshakeTimeout(10);client.setConnectionTimeout(5000);

int connected=0;

if(!current())return observe(Step::Cancel,false);
{
 Tamagotchi::NetworkGate::TlsHandshakeScope idle;
 connected=client.connect(Internal::configuration.endpoint.host,443);
 
}


if(!Conversation::afterConnect(connected!=0,current())){
 client.stop();return observe(current()?Step::Connect:Step::Cancel,false);
}
client.ioTimeout(1000); // milliseconds, reset ALL I/O limits after connect.
activityAt=millis();observe(Step::Connect,true);

uint8_t random[16];esp_fill_random(random,sizeof(random));unsigned char key[32];size_t kn=0;
if(mbedtls_base64_encode(key,sizeof(key)-1,&kn,random,sizeof(random)))return observe(Step::Nonce,false);key[kn]=0;
char request[1024];int n=snprintf(request,sizeof(request),"GET /kibi-xiaozhi/v1 HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: %s\r\nAuthorization: Bearer %s\r\n\r\n",Internal::configuration.endpoint.host,key,deviceToken);
Step writeStep=writeResult(n,sizeof(request),0);
if(writeStep==Step::RequestSize)return observe(writeStep,false);
expected=size_t(n);if(!current())return observe(Step::Cancel,false);
written=client.write(reinterpret_cast<uint8_t*>(request),expected);
writeStep=writeResult(n,sizeof(request),written);
if(writeStep!=Step::None)return observe(writeStep,false);
observe(Step::RequestWrite,true);
char headers[2048]={};size_t got=0;uint32_t start=millis();
while(current()&&uint32_t(millis()-start)<6000&&got<sizeof(headers)-1){
if(!client.connected())return observe(Step::Closed,false);if(!client.available()){vTaskDelay(1);continue;}
int b=client.read();if(b<0)continue;headers[got++]=char(b);headers[got]=0;
if(!httpStatus&&b=='\n'){int status=0;if(sscanf(headers,"HTTP/%*d.%*d %d",&status)==1&&status>=100&&status<=599)httpStatus=status;}
if(got>=4&&!memcmp(headers+got-4,"\r\n\r\n",4))break;
}
int parsed=0;if(sscanf(headers,"HTTP/%*d.%*d %d",&parsed)==1&&parsed>=100&&parsed<=599)httpStatus=parsed;
bool terminated=got>=4&&!memcmp(headers+got-4,"\r\n\r\n",4);
Step endStep=responseEnd(current(),got,sizeof(headers),terminated,!strncmp(headers,"HTTP/1.1 101 ",13));
if(endStep!=Step::None)return observe(endStep,false);
observe(Step::HttpStatus,true);
char joined[128];snprintf(joined,sizeof(joined),"%s258EAFA5-E914-47DA-95CA-C5AB0DC85B11",key);
unsigned char digest[20],accept[32];size_t an=0;
if(mbedtls_sha1(reinterpret_cast<unsigned char*>(joined),strlen(joined),digest)||mbedtls_base64_encode(accept,sizeof(accept)-1,&an,digest,20))return observe(Step::Digest,false);accept[an]=0;
bool accepted=false,upgrade=false,connection=false;
for(char* line=strtok(headers,"\r\n");line;line=strtok(nullptr,"\r\n")){
char* colon=strchr(line,':');if(!colon)continue;*colon++=0;while(*colon==' ')++colon;
if(!strcasecmp(line,"Sec-WebSocket-Accept"))accepted=!strcmp(colon,reinterpret_cast<char*>(accept));
if(!strcasecmp(line,"Upgrade"))upgrade=!strcasecmp(colon,"websocket");
if(!strcasecmp(line,"Connection")){for(char* p=colon;*p;++p)if(*p>='A'&&*p<='Z')*p+=32;connection=strstr(colon,"upgrade");}
}
Step flags=acceptFlags(accepted,upgrade,connection,current());if(flags!=Step::None)return observe(flags,false);
client.ioTimeout(40);activityAt=millis();return observe(Step::None,true);
}
// Bounded RFC6455 parser, including control frames within fragmented messages.
int receive(){
failure=911; // overwritten for transport/peer close; no payload diagnostics.
if(!current())return -1;if(!client.connected()){failure=917;return -1;}
int available=client.available();if(available>0){size_t take=std::min(size_t(available),std::min(size_t(2048),sizeof(wire)-used));if(!take)return -1;int n=client.read(wire+used,take);if(n>0){used+=size_t(n);activityAt=millis();}}
if(used<2)return 0;
uint8_t op=wire[0]&15;bool fin=wire[0]&128;size_t len=wire[1]&127,h=2;
if((wire[0]&0x70)||(wire[1]&128)||len==127)return -1;
if(len==126){if(used<4)return 0;len=(size_t(wire[2])<<8)|wire[3];h=4;if(len<126)return -1;}
if(len>4096||(op>=8&&(!fin||len>125)))return -1;
if(used<h+len)return 0;
int result=0;
if(op==8){failure=917;return -1;}
if(op==9){if(!send(10,wire+h,len))return -1;}
else if(op==10){}
else{
if(op==0){if(!fragment)return -1;}
else if((op!=1&&op!=2)||fragment)return -1;
else{fragment=op;size=0;}
if(size+len>sizeof(message))return -1;memcpy(message+size,wire+h,len);size+=len;
if(fin){kind=fragment;fragment=0;result=1;}
}
memmove(wire,wire+h+len,used-h-len);used-=h+len;return result;
}
~WebSocket(){client.stop();}
};
inline bool ensureClock(){
using namespace ClockRecovery;using namespace Pairing;
Gate gate;int lastStage=-1,lastSecond=-1;
while(true){
uint32_t now=millis();bool online=ipReady(),valid=time(nullptr)>=1700000000;
bool started=baseSntpStarted.load(std::memory_order_acquire);
bool enabled=started&&esp_sntp_enabled();
Step step=gate.step(now,online,valid,started,enabled,!current(),clockRetryBudget.allows(now));
if(step==Step::Cancelled)return false;
diagnostic={};diagnostic.stage=online?Stage::Clock:Stage::Wifi;
diagnostic.wifiStatus=int(WiFi.status());diagnostic.wifiMode=int(WiFi.getMode());diagnostic.reason=disconnectReason.load();
diagnostic.sntp=enabled?1:0;diagnostic.clockValid=valid;diagnostic.attempt=gate.attempts;
diagnostic.waitSec=int(uint32_t(now-gate.began)/1000);
// The SDK sync-status getter consumes COMPLETED; read only at a terminal result,
// and retain that sampled value in the diagnostic snapshot.
if(step==Step::Ready){diagnostic.sync=started?int(esp_sntp_get_sync_status()):-1;
publish(1);return true;}
if(step==Step::NetworkTimeout||step==Step::ClockTimeout||step==Step::Inactive){
diagnostic.sync=started?int(esp_sntp_get_sync_status()):-1;
diagnostic.code=step==Step::Inactive?Code::Local:step==Step::NetworkTimeout?Code::Link:Code::Timeout;
diagnostic.detail=step==Step::Inactive?1:0;publish(0,online?10:1);return false;
}
if(step==Step::Retry){
clockRetryBudget.mark(now);
bool accepted=esp_sntp_restart();diagnostic.detail=accepted?2:1;
if(!accepted){diagnostic.code=Code::Local;publish(0,10);return false;}
}
if(int(diagnostic.stage)!=lastStage||diagnostic.waitSec!=lastSecond){
lastStage=int(diagnostic.stage);lastSecond=diagnostic.waitSec;publish(1);
}
vTaskDelay(pdMS_TO_TICKS(20));
}
}
inline std::atomic<uint32_t> mediaEpoch{0};
inline bool wantsCodec(){return true;}
struct ResourceIO {
 bool standbyUncertain=false;
 bool beginCodec(){return !wantsCodec()||codec.begin();}
 bool beginAudio(){return alive(job.generation)&&audio.begin();}
 bool setVolume(uint8_t value){return audio.setVolume(value);}
 bool stopAudio(){return audio.stopPlayback();}
 bool endAudio(){bool okay=audio.end();standbyUncertain|=!okay&&audio.lastError()==Tamagotchi::DeviceAudio::Error::Codec;return okay;}
 bool standbyFailed()const{return standbyUncertain;}
 bool codecOwned()const{return codec.ownsResources();}
 bool endCodec(){return codec.end();}
};

struct AudioIO {
 uint32_t generation;Conversation::Playout* pump=nullptr;
 Audio::MediaSpan span;uint32_t lastTx=0,lastWait=0;bool haveTx=false;
 void endMedia(){audioStats.mediaUs+=span.close();haveTx=false;}
 bool resetDecoder(){endMedia();return !wantsCodec()||codec.resetDecoder();}
 bool prepare(){return alive(generation)&&audio.preparePlayback();}
 bool volume(uint8_t v){return alive(generation)&&audio.setVolume(v);}
 bool cleanup(){endMedia();bool a=audio.stopPlayback();bool b=!wantsCodec()||codec.reset();return a&&b;}
 bool write(const int16_t* input,size_t n,size_t& submitted){
  submitted=0;lastWait=0;if(!pump||!alive(generation))return false;
  const bool media=pump->writeKind==Conversation::Playout::WriteKind::Media;
  if(!media)endMedia();else span.begin(micros());
  bool okay=Audio::speakerWrite(input,n,submitted,lastWait,pump->writeKind,pump->cursor,job.settings.limiter,audioStats,firstWriteFailure,
   [&](const int16_t* pcm,size_t count,uint32_t timeout){
    size_t got=0;const auto status=audio.writeSpeakerMono(pcm,count,got,timeout);
    const auto error=audio.lastError();
    return Audio::TxCall{int(status),int(error),got,status==Tamagotchi::DeviceAudio::Status::Ok,status==Tamagotchi::DeviceAudio::Status::TimedOut};
   },[]{return micros();},[&]{return alive(generation);},
   [&](size_t,uint32_t end,bool complete){
    if(media&&complete){
     if(haveTx){uint32_t gap=uint32_t(end-lastTx);if(gap>audioStats.txGapUs)audioStats.txGapUs=gap;}
     span.submitted(end);lastTx=end;haveTx=true;
    }
   });
  if(!okay&&firstWriteFailure.present)notePrimary(915);
  return okay;
 }
};
inline bool putOutgoing(Conversation::Event e){
 if(e.bytes)e.hash=Audio::checksum(e.data,e.bytes);
 if(!alive(e.generation))return false;if(!outgoing.push(e)){notePrimary(912);return false;}
 maximum(outgoingHigh,uint32_t(outgoing.size()));return true;
}
inline bool putIncoming(Conversation::Event e){
 if(e.bytes)e.hash=Audio::checksum(e.data,e.bytes);
 if(!incoming.push(e)){notePrimary(912);return false;}maximum(incomingHigh,uint32_t(incoming.size()));return true;
}
inline void memoryStats(Audio::Stats& s){
 constexpr uint32_t caps=MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT;
 int32_t stack=int32_t(uxTaskGetStackHighWaterMark(nullptr)),free=int32_t(heap_caps_get_free_size(caps)),largest=int32_t(heap_caps_get_largest_free_block(caps));
 if(s.stackMin<0||stack<s.stackMin)s.stackMin=stack;
 if(s.freeInternal<0||free<s.freeInternal)s.freeInternal=free;
 if(s.largest<0||largest<s.largest)s.largest=largest;
}
inline void metricSnapshot(uint32_t generation,uint8_t phase){
 MetricFrame frame{generation,phase,job.settings,audioStats};xQueueOverwrite(metrics,&frame);
}


inline void audioSession(uint32_t generation){
 using namespace Tamagotchi;using namespace Conversation;
 PowerManagement::PerformanceLease performance;
 uint8_t ownerLevel=Conversation::selectedOwnerLevel(voiceLevel,generation,true,job.level);
 uint8_t error=0;int detail=0;notePrimary(detail);Resources resources;ResourceIO resourceIO;
 audioStats={};audioStats.measured=true;audioStats.configHz=uint32_t(configTICK_RATE_HZ);audioStats.tickUs=1000000u/uint32_t(configTICK_RATE_HZ);
 audioStats.actualCore=int32_t(xPortGetCoreID());
 auto run=[&]{
  if(!performance.held()){error=7;detail=901;notePrimary(detail);return;}
  auto initialized=resources.initialize(resourceIO,[&]{return alive(generation);},ownerLevel);
  if(initialized==InitOutcome::Cancelled)return;
  if(initialized!=InitOutcome::Ready){error=7;detail=initialized==InitOutcome::Codec?902:initialized==InitOutcome::Audio?(prepareError?prepareError:903):904;return;}
  audioStats.sourceSamples=0;
  audioStats.packetBankHash=0;
  memoryStats(audioStats);audioReady.store(generation,std::memory_order_release);
  Playout playout;
  auto configure=[&]{playout.chunk=job.settings.chunk;playout.guardMs=job.settings.guardMs;playout.tailTarget=job.settings.tailSamples;playout.volume=ownerLevel;};
  configure();AudioIO io{generation,&playout};Audio::Schedule schedule;Audio::Segments segments;
  Event event,turn;uint32_t turnEpoch=0,expected=1,micSequence=0,lastRead=micros(),lastSnapshot=millis();
  uint32_t emptyAt=0;bool emptyActive=false,listenSent=false;
  int16_t mic[256],decoded[960];MicFrame capture;FreshRx fresh;
  const bool voiceMode=job.settings.source==Audio::Source::Voice;VoiceGate voice;
  if(voiceMode)voice.begin(generation,millis());
  auto canCapture=[&]{return voiceMode&&alive(generation)&&voice.capture(wanted.load(),listenEpoch.load(),mediaEpoch.load(),outputPending.load());};

  auto freshBegin=[&]{capture.clear();if(job.settings.rx)fresh.begin(millis());else fresh.active=false;};
  if(!voiceMode)freshBegin();
  while(alive(generation)&&!error){
   uint32_t loopAt=micros();
   auto active=[&]{return alive(generation)&&!error;};

   Audio::Settings iteration=job.settings;
   if(voiceMode)iteration.rx=uint8_t(voice.rxBatch(wanted.load(),listenEpoch.load(),mediaEpoch.load(),outputPending.load()));
   bool okay=Audio::cycle(iteration,schedule,audioStats,[]{return micros();},active,
    [&]{

     bool worked=false;
     if(!Conversation::ordinaryVolumeStep(voiceLevel,generation,true,playout,io,ownerLevel,millis())){error=7;detail=906;notePrimary(detail);return false;}
     if(voiceMode){
      uint32_t epoch=mediaEpoch.load();
      if(outputPending.load()&&epoch&&epoch!=voice.turn){
       if(!voice.output(generation,epoch)){error=11;detail=911;notePrimary(detail);return false;}
       capture.clear();micSequence=0;
      }
      if(voice.listen(wanted.load(),listenEpoch.load(),epoch,outputPending.load())){
       capture.fence(listenEpoch.load());micSequence=0;audioPhase.store(3);
      }
     }
     if(playout.speaking&&turnEpoch!=mediaEpoch.load()){
      if(!io.cleanup()){error=7;detail=905;notePrimary(detail);return false;}playout=Playout{};configure();if(!voiceMode)freshBegin();
     }
     for(unsigned i=0;i<4&&playout.cursor==960&&active();++i){
      if(!incoming.pop(event))break;worked=true;
      if(!accepts(event,generation,wanted.load(),sessionStop.load(),fatal.load())||event.epoch!=mediaEpoch.load())continue;
      if(event.kind==EventKind::Start){
       if(playout.speaking){error=11;detail=911;notePrimary(detail);break;}
       turn=event;turnEpoch=event.epoch;expected=1;
       if(voiceMode){
        capture.clear();micSequence=0;
        if(!voice.output(generation,turnEpoch)){error=11;detail=911;notePrimary(detail);break;}
       }else freshBegin();
       if(!active()||!playout.begin(io,millis(),ownerLevel)){error=7;detail=907;notePrimary(detail);break;}
       configure();audioPhase.store(4);
      }else if(event.kind==EventKind::Data||event.kind==EventKind::Pcm){
       if(!playout.speaking||playout.ordinaryStop||!event.bytes||event.bytes>sizeof(event.data)){error=11;detail=911;notePrimary(detail);break;}
       const auto read=Audio::mediaFrame(event,generation,wanted.load(),turnEpoch,sessionStop.load(),fatal.load(),expected,decoded,audioStats,
        [&](const uint8_t* bytes,size_t count,int16_t* pcm,size_t capacity){return codec.decode(bytes,count,pcm,capacity);},[]{return micros();});
       if(read==Audio::MediaRead::Stale)continue;
       if(read!=Audio::MediaRead::Ready){
        error=read==Audio::MediaRead::Decode?7:11;detail=read==Audio::MediaRead::Decode?908:923;notePrimary(detail);break;
       }
       if(job.settings.source==Audio::Source::Opus)audioStats.codecPadInputSamples+=960-event.mediaSamples;
       if(!playout.load(decoded,Audio::outputSamples(job.settings.source,event.mediaSamples))){error=7;detail=908;notePrimary(detail);break;}
      }else if(event.kind==EventKind::Stop){
       if(!playout.speaking||std::strcmp(turn.response,event.response)||std::strcmp(turn.playback,event.playback)){error=11;detail=911;notePrimary(detail);break;}
       playout.stop();
      }else if(event.kind==EventKind::Flush){
       if(voiceMode){voice.abort();error=4;detail=931;notePrimary(detail);break;}
       if(!io.cleanup()){error=7;detail=905;notePrimary(detail);break;}playout=Playout{};configure();freshBegin();audioPhase.store(3);
      }
     }
     uint32_t epoch=listenEpoch.load();
     if(!voiceMode&&capture.fence(epoch)){micSequence=0;freshBegin();}
     playout.mediaEnabled=Audio::prebufferReady(job.settings.source,incoming.size()+1,job.settings.prebuffer,stopEpoch.load()==turnEpoch,io.span.active);
     bool empty=playout.speaking&&!playout.ordinaryStop&&!playout.priming&&playout.cursor==960&&incoming.empty();
     if(empty&&!emptyActive){emptyAt=micros();emptyActive=true;}
     if(emptyActive){uint32_t dt=uint32_t(micros()-emptyAt);if(dt>audioStats.emptyUs)audioStats.emptyUs=dt;if(!empty)emptyActive=false;}
     return worked;
    },

    [&]{
     if(voiceMode&&!voice.rxBatch(wanted.load(),listenEpoch.load(),mediaEpoch.load(),outputPending.load()))return 0;
     if(voiceMode&&voice.expired(millis())){error=7;detail=914;notePrimary(detail);return -1;}
     size_t got=0;uint32_t at=micros();if(audioStats.rxCalls){uint32_t gap=uint32_t(at-lastRead);if(gap>audioStats.rxGapUs)audioStats.rxGapUs=gap;}
     lastRead=at;++audioStats.rxCalls;
     auto status=audio.readMicMono(mic,256,got,0);
     if((status!=DeviceAudio::Status::Ok&&status!=DeviceAudio::Status::TimedOut)||got>256){++audioStats.rxErrors;error=7;detail=910;notePrimary(detail);return -1;}
     if(voiceMode&&voice.draining()){
      capture.clear();voice.observeFresh(got);return int(got);
     }
     if(!voiceMode){if(fresh.active)fresh.observe(got);capture.clear();return int(got);}
     if(!canCapture()){capture.clear();return int(got);}
     uint32_t epoch=listenEpoch.load();
     for(size_t i=0;i<got;++i){
      if(!canCapture()||epoch!=listenEpoch.load()){capture.clear();break;}
      if(capture.feed(mic[i])){
       Event packet;packet.generation=generation;packet.epoch=epoch;packet.kind=EventKind::Data;packet.sequence=++micSequence;size_t bytes=0;
       if(!canCapture()||epoch!=listenEpoch.load()){capture.clear();break;}
       uint32_t began=micros();
       bool good=codec.encode(capture.samples,960,packet.data,sizeof(packet.data),bytes);
       uint32_t dt=uint32_t(micros()-began);if(dt>audioStats.encodeUs)audioStats.encodeUs=dt;
       if(!good){error=7;detail=902;notePrimary(detail);return -1;}
       packet.bytes=uint16_t(bytes);
       // An already-running bounded codec call cannot be preempted. Reject its
       // result if tts/start closed the gate during the call.
       if(canCapture()&&epoch==listenEpoch.load()&&!putOutgoing(packet)){error=7;detail=912;notePrimary(detail);return -1;}
      }
     }
     return int(got);
    },
    [&]{

     if(voiceMode){
      if(voice.expired(millis())){error=7;detail=914;notePrimary(detail);return Audio::TxWork{};}
      if(voice.draining()&&!voice.fresh.active){
       bool initial=voice.turn==0;
       if(!voice.finishFresh(
        [&]{capture.clear();if(!alive(generation))return false;if(!codec.resetEncoder()){error=7;detail=902;notePrimary(detail);return false;}return true;},
        [&]{
         if(!alive(generation)||mediaEpoch.load()!=voice.turn)return false;
         freshReadyTurn.store(voice.turn,std::memory_order_release);
         freshReadyGeneration.store(generation,std::memory_order_release);
         Event message=turn;message.generation=generation;message.epoch=voice.turn;
         message.kind=initial?EventKind::Listen:EventKind::Resolution;
         return putOutgoing(message);
        })){if(!error){error=7;detail=914;notePrimary(detail);}return Audio::TxWork{};}
      }
     }else if(fresh.expired(millis())){error=7;detail=914;notePrimary(detail);return Audio::TxWork{};}
     Audio::Segment segment=Audio::Segment::Idle;
     if(playout.speaking){
      if(playout.priming&&uint32_t(millis()-playout.primeAt)<playout.guardMs)segment=Audio::Segment::Guard;
      else if(playout.tail||(playout.ordinaryStop&&playout.cursor==960&&incoming.empty()))segment=Audio::Segment::Padding;
      else if(!io.span.active&&(!playout.mediaEnabled||playout.cursor==960))segment=Audio::Segment::Prebuffer;
      else segment=Audio::Segment::Media;
     }
     segments.enter(segment,micros(),audioStats);
     io.lastWait=0;
     auto step=playout.tick(io,millis(),incoming.empty(),[&]{return active()&&turnEpoch==mediaEpoch.load();});
     if(step==Playout::Step::Failed&&active()){error=7;detail=915;notePrimary(detail);}

     if(step==Playout::Step::Complete){
      if(voiceMode){
       capture.clear();
       if(!voice.cleaned(generation,turnEpoch,millis())){error=11;detail=911;notePrimary(detail);}
      }else{
       Event resolution=turn;resolution.kind=EventKind::Resolution;
       if(!putOutgoing(resolution)){error=7;detail=912;notePrimary(detail);}freshBegin();audioPhase.store(3);
      }
     }
     return Audio::TxWork{step==Playout::Step::Written,io.lastWait};
    },
    [](uint32_t ticks){vTaskDelay(ticks);});
   uint32_t now=millis();
   
   audioStats.inHigh=incomingHigh.load();audioStats.outHigh=outgoingHigh.load();
   if(uint32_t(now-lastSnapshot)>=250){
    MetricFrame frame{generation,audioPhase.load(),job.settings,audioStats};
    frame.stats.mediaUs+=io.span.pending(micros());
    xQueueOverwrite(metrics,&frame);lastSnapshot=now;
   }
   uint32_t loopUs=uint32_t(micros()-loopAt),sleepUs=schedule.lastSleepUs;
   if(loopUs>=sleepUs&&loopUs-sleepUs>audioStats.loopUs)audioStats.loopUs=loopUs-sleepUs;
   if(!okay)break;
  }
  if(voiceMode)voice.abort();segments.enter(Audio::Segment::Idle,micros(),audioStats);io.endMedia();
 };
 run();
 if(error){notePrimary(detail);audioError.store(error);audioDetail.store(detail);sessionStop.store(true);}
 bool clean=resources.cleanup(resourceIO,[]{vTaskDelay(pdMS_TO_TICKS(20));});
 if(!clean){
  failures.cleanup(909);fatal.store(true);audioStats.primaryCode=uint32_t(failures.primary());audioStats.cleanupCode=uint32_t(failures.cleanup());memoryStats(audioStats);audioStats.primaryCode=uint32_t(failures.primary());audioStats.cleanupCode=uint32_t(failures.cleanup());finalStats=audioStats;metricSnapshot(generation,0);audioDone.store(generation,std::memory_order_release);
  while(networkClosed.load()!=generation)vTaskDelay(pdMS_TO_TICKS(20));
  while(true)vTaskDelay(pdMS_TO_TICKS(1000));
 }
}
inline void audioWorker(void*){
 uint32_t generation=job.generation;
 audioSession(generation); // Session resources, PCM and PerformanceLease gone
 memoryStats(audioStats);audioStats.inHigh=incomingHigh.load();audioStats.outHigh=outgoingHigh.load();audioStats.checksumErrors+=checksumFailures.load();audioStats.orderErrors+=orderFailures.load();
 finalStats=audioStats;metricSnapshot(generation,0);
 audioDone.store(generation,std::memory_order_release);
#if INCLUDE_vTaskSuspend == 1
 vTaskSuspend(nullptr); // network owner deletes only after observing Suspended
#endif
 while(true)vTaskDelay(pdMS_TO_TICKS(1000));
}
inline bool launchAudio(){
#if INCLUDE_vTaskSuspend == 1 && INCLUDE_eTaskGetState == 1
 if(audioTask||fatal.load())return false;
 audioDone.store(0);audioReady.store(0);networkClosed.store(0);finalStats={};prepareError=0;
 return xTaskCreatePinnedToCore(audioWorker,"kibi_voice_audio",65536,nullptr,1,&audioTask,job.settings.core)==pdPASS;
#else
 return false;
#endif
}
inline bool retireAudio(){
 uint32_t at=millis();
 while(audioDone.load(std::memory_order_acquire)!=activeGeneration&&uint32_t(millis()-at)<3000)vTaskDelay(pdMS_TO_TICKS(10));
 if(audioDone.load()!=activeGeneration||fatal.load()){if(!failures.cleanup())failures.cleanup(929);fatal.store(true);return false;}
#if INCLUDE_vTaskSuspend == 1 && INCLUDE_eTaskGetState == 1
 at=millis();
 while(eTaskGetState(audioTask)!=eSuspended&&uint32_t(millis()-at)<100)vTaskDelay(1);
 if(eTaskGetState(audioTask)!=eSuspended){failures.cleanup(930);fatal.store(true);return false;}
 vTaskDelete(audioTask);audioTask=nullptr;return true;
#else
 failures.cleanup(930);fatal.store(true);return false;
#endif
}
inline void networkConversation(){
 using namespace Tamagotchi;using namespace Conversation;
 // Network is the sole owner of TLS, tokens, diagnostics and network gate.
 PowerManagement::PerformanceLease performance;
 NetworkGate::Lease gate(NetworkGate::Priority::Voice,1000);
 bool audioStarted=false;uint8_t error=0;int terminal=0;notePrimary(terminal);
 if(!performance.held()||!gate){diagnostic.stage=Pairing::Stage::Voice;diagnostic.code=Pairing::Code::Local;diagnostic.detail=901;publish(0,7);return;}
 if(!current()||!ensureClock())return;
 if(!deviceToken[0]){pair();return;}
 incoming.attach(incomingStorage);outgoing.attach(outgoingStorage);
 listenEpoch.store(0);mediaEpoch.store(0);maxRxGap.store(0);maxNetworkMs.store(0);
 audioError.store(0);audioDetail.store(0);audioPhase.store(0);outputPending.store(false);freshReadyGeneration.store(0);freshReadyTurn.store(0);stopEpoch.store(0);checksumFailures.store(0);orderFailures.store(0);incomingHigh.store(0);outgoingHigh.store(0);
 diagnostic={};diagnostic.stage=Pairing::Stage::Voice;
 {
 WebSocket ws;
 auto run=[&]{
  if(!ws.open()){error=8;terminal=diagnostic.detail;notePrimary(terminal);return;}
  if(!current())return;
  if(!ws.text(kDeviceHello)){error=4;terminal=921;notePrimary(terminal);return;}
  uint32_t began=millis();bool hello=false,sessionGreeting=false;DownlinkFormat downlink=DownlinkFormat::Invalid;
  while(current()&&uint32_t(millis()-began)<12000){
   int r=ws.receive();if(r<0){terminal=ws.failure;notePrimary(terminal);break;}
   if(r==1){
    JsonDocument doc;
    if(ws.kind!=1||deserializeJson(doc,ws.message,ws.size,DeserializationOption::NestingLimit(8))||
       std::strcmp(doc["type"]|"","hello")){terminal=911;notePrimary(terminal);break;}
    downlink=selectDownlink(doc.as<JsonVariantConst>(),true);
    if(downlink==DownlinkFormat::Invalid){terminal=911;notePrimary(terminal);break;}
    auto greetingFeature=doc["features"]["session_greeting"];
    sessionGreeting=greetingNegotiated(greetingFeature);
    hello=true;break;
   }
   vTaskDelay(1);
  }
  if(!hello){error=4;if(!terminal)terminal=916;notePrimary(terminal);return;}
  if(!current())return;
  
  if(!launchAudio()){error=7;terminal=925;notePrimary(terminal);return;}
  audioStarted=true;
  SessionStart startup;startup.begin(activeGeneration,sessionGreeting);
  if(sessionGreeting)audioPhase.store(6,std::memory_order_release);
  bool speaking=false,ordinary=false,listening=false;uint32_t epoch=0,listenCounter=0,sequence=0,micEpoch=0,micExpected=1,sessionAt=millis();
  char response[129]={},playback[129]={};uint8_t lastPhase=0;
  Event event;
  while(current()){
   if(!ipReady()){error=1;terminal=918;notePrimary(terminal);break;}
   if(audioError.load()){error=audioError.load();terminal=audioDetail.load();break;}
   // Bounded receive batch. Control frames count as activity and get pong here.
   uint32_t batchAt=millis();
   for(unsigned count=0;count<8&&current()&&uint32_t(millis()-batchAt)<4;++count){
    uint32_t at=millis();int r=ws.receive();maximum(maxNetworkMs,uint32_t(millis()-at));
    if(r<0){error=4;terminal=ws.failure;notePrimary(terminal);break;}
    if(!r){if(!ws.used)break;continue;}
    Event in;in.generation=activeGeneration;in.epoch=epoch;
    if(ws.kind==2){
     if(!speaking||ordinary||!downlinkEvent(downlink,ws.message,ws.size,activeGeneration,epoch,++sequence,in)){error=11;terminal=911;notePrimary(terminal);break;}
    }else{
     JsonDocument doc;
     if(deserializeJson(doc,ws.message,ws.size,DeserializationOption::NestingLimit(8))){error=11;terminal=911;notePrimary(terminal);break;}
     const char* type=doc["type"]|"";
     if(!std::strcmp(type,"error")){error=8;terminal=920;notePrimary(terminal);break;}
     if(std::strcmp(type,"tts"))continue;
     const char* state=doc["state"]|"";
     if(!std::strcmp(state,"start")){
      if(speaking){error=11;terminal=911;notePrimary(terminal);break;}
      const char* rid=doc["response_id"]|"",*pid=doc["playback_id"]|"";
      if(!safe(rid,128)||!safe(pid,128)){error=11;terminal=911;notePrimary(terminal);break;}
      std::snprintf(response,sizeof(response),"%s",rid);std::snprintf(playback,sizeof(playback),"%s",pid);
      outputPending.store(true,std::memory_order_release);listenEpoch.store(0);freshReadyGeneration.store(0);freshReadyTurn.store(0);
      in.kind=EventKind::Start;in.epoch=++epoch;sequence=0;mediaEpoch.store(epoch);
      listening=false;listenEpoch.store(0);speaking=true;ordinary=false;
     }else if(!std::strcmp(state,"stop")){
      if(doc["flush"]|false){
       outputPending.store(true);listenEpoch.store(0);freshReadyGeneration.store(0);
       sessionStop.store(true);error=4;terminal=931;notePrimary(terminal);break;
      }else{
       if(!speaking||ordinary||std::strcmp(doc["response_id"]|"",response)||
          std::strcmp(doc["playback_id"]|"",playback)||(doc["sample_rate"]|0)!=16000){error=11;terminal=911;notePrimary(terminal);break;}
       in.kind=EventKind::Stop;ordinary=true;stopEpoch.store(epoch);
      }
     }else continue;
     std::snprintf(in.response,sizeof(in.response),"%s",response);std::snprintf(in.playback,sizeof(in.playback),"%s",playback);
    }
    if(!putIncoming(in)){error=7;terminal=912;notePrimary(terminal);break;}
   }
   if(error)break;
   batchAt=millis();
   for(unsigned count=0;count<4&&current()&&uint32_t(millis()-batchAt)<4;++count){
    if(!outgoing.pop(event))break;
    if(!accepts(event,activeGeneration,wanted.load(),sessionStop.load(),fatal.load()))continue;
    if(event.kind==EventKind::Data){
     if(!micPacketAllowed(event,activeGeneration,wanted.load(),listenEpoch.load(),listening,outputPending.load(),sessionStop.load()))continue;
     if(event.epoch!=micEpoch){micEpoch=event.epoch;micExpected=1;}
     if(event.sequence!=micExpected++){orderFailures.fetch_add(1);error=11;terminal=923;notePrimary(terminal);break;}
     if(!event.bytes||event.bytes>1275||event.hash!=Audio::checksum(event.data,event.bytes)){checksumFailures.fetch_add(1);error=11;terminal=923;notePrimary(terminal);break;}
     if(!ws.send(2,event.data,event.bytes)){error=4;terminal=921;notePrimary(terminal);break;}
    }else if(event.kind==EventKind::Listen){
     if(startup.sent)continue;
     if(speaking||listening||freshReadyGeneration.load(std::memory_order_acquire)!=activeGeneration||freshReadyTurn.load()!=0){error=11;terminal=911;notePrimary(terminal);break;}
     const auto started=startup.initial(event.generation,true,[&](const char* request){return ws.text(request);},[]{return current();});
     if(!current())break;
     if(started==SessionStart::Outcome::Failed){error=4;terminal=921;notePrimary(terminal);break;}
     if(started==SessionStart::Outcome::Ignored)continue;
     freshReadyGeneration.store(0);
     if(started==SessionStart::Outcome::Listening){
      listening=true;listenEpoch.store(++listenCounter,std::memory_order_release);outputPending.store(false,std::memory_order_release);audioPhase.store(3);
     }else{
      listening=false;listenEpoch.store(0,std::memory_order_release);audioPhase.store(6,std::memory_order_release);
     }
    }else if(event.kind==EventKind::Resolution){
     // Audio emits this only after successful local terminal cleanup.
     if(!resolutionAllowed(true,ordinary,response,playback,event,activeGeneration,epoch,freshReadyGeneration.load(std::memory_order_acquire),freshReadyTurn.load())){error=11;terminal=911;notePrimary(terminal);break;}
     JsonDocument resolution;resolution["type"]="playback_resolution";resolution["state"]="rejected";
     resolution["response_id"]=response;resolution["playback_id"]=playback;
     char json[512];serializeJson(resolution,json,sizeof(json));
     const bool resolved=sendCurrent([&]{return ws.text(json);},[]{return current();});
     if(!current())break;
     if(!resolved){error=4;terminal=921;notePrimary(terminal);break;}
     startup.resolved();speaking=ordinary=false;listening=true;listenEpoch.store(++listenCounter,std::memory_order_release);outputPending.store(false,std::memory_order_release);freshReadyGeneration.store(0);
    }
   }
   if(error)break;
   uint8_t phase=audioPhase.load();
   if(phase&&phase!=lastPhase){diagnostic={};diagnostic.stage=Pairing::Stage::Voice;publish(phase);lastPhase=phase;}
   if(uint32_t(millis()-ws.activityAt)>=120000){error=4;terminal=916;notePrimary(terminal);break;}
   
   if(uint32_t(millis()-sessionAt)>=900000){error=4;terminal=919;notePrimary(terminal);break;}
   vTaskDelay(1);
  }
 };
 run();
 sessionStop.store(true);outputPending.store(true);listenEpoch.store(0);freshReadyGeneration.store(0);
 // Close by the network owner BEFORE waiting for audio or entering quarantine.
 ws.client.stop();networkClosed.store(activeGeneration,std::memory_order_release);
 } // WebSocket/TLS allocations destroyed here.

 if(audioStarted){retireAudio();}else audioDone.store(activeGeneration);
 if(audioError.load()){if(!error)error=audioError.load();if(!terminal)terminal=audioDetail.load();}
 if(failures.primary())terminal=failures.primary();
 if(fatal.load()){runFailed=true;diagnostic={};publish(0,9);return;}
 if(terminal==924&&!error){runFailed=false;return;}
 runFailed=true;
 if(wanted.load()==activeGeneration){
  if(!error){error=4;terminal=913;notePrimary(terminal);}
  if(terminal){diagnostic={};diagnostic.stage=Pairing::Stage::Voice;diagnostic.detail=terminal;
   diagnostic.code=terminal==916?Pairing::Code::Timeout:terminal==917||terminal==918||terminal==921?Pairing::Code::Link:(terminal==913||terminal==931)?Pairing::Code::Cancelled:Pairing::Code::Local;}
  publish(0,error);
 }
}

inline void worker(void*){
 {
  Preferences prefs;if(prefs.begin(Internal::configuration.storage,true)){
   String saved=prefs.getString("binding","");prefs.end();
   JsonDocument binding;
   if(saved.length()<=1024&&!deserializeJson(binding,saved,DeserializationOption::NestingLimit(4))&&!binding.overflowed()&&binding.is<JsonObject>()){
    const char* token=binding["token"]|"",*base=binding["apiBase"]|"";
    if(Pairing::bindingMatches(base,token,Internal::configuration.endpoint))std::snprintf(deviceToken,sizeof(deviceToken),"%s",token);
   }
  }
 }
 publish(0);
 Command command{};
 while(true){
  if(xQueueReceive(commands,&command,portMAX_DELAY)==pdTRUE){
   activeGeneration=command.generation;job=command;sessionStop.store(false);diagnostic={};finalStats={};firstWriteFailure={};runFailed=true;failures.reset();
   if(command.resetPairing){
    // This command is admitted only after both previous owners have retired.
    // HTTP 401/403 never reaches this branch or erases an existing binding.
    sessionStop.store(true);diagnostic.stage=Pairing::Stage::Store;Preferences prefs;
    bool opened=prefs.begin(Internal::configuration.storage,false),cleared=opened&&Pairing::clearBinding(prefs);
    if(opened)prefs.end();
    if(cleared)std::memset(deviceToken,0,sizeof(deviceToken));
    else{diagnostic.code=Pairing::Code::Storage;diagnostic.detail=3;}
    publish(0,cleared?0:6);networkClosed.store(activeGeneration);busy.store(false,std::memory_order_release);continue;
   }
   if(!Audio::valid(job.settings)){diagnostic={};publish(0,7);busy.store(false);continue;}
   networkConversation();
   if(wanted.load()==activeGeneration&&!fatal.load()&&!runFailed){diagnostic={};publish(0);}
   networkClosed.store(activeGeneration);if(!fatal.load())busy.store(false,std::memory_order_release);
  }
 }
}
inline bool startWorker(){
 if(attempted)return commands&&results&&metrics&&!fatal.load();attempted=true;
 WiFi.onEvent(observedWifi,ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
 incomingStorage=static_cast<Conversation::Event*>(heap_caps_calloc(32,sizeof(Conversation::Event),MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT));
 outgoingStorage=static_cast<Conversation::Event*>(heap_caps_calloc(8,sizeof(Conversation::Event),MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT));
 commands=xQueueCreate(1,sizeof(Command));results=xQueueCreate(8,sizeof(Result));metrics=xQueueCreate(1,sizeof(MetricFrame));
 if(!commands||!results||!metrics||!incomingStorage||!outgoingStorage){fatal.store(true);return false;}
 for(size_t i=0;i<32;++i)new(incomingStorage+i) Conversation::Event;
 for(size_t i=0;i<8;++i)new(outgoingStorage+i) Conversation::Event;
 incoming.attach(incomingStorage);outgoing.attach(outgoingStorage);
 // Two persistent owners. Opus keeps the reviewed 64 KiB INTERNAL stack;
 // TLS also gets 64 KiB. No smaller-stack or PSRAM-stack fallback.

 TaskHandle_t networkTask=nullptr;
 if(xTaskCreatePinnedToCore(worker,"kibi_voice_net",65536,nullptr,1,&networkTask,0)!=pdPASS){fatal.store(true);return false;}
 return true;
}
}
#endif

// Call begin/poll from the first device Feature::tick, after stock platform boot.
// begin copies public configuration only; poll creates the persistent worker.
// start is a deliberate user action; it may first show a short pairingCode.
// stop cancels by generation; poll settles Stopping after both owners retire.
// Volume is 5..100 in steps of five, default 100, with no benchmark profiles.
// The retained client profile is 250ms guard, 256-sample pump, 6x60ms prebuffer,
// 128-sample bounded driver writes; mic analysis is disabled during TTS.
// safeSnapshot never contains the NVS binding, poll credential or device token.
// resetPairing is an explicit confirmed user action: stop first, poll until
// owners are idle, then request it. true means queued, not already erased.
// It removes only this configured namespace's binding; server device revocation
// remains a separate cabinet action. Do not invoke it automatically on 401/403.
inline bool begin(const Config& value=Config{}){
 Internal::Configuration checked;if(!Internal::validConfig(value,checked))return false;
 if(Internal::snapshot.configured)return Internal::sameConfig(Internal::configuration,checked);
 Internal::configuration=checked;Internal::snapshot.configured=true;
#ifdef ARDUINO
 #if defined(KIBI_DEVICE_HAS_SPEAKER) && KIBI_DEVICE_HAS_SPEAKER == 1
 Internal::snapshot.hardwareAvailable=true;Internal::snapshot.state=State::Idle;
 #else
 Internal::snapshot.state=State::Unavailable;
 #endif
#else
 Internal::snapshot.state=State::Unavailable;
#endif
 return true;
}
inline bool setVolume(uint8_t percent){
 if(!Core::Conversation::VoiceLevel::valid(percent)||!Internal::snapshot.configured)return false;
#ifdef ARDUINO
 if(Detail::busy.load(std::memory_order_acquire)&&!Detail::voiceLevel.request(Internal::snapshot.generation,percent))return false;
#endif
 Internal::snapshot.volume=percent;Internal::snapshot.volumeApplied=false;return true;
}
inline bool start(){
 auto& state=Internal::snapshot;if(!state.configured||!state.hardwareAvailable||state.running||state.state==State::Quarantined||state.state==State::Stopping||state.state==State::ResettingPairing)return false;
#ifdef ARDUINO
 if(!Detail::commands||Detail::fatal.load())return false;
 bool expected=false;if(!Detail::busy.compare_exchange_strong(expected,true))return false;
 ++state.generation;if(!state.generation)++state.generation;
 Detail::wanted.store(state.generation);Detail::Command command;command.generation=state.generation;command.level=state.volume;command.settings.level=state.volume;
 if(!Detail::voiceLevel.begin(command.generation,command.level)||xQueueSend(Detail::commands,&command,0)!=pdTRUE){Detail::busy.store(false);Detail::fatal.store(true);state.state=State::Quarantined;state.error=9;return false;}
 Internal::clearGenerationEvidence(state);
 state.running=true;state.state=State::Connecting;state.error=0;state.diagnostic={};state.pairingCode[0]=0;return true;
#else
 state.state=State::Unavailable;return false;
#endif
}
inline void stop(){
 auto& state=Internal::snapshot;
 if(state.state==State::ResettingPairing||state.state==State::Quarantined)return;
#ifdef ARDUINO
 if(state.running||Detail::busy.load(std::memory_order_acquire)){
  Internal::advanceCancellationGeneration(state);Detail::wanted.store(state.generation);
 }
#endif
 state.running=false;state.error=0;state.diagnostic={};state.pairingCode[0]=0;
 if(state.state==State::Error)state.state=State::Idle;
}
inline bool resetPairing(){
 auto& state=Internal::snapshot;
 if(!state.configured||!state.hardwareAvailable||state.running||state.state==State::Stopping||state.state==State::Quarantined||state.state==State::ResettingPairing)return false;
#ifdef ARDUINO
 if(!Detail::commands||Detail::fatal.load()||Detail::audioTask)return false;
 bool expected=false;if(!Detail::busy.compare_exchange_strong(expected,true))return false;
 ++state.generation;if(!state.generation)++state.generation;Detail::wanted.store(state.generation);
 Detail::Command command;command.generation=state.generation;command.resetPairing=true;
 if(xQueueSend(Detail::commands,&command,0)!=pdTRUE){Detail::busy.store(false);Detail::fatal.store(true);state.state=State::Quarantined;state.error=9;return false;}
 Internal::clearGenerationEvidence(state);
 state.state=State::ResettingPairing;state.error=0;state.diagnostic={};state.pairingCode[0]=0;return true;
#else
 return false;
#endif
}
inline bool poll(uint32_t now){
 (void)now;auto& state=Internal::snapshot;
 if(!state.configured||!state.hardwareAvailable)return false;
#ifdef ARDUINO
 Detail::baseSntpStarted.store(Tamagotchi::WifiDetail::ntpStarted,std::memory_order_release);
 if(Detail::fatal.load()||!Detail::startWorker()){
  state.state=State::Quarantined;state.running=false;state.error=9;state.primaryCode=Detail::failures.primary();state.cleanupCode=Detail::failures.cleanup();return true;
 }
 bool changed=false;Detail::MetricFrame frame;
 if(xQueueReceive(Detail::metrics,&frame,0)==pdTRUE&&frame.generation==state.generation){
  state.writeErrors=frame.stats.writeErrors;state.writeTimeouts=frame.stats.writeTimeouts;state.metricsKnown=true;changed=true;
 }
 Detail::Result result;
 if(xQueueReceive(Detail::results,&result,0)==pdTRUE&&result.generation==state.generation){
  state.paired=result.paired;state.pairedKnown=true;state.error=result.error==2?0:result.error;state.diagnostic=result.diagnostic;
  if(result.error==2)state.diagnostic={};
  std::snprintf(state.pairingCode,sizeof(state.pairingCode),"%s",result.code);
  if(state.error){state.running=false;state.state=state.error==9?State::Quarantined:State::Error;}
  else switch(result.phase){case 0:state.running=false;state.state=State::Idle;break;case 1:state.state=State::Connecting;break;case 2:state.state=State::Pairing;break;case 3:state.state=State::Listening;break;case 4:state.state=State::Speaking;break;case 5:state.state=State::Stopping;break;case 6:state.state=State::Greeting;break;default:state.state=State::Error;state.error=11;break;}
  changed=true;
 }
 uint8_t applied=0;state.volumeApplied=Detail::voiceLevel.applied(state.generation,applied)&&applied==state.volume;
 if(state.state==State::Stopping&&!Detail::busy.load(std::memory_order_acquire)&&uxQueueMessagesWaiting(Detail::results)==0){state.state=State::Idle;changed=true;}
 return changed;
#else
 return false;
#endif
}
inline Snapshot safeSnapshot(){return Internal::snapshot;}
} // namespace Kibi::XiaozhiClient
