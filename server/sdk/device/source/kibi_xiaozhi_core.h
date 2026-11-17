#pragma once
// Portable mechanics extracted from the latest user-approved working voice path.
// No UI, board identity, recordings, provider credentials or generated media.
// Source/host evidence is not physical verification of a new compiled artifact.
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <atomic>
#include <algorithm>
#ifdef ARDUINO
#include <ArduinoJson.h>
#endif
namespace Kibi::XiaozhiClient::Core {

struct Endpoint {char host[128]={},prefix[128]={},apiBase[264]={};};
// Configuration is chosen by trusted application code, never by a pairing reply.
inline bool parseApiBase(const char* url,Endpoint& out){
 if(!url||std::strncmp(url,"https://",8)||std::strlen(url)>255)return false;
 for(const unsigned char* p=reinterpret_cast<const unsigned char*>(url);*p;++p)
  if(*p<=32||*p>=127||*p=='\\'||*p=='?'||*p=='#'||*p=='@'||*p=='%')return false;
 const char* host=url+8;const char* slash=std::strchr(host,'/');
 size_t hostSize=slash?size_t(slash-host):std::strlen(host);if(!hostSize||hostSize>=sizeof(out.host))return false;
 if(host[0]=='.'||host[hostSize-1]=='.'||host[0]=='-'||host[hostSize-1]=='-')return false;
 for(size_t i=0;i<hostSize;++i)if(!((host[i]>='a'&&host[i]<='z')||(host[i]>='0'&&host[i]<='9')||host[i]=='.'||host[i]=='-'))return false;
 const char* path=slash?slash:"/";size_t n=std::strlen(path);if(n>=sizeof(out.prefix)-1)return false;
 if(std::strstr(path,"//"))return false;
 for(const char* p=path;*p;){const char* next=std::strchr(p+1,'/');size_t size=next?size_t(next-p-1):std::strlen(p+1);if((size==1&&p[1]=='.')||(size==2&&p[1]=='.'&&p[2]=='.'))return false;if(!next)break;p=next;}
 Endpoint value;std::memcpy(value.host,host,hostSize);std::memcpy(value.prefix,path,n);if(value.prefix[n-1]!='/')value.prefix[n++]='/';value.prefix[n]=0;
 int size=std::snprintf(value.apiBase,sizeof(value.apiBase),"https://%s%s",value.host,value.prefix);if(size<0||size_t(size)>=sizeof(value.apiBase))return false;
 out=value;return true;
}
inline bool matchesApiBase(const char* url,const Endpoint& configured){Endpoint candidate;return parseApiBase(url,candidate)&&!std::strcmp(candidate.apiBase,configured.apiBase);}

namespace Pairing {
enum class Stage:uint8_t {None,Wifi,Clock,Start,Poll,Store,Voice};
enum class Code:uint8_t {None,Link,Tls,Http,TooLarge,Read,Timeout,Json,Fields,Expired,Storage,Cancelled,Local};
struct Diagnostic {Stage stage=Stage::None;Code code=Code::None;int http=0,detail=0,tls=0,wifiStatus=-1,wifiMode=-1,reason=0,sntp=-1,sync=-1,attempt=0,waitSec=0;bool clockValid=false;};
inline const char* stageName(Stage s){switch(s){case Stage::Wifi:return "WIFI";case Stage::Clock:return "TIME";case Stage::Start:return "START";case Stage::Poll:return "POLL";case Stage::Store:return "SAVE";case Stage::Voice:return "VOICE";default:return "IDLE";}}
inline const char* codeName(Code c){switch(c){case Code::Link:return "CONNECT";case Code::Tls:return "TLS";case Code::Http:return "HTTP";case Code::TooLarge:return "SIZE";case Code::Read:return "READ";case Code::Timeout:return "TIMEOUT";case Code::Json:return "JSON";case Code::Fields:return "SCHEMA";case Code::Expired:return "EXPIRED";case Code::Storage:return "NVS";case Code::Cancelled:return "CANCEL";case Code::Local:return "LOCAL";default:return "OK";}}
inline bool opaque(const char* s,size_t limit){if(!s||!*s||std::strlen(s)>limit)return false;for(;*s;++s)if(uint8_t(*s)<32||uint8_t(*s)==127)return false;return true;}
inline bool secret(const char* s){if(!s||!*s||std::strlen(s)>512)return false;bool padding=false;int pads=0;for(;*s;++s){if(*s=='='){padding=true;if(++pads>2)return false;}else if(padding||!std::strchr("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~+/-",*s))return false;}return true;}
inline bool bindingMatches(const char* base,const char* token,const Endpoint& configured){return secret(token)&&matchesApiBase(base,configured);}
// Explicit local re-pair action only; never clear unrelated NVS or format it.
template<class Store> bool clearBinding(Store& store){return !store.isKey("binding")||(store.remove("binding")&&!store.isKey("binding"));}
inline bool iso(const char* s){
if(!s)return false;size_t n=std::strlen(s);if(n!=20&&(n<22||n>24))return false;
for(size_t i=0;i<19;++i){char expected=i==4||i==7?'-':i==10?'T':i==13||i==16?':':0;if(expected?s[i]!=expected:s[i]<'0'||s[i]>'9')return false;}
if(n==20)return s[19]=='Z';if(s[19]!='.'||s[n-1]!='Z')return false;for(size_t i=20;i<n-1;++i)if(s[i]<'0'||s[i]>'9')return false;return true;
}
inline bool pairingCode(const char* s){if(!s||std::strlen(s)!=9||s[4]!='-')return false;for(int i=0;i<9;++i)if(i!=4&&!std::strchr("ABCDEFGHJKLMNPQRSTUVWXYZ23456789",s[i]))return false;return true;}
struct Start {char id[257]={},pollToken[513]={},code[10]={};uint32_t intervalMs=3000;};
#ifdef ARDUINO
inline bool readStart(JsonObjectConst o,Start& out){
const char* id=o["pairingId"]|"";const char* token=o["pollToken"]|"";const char* code=o["code"]|"";
if(!opaque(id,256)||!secret(token)||!pairingCode(code)||!iso(o["expiresAt"]|"")||!o["intervalSeconds"].is<int>()||o["intervalSeconds"].as<int>()!=3)return false;
Start value;std::memcpy(value.id,id,std::strlen(id)+1);std::memcpy(value.pollToken,token,std::strlen(token)+1);std::memcpy(value.code,code,10);out=value;return true;
}
enum class Poll:uint8_t {Invalid,Pending,Paired};
inline Poll readPoll(JsonObjectConst o,const Endpoint& configured){
const char* state=o["status"]|"";
if(!std::strcmp(state,"pending"))return iso(o["expiresAt"]|"")?Poll::Pending:Poll::Invalid;
if(std::strcmp(state,"paired")||!secret(o["token"]|""))return Poll::Invalid;
 const char* base=o["apiBase"]|"";if(!matchesApiBase(base,configured))return Poll::Invalid;
auto device=o["device"].as<JsonObjectConst>();
if(!opaque(device["id"]|"",256)||!opaque(device["name"]|"",64))return Poll::Invalid;return Poll::Paired;
}
#endif
// The transport and its host regression tests share this decision. HTTP success
// never overrides failed body framing, overflow, timeout, or JSON validation.
inline Code bodyStatus(int actual,int expected,int announced,int received,size_t stored,bool overflow,bool timedOut){
if(actual!=expected)return Code::Http;
if(announced>4096||overflow)return Code::TooLarge;
if(timedOut)return Code::Timeout;
if(received<0||size_t(received)!=stored||(announced>=0&&size_t(announced)!=stored)||!stored)return Code::Read;
return Code::None;
}
#ifdef ARDUINO
inline Code decodeBody(const char* bytes,size_t length,JsonDocument& out){
out.clear();if(deserializeJson(out,bytes,length,DeserializationOption::NestingLimit(8))||out.overflowed()||!out.is<JsonObject>()){out.clear();return Code::Json;}return Code::None;
}
#endif
}

namespace ClockRecovery {
enum class Step:uint8_t {Network,Clock,Retry,Ready,Cancelled,NetworkTimeout,ClockTimeout,Inactive};
struct Budget {bool used=false;uint32_t at=0;bool allows(uint32_t now)const{return !used||uint32_t(now-at)>=30000;}void mark(uint32_t now){used=true;at=now;}};
struct Gate {
uint32_t began=0,networkAt=0,clockAt=0,lastRetry=0;bool initialized=false,wasOnline=false;uint8_t attempts=0;
Step step(uint32_t now,bool online,bool valid,bool baseStarted,bool sntpEnabled,bool cancelled,bool retryAllowed){
if(cancelled)return Step::Cancelled;
if(!initialized){initialized=true;began=networkAt=clockAt=now;wasOnline=online;}
if(online&&valid)return Step::Ready;
if(uint32_t(now-began)>=65000)return online?Step::ClockTimeout:Step::NetworkTimeout;
if(!online){if(wasOnline){networkAt=now;wasOnline=false;}return uint32_t(now-networkAt)>=15000?Step::NetworkTimeout:Step::Network;}
if(!wasOnline){wasOnline=true;clockAt=now;}
if(baseStarted&&uint32_t(now-clockAt)>=15000&&attempts<2&&retryAllowed&&(!attempts||uint32_t(now-lastRetry)>=30000)){
if(!sntpEnabled)return Step::Inactive;
++attempts;lastRetry=now;return Step::Retry;
}
return Step::Clock;
}
};
}

namespace VoiceOpen {
enum class Step:int {None=0,Connect=801,Cancel=802,Nonce=803,RequestSize=804,RequestWrite=805,Closed=806,HeaderTimeout=807,HeaderLimit=808,HttpStatus=809,Digest=810,Accept=811,Upgrade=812,Connection=813,Incomplete=814};
inline const char* name(Step s){switch(s){case Step::Connect:return "CONNECT";case Step::Cancel:return "CANCEL";case Step::Nonce:return "NONCE";case Step::RequestSize:return "REQUEST_SIZE";case Step::RequestWrite:return "REQUEST_WRITE";case Step::Closed:return "CLOSED";case Step::HeaderTimeout:return "HEADER_TIMEOUT";case Step::HeaderLimit:return "HEADER_LIMIT";case Step::HttpStatus:return "HTTP_STATUS";case Step::Digest:return "ACCEPT_DIGEST";case Step::Accept:return "ACCEPT_VALUE";case Step::Upgrade:return "UPGRADE";case Step::Connection:return "CONNECTION";case Step::Incomplete:return "INCOMPLETE";default:return "READY";}}
inline Pairing::Code code(Step s){
switch(s){case Step::Connect:case Step::Closed:return Pairing::Code::Link;
case Step::Cancel:return Pairing::Code::Cancelled;
case Step::HeaderTimeout:return Pairing::Code::Timeout;
case Step::HttpStatus:return Pairing::Code::Http;
case Step::HeaderLimit:return Pairing::Code::TooLarge;
case Step::RequestWrite:return Pairing::Code::Link;
case Step::Accept:case Step::Upgrade:case Step::Connection:case Step::Incomplete:return Pairing::Code::Fields;
default:return Pairing::Code::Local;}
}
inline Step responseEnd(bool active,size_t bytes,size_t capacity,bool terminated,bool statusLine101){
if(!active)return Step::Cancel;
if(!terminated){if(bytes>=capacity-1)return Step::HeaderLimit;return Step::HeaderTimeout;}
if(!statusLine101)return Step::HttpStatus;return Step::None;
}
inline Step acceptFlags(bool accepted,bool upgraded,bool connection,bool active){
if(!accepted)return Step::Accept;if(!upgraded)return Step::Upgrade;if(!connection)return Step::Connection;if(!active)return Step::Cancel;return Step::None;
}
inline Step writeResult(int size,size_t capacity,size_t written){
if(size<=0||size_t(size)>=capacity)return Step::RequestSize;
return written==size_t(size)?Step::None:Step::RequestWrite;
}
}

namespace Audio {
enum class Source:uint8_t {Pcm,Opus,Voice};
enum class Yield:uint8_t {Tick,Idle};
struct Settings {
 Source source=Source::Pcm;uint16_t chunk=256;uint8_t rx=1,core=0;
 Yield yield=Yield::Tick;uint16_t guardMs=180,tailSamples=1024;
 uint8_t prebuffer=1,limiter=0,profile=0,level=15;
};
inline bool valid(const Settings& s){
 return int(s.source)<=2&&(s.chunk==64||s.chunk==128||s.chunk==256)&&
 (s.rx==0||s.rx==1||s.rx==4)&&s.core<=1&&int(s.yield)<=1&&
 (s.guardMs==0||s.guardMs==80||s.guardMs==180||s.guardMs==300||(s.source==Source::Voice&&s.guardMs==250))&&
 (s.prebuffer==1||s.prebuffer==3||s.prebuffer==6)&&
 (s.tailSamples==512||s.tailSamples==1024)&&s.limiter<=2&&s.profile<=5&&(s.source==Source::Voice?(s.level>=5&&s.level<=100&&s.level%5==0):(s.level==5||s.level==10||s.level==15||s.level==20));
}
inline size_t outputSamples(Source source,size_t inputSamples){return source==Source::Opus?960:inputSamples;}
inline Settings ordinaryVoiceSettings(){
 Settings s;s.source=Source::Voice;s.chunk=256;s.rx=0;s.core=0;s.yield=Yield::Tick;
 s.guardMs=250;s.prebuffer=6;s.tailSamples=1024;s.limiter=0;s.profile=5;s.level=100;
 return s;
}
inline void putLE(uint8_t* out,int16_t sample){uint16_t v=uint16_t(sample);out[0]=uint8_t(v);out[1]=uint8_t(v>>8);}
inline int16_t getLE(const uint8_t* in){return int16_t(uint16_t(in[0])|(uint16_t(in[1])<<8));}
inline uint32_t checksum(const uint8_t* bytes,size_t size){uint32_t h=2166136261u;for(size_t i=0;i<size;++i)h=(h^bytes[i])*16777619u;return h;}
inline int16_t limit(int16_t sample,uint8_t level,uint32_t& hits){
 int32_t threshold=level==1?16422:level==2?8231:32768;
 if(int32_t(sample)>threshold){++hits;return int16_t(threshold);}
 if(int32_t(sample)<-threshold){++hits;return int16_t(-threshold);}
 return sample;
}
// Same scheduler is used by the device loop and fake DMA clock. Idle mode
// avoids an extra sleep after a blocking I/O call, but bounds CPU-only bursts.
struct Schedule {
 unsigned burst=0;uint32_t lastSleepUs=0;
 uint32_t pauseTicks(const Settings& s,uint32_t ioUs,uint32_t tickUs,bool worked){
  if(s.yield==Yield::Tick){burst=0;return 1;}
  if(ioUs>=tickUs){burst=0;return 0;}
  if(!worked||++burst>=4){burst=0;return 1;}return 0;
 }
};
struct Stats {
 bool measured=false;uint32_t txCalls=0,rxCalls=0,decodeCalls=0;uint32_t mediaSamples=0,silentSamples=0,guardSamples=0,padSamples=0,codecPadInputSamples=0,mediaUs=0;
 uint32_t txGapUs=0,txCallUs=0,rxGapUs=0,rxCallUs=0,decodeUs=0,encodeUs=0,loopUs=0,sleepUs=0;
 uint32_t guardUs=0,prebufferUs=0,paddingUs=0;uint32_t configHz=0,primaryCode=0,cleanupCode=0,sourceSamples=0,packetBankHash=0,prepareUs=0;uint32_t tickUs=0,inHigh=0,outHigh=0,emptyUs=0,writeErrors=0,writeTimeouts=0,rxErrors=0,checksumErrors=0,orderErrors=0,limiterHits=0;
 int32_t actualCore=-1,stackMin=-1,freeInternal=-1,largest=-1;
 uint32_t rate()const{return mediaUs?uint32_t(uint64_t(mediaSamples)*1000000u/mediaUs):0;}
};
}

namespace Conversation {
inline constexpr uint32_t kFirstSoundGuardMs=180,kTailGuardMs=48,kTailBudgetMs=5000;
inline constexpr size_t kTailSamples=1024,kChunk=128;
enum class Life:uint8_t {Ready,Busy,Stopping,Quarantined};
enum class EventKind:uint8_t {Ready,Start,Data,Stop,Flush,Listen,Resolution,Pcm};
struct Event {
 uint32_t generation=0,epoch=0;EventKind kind=EventKind::Data;uint16_t bytes=0,mediaSamples=960;uint32_t sequence=0,hash=0;
 char response[129]={},playback[129]={};uint8_t data[1920]={};
};
// SPSC: producer alone writes head, consumer alone writes tail; storage may be
// PSRAM, but atomics/owners stay in internal RAM. Never reset a running queue.
template<class T,size_t N> class Queue {
 T* slots_=nullptr;std::atomic<uint32_t> head_{0},tail_{0};
 public:
 void attach(T* slots){slots_=slots;head_.store(0);tail_.store(0);}
 bool push(const T& v){uint32_t h=head_.load(std::memory_order_relaxed),t=tail_.load(std::memory_order_acquire);if(!slots_||uint32_t(h-t)>=N)return false;slots_[h%N]=v;head_.store(h+1,std::memory_order_release);return true;}
 bool pop(T& v){uint32_t t=tail_.load(std::memory_order_relaxed),h=head_.load(std::memory_order_acquire);if(t==h||!slots_)return false;v=slots_[t%N];tail_.store(t+1,std::memory_order_release);return true;}
 size_t size()const{uint32_t n=head_.load(std::memory_order_acquire)-tail_.load(std::memory_order_acquire);return n>N?N:n;}
 bool empty()const{return head_.load(std::memory_order_acquire)==tail_.load(std::memory_order_acquire);}
};
// Actual device and fake PCM use the same cursor, volume and timing decisions.
struct Playout {
 int16_t pcm[960]={};size_t cursor=960,padding=0,frameSamples=960;
 enum class WriteKind {Guard,Media,Padding};WriteKind writeKind=WriteKind::Guard;
 uint16_t chunk=128,guardMs=180,tailTarget=1024;bool mediaEnabled=true;
 bool speaking=false,ordinaryStop=false,priming=false,tail=false,waitingTail=false,failed=false;
 uint8_t volume=20;uint32_t primeAt=0,tailAt=0,tailBegan=0;
 template<class IO> bool begin(IO& io,uint32_t now,uint8_t vol){
  cursor=960;padding=0;speaking=true;ordinaryStop=false;tail=waitingTail=failed=false;volume=vol;
  priming=vol!=0;primeAt=now;
  return io.resetDecoder()&&(!priming||io.prepare());
 }
 template<class IO> bool setVolume(IO& io,uint8_t v,uint32_t now){
  if(v==volume)return true;uint8_t previous=volume;
  if(!io.volume(v))return false;volume=v;
  if(!v)priming=false;
  else if(!previous&&speaking){if(!io.prepare())return false;primeAt=now;priming=true;}
  return true;
 }
 bool load(const int16_t* samples,size_t count=960){if(cursor!=960||!count||count>960)return false;std::memcpy(pcm,samples,sizeof(pcm));cursor=0;frameSamples=count;return true;}
 void stop(){ordinaryStop=true;}
 enum class Step {Idle,Written,Complete,Cancelled,Failed};
 template<class IO,class Current> Step tick(IO& io,uint32_t now,bool queueEmpty,Current current){
  if(!current())return Step::Cancelled;if(failed)return Step::Failed;if(!speaking)return Step::Idle;
  const int16_t silence[256]={};const int16_t* source=nullptr;size_t count=chunk;if(count!=64&&count!=128&&count!=256){failed=true;return Step::Failed;}bool media=false,pad=false;
  if(priming&&uint32_t(now-primeAt)<guardMs){source=silence;writeKind=WriteKind::Guard;}
  else{
   priming=false;
   if(cursor<960){if(!mediaEnabled)return Step::Idle;count=frameSamples-cursor;if(count>chunk)count=chunk;source=pcm+cursor;media=true;writeKind=WriteKind::Media;}
   else if(ordinaryStop&&queueEmpty){
    if(!tail){tail=true;tailBegan=now;}
    if(uint32_t(now-tailBegan)>=kTailBudgetMs){failed=true;return Step::Failed;}
    if(padding<tailTarget){count=tailTarget-padding;if(count>chunk)count=chunk;source=silence;pad=true;writeKind=WriteKind::Padding;}
    else{
     if(!waitingTail){waitingTail=true;tailAt=now;}
     if(uint32_t(now-tailAt)<kTailGuardMs)return Step::Idle;
     if(!current())return Step::Cancelled;
     // This is terminal cleanup, never a completion fence or playback ACK.
     if(!io.cleanup()){failed=true;return Step::Failed;}
     speaking=false;return Step::Complete;
    }
   }else return Step::Idle;
  }
  if(!current())return Step::Cancelled;size_t submitted=0;
  if(!io.write(source,count,submitted)||submitted!=count){failed=true;return Step::Failed;}
  if(media){cursor+=submitted;if(cursor==frameSamples)cursor=960;}if(pad)padding+=submitted;return Step::Written;
 }
};

class VoiceLevel {
 std::atomic<uint32_t> generation_{0},appliedGeneration_{0};
 std::atomic<uint8_t> requested_{100},applied_{100};
 public:
 static bool valid(unsigned level){return level>=5&&level<=100&&level%5==0;}
 bool begin(uint32_t gen,uint8_t level){
  if(!valid(level))return false;
  generation_.store(0,std::memory_order_release);appliedGeneration_.store(0,std::memory_order_release);
  requested_.store(level,std::memory_order_release);generation_.store(gen,std::memory_order_release);return true;
 }
 bool request(uint32_t gen,uint8_t level){
  if(!valid(level)||generation_.load(std::memory_order_acquire)!=gen)return false;
  requested_.store(level,std::memory_order_release);return generation_.load(std::memory_order_acquire)==gen;
 }
 bool requested(uint32_t gen,uint8_t& level)const{
  if(generation_.load(std::memory_order_acquire)!=gen)return false;
  level=requested_.load(std::memory_order_acquire);return generation_.load(std::memory_order_acquire)==gen;
 }
 void acknowledge(uint32_t gen,uint8_t level){
  if(generation_.load(std::memory_order_acquire)==gen){applied_.store(level,std::memory_order_release);appliedGeneration_.store(gen,std::memory_order_release);}
 }
 bool applied(uint32_t gen,uint8_t& level)const{
  if(appliedGeneration_.load(std::memory_order_acquire)!=gen)return false;
  level=applied_.load(std::memory_order_acquire);return appliedGeneration_.load(std::memory_order_acquire)==gen;
 }
};

template<class IO> bool ordinaryVolumeStep(VoiceLevel& handoff,uint32_t generation,bool ordinary,Playout& pump,IO& io,uint8_t& applied,uint32_t now){
 if(!ordinary)return true;
 uint8_t desired=applied;if(!handoff.requested(generation,desired))return true;
 if(desired!=applied){if(!pump.setVolume(io,desired,now))return false;applied=desired;}
 handoff.acknowledge(generation,applied);return true;
}


inline uint8_t selectedOwnerLevel(const VoiceLevel& handoff,uint32_t generation,bool ordinary,uint8_t fallback){
 uint8_t selected=fallback;
 if(ordinary)handoff.requested(generation,selected);
 return selected;
}
template<class Send,class Current> bool sendCurrent(Send send,Current current){
 return current()&&send()&&current();
}
#ifdef ARDUINO
inline bool greetingNegotiated(JsonVariantConst feature){return feature.is<bool>()&&feature.as<bool>();}
#endif

enum class DownlinkFormat:uint8_t {Invalid,Opus,PcmS16le};
inline constexpr char kDeviceHello[]="{\"type\":\"hello\",\"version\":1,\"transport\":\"websocket\",\"audio_params\":{\"format\":\"opus\",\"sample_rate\":16000,\"channels\":1,\"frame_duration\":60},\"features\":{\"pcm_downlink\":true}}";
struct HelloFields {bool object=false,hello=false,resolution=false,pcm=false;int rate=0,channels=0,frameMs=0;DownlinkFormat format=DownlinkFormat::Invalid;};
inline DownlinkFormat selectDownlink(const HelloFields& h,bool requestedPcm){
 if(!h.object||!h.hello||!h.resolution||h.rate!=16000||h.channels!=1||h.frameMs!=60)return DownlinkFormat::Invalid;
 if(h.format==DownlinkFormat::Opus)return h.pcm?DownlinkFormat::Invalid:DownlinkFormat::Opus;
 return requestedPcm&&h.format==DownlinkFormat::PcmS16le&&h.pcm?DownlinkFormat::PcmS16le:DownlinkFormat::Invalid;
}
#ifdef ARDUINO
inline DownlinkFormat selectDownlink(JsonVariantConst hello,bool requestedPcm){
 HelloFields fields;fields.object=hello.is<JsonObjectConst>();
 fields.hello=hello["type"].is<const char*>()&&!std::strcmp(hello["type"].as<const char*>(),"hello");
 auto params=hello["audio_params"],feature=hello["features"]["playback_resolution"];
 fields.resolution=feature.is<bool>()&&feature.as<bool>();
 fields.rate=params["sample_rate"].is<int>()?params["sample_rate"].as<int>():0;
 fields.channels=params["channels"].is<int>()?params["channels"].as<int>():0;
 fields.frameMs=params["frame_duration"].is<int>()?params["frame_duration"].as<int>():0;
 if(params["format"].is<const char*>()){
  const char* format=params["format"].as<const char*>();
  if(!std::strcmp(format,"opus"))fields.format=DownlinkFormat::Opus;
  if(!std::strcmp(format,"pcm_s16le"))fields.format=DownlinkFormat::PcmS16le;
 }
 auto pcm=hello["features"]["pcm_downlink"];fields.pcm=pcm.is<bool>()&&pcm.as<bool>();
 return selectDownlink(fields,requestedPcm);
}
#endif
inline bool downlinkEvent(DownlinkFormat format,const uint8_t* data,size_t bytes,
 uint32_t generation,uint32_t epoch,uint32_t sequence,Event& out){
 bool pcm=format==DownlinkFormat::PcmS16le;
 if(!data||!sequence||(!pcm&&format!=DownlinkFormat::Opus)||
    (pcm?bytes!=1920:(bytes<1||bytes>1275)))return false;
 out.generation=generation;out.epoch=epoch;out.sequence=sequence;out.hash=0;out.response[0]=out.playback[0]=0;
 out.kind=pcm?EventKind::Pcm:EventKind::Data;out.bytes=uint16_t(bytes);out.mediaSamples=960;
 std::memcpy(out.data,data,bytes);return true;
}

struct SessionStart {
 enum class Outcome:uint8_t {Ignored,Listening,Greeting,Failed};
 uint32_t generation=0;bool greeting=false,sent=false,waiting=false,aborted=false;
 void begin(uint32_t gen,bool negotiated){generation=gen;greeting=negotiated;sent=waiting=aborted=false;}
 template<class Send,class Current> Outcome initial(uint32_t gen,bool freshReady,Send send,Current current){
  if(gen!=generation||sent||aborted||!freshReady||!current())return Outcome::Ignored;
  sent=true;
  const char* request=greeting?"{\"type\":\"greeting\"}":"{\"type\":\"listen\",\"state\":\"start\",\"mode\":\"realtime\"}";
  if(!sendCurrent([&]{return send(request);},current)){aborted=true;return Outcome::Failed;}
  waiting=greeting;return greeting?Outcome::Greeting:Outcome::Listening;
 }
 void abort(){aborted=true;waiting=false;}
 void resolved(){waiting=false;}
};

struct FreshRx {
 uint32_t at=0;bool active=false;
 void begin(uint32_t now){active=true;at=now;}
 // Call for every real got result, including TimedOut+partial; discard it all.
 bool observe(size_t got){if(got<256)active=false;return !active;}
 bool expired(uint32_t now)const{return active&&uint32_t(now-at)>=200;}
};

// Audio owner owns transitions. Network only publishes output-block/listen
// tickets; no microphone analysis is allowed merely because playout ended.
struct VoiceGate {
 enum class Stage:uint8_t {InitialFresh,Output,TurnFresh,AwaitListen,Listen,Aborted};
 Stage stage=Stage::InitialFresh;uint32_t generation=0,turn=0,openedEpoch=0;FreshRx fresh;
 void begin(uint32_t gen,uint32_t now){generation=gen;turn=openedEpoch=0;stage=Stage::InitialFresh;fresh.begin(now);}
 void abort(){stage=Stage::Aborted;fresh.active=false;openedEpoch=0;}
 bool output(uint32_t gen,uint32_t epoch){
  if(gen!=generation||!epoch||stage==Stage::Aborted)return false;
  if(epoch==turn&&stage!=Stage::Output)return false;
  turn=epoch;openedEpoch=0;stage=Stage::Output;fresh.active=false;return true;
 }
 bool cleaned(uint32_t gen,uint32_t epoch,uint32_t now){
  if(gen!=generation||epoch!=turn||stage!=Stage::Output)return false;
  stage=Stage::TurnFresh;fresh.begin(now);return true;
 }
 bool draining()const{return stage==Stage::InitialFresh||stage==Stage::TurnFresh;}
 bool capture(uint32_t wanted,uint32_t listen,uint32_t activeTurn,bool blocked)const{
  return wanted==generation&&stage==Stage::Listen&&openedEpoch&&openedEpoch==listen&&activeTurn==turn&&!blocked;
 }
 unsigned rxBatch(uint32_t wanted,uint32_t listen,uint32_t activeTurn,bool blocked)const{
  if(wanted!=generation||stage==Stage::Aborted)return 0;
  if(draining()&&activeTurn==turn&&((turn==0&&!blocked)||(turn!=0&&blocked)))return 4;
  return capture(wanted,listen,activeTurn,blocked)?1:0;
 }
 bool observeFresh(size_t got){return draining()&&fresh.observe(got);}
 bool expired(uint32_t now)const{return draining()&&uint32_t(now-fresh.at)>=200;}
 template<class Reset,class Publish> bool finishFresh(Reset reset,Publish publish){
  if(!draining()||fresh.active)return false;
  if(!reset()||!publish()){abort();return false;}
  stage=Stage::AwaitListen;return true;
 }
 bool listen(uint32_t wanted,uint32_t epoch,uint32_t activeTurn,bool blocked){
  if(wanted!=generation||stage!=Stage::AwaitListen||!epoch||activeTurn!=turn||blocked)return false;
  openedEpoch=epoch;stage=Stage::Listen;return true;
 }
};

inline bool canStart(Life life){return life==Life::Ready;}
inline Life stopped(Life life){return life==Life::Quarantined?life:life==Life::Busy?Life::Stopping:life;}
inline Life released(Life life,bool audioDone,bool networkDone,bool cleanupOkay){
 if(life==Life::Quarantined||!cleanupOkay)return Life::Quarantined;
 return audioDone&&networkDone?Life::Ready:life;
}

inline bool afterConnect(bool connected,bool current){return connected&&current;}
template<class Transport> bool writeFrame(Transport& transport,const uint8_t* bytes,size_t size,size_t& written){
 written=transport.write(bytes,size);return written==size;
}
inline bool validResolution(bool negotiated,bool ordinary,bool cleaned,const char* response,const char* playback,const Event& e){
 return negotiated&&ordinary&&cleaned&&e.kind==EventKind::Resolution&&!std::strcmp(response,e.response)&&!std::strcmp(playback,e.playback);
}

inline bool resolutionAllowed(bool negotiated,bool ordinary,const char* response,const char* playback,const Event& e,
 uint32_t generation,uint32_t turn,uint32_t freshGeneration,uint32_t freshTurn){
 return e.generation==generation&&e.epoch==turn&&freshGeneration==generation&&freshTurn==turn&&
 validResolution(negotiated,ordinary,true,response,playback,e);
}
inline bool micPacketAllowed(const Event& e,uint32_t generation,uint32_t wanted,uint32_t listen,bool listening,bool blocked,bool stopped){
 return e.generation==generation&&generation==wanted&&!stopped&&listening&&!blocked&&listen&&e.epoch==listen;
}

struct MicFrame {
 int16_t samples[960]={};size_t used=0;uint32_t epoch=0;
 void clear(){used=0;}
 bool fence(uint32_t next){if(epoch==next)return false;epoch=next;clear();return true;}
 bool feed(int16_t sample){samples[used++]=sample;if(used==960){used=0;return true;}return false;}
};
inline bool currentGeneration(uint32_t generation,uint32_t wanted,bool stopped,bool fatal){
 return generation==wanted&&!stopped&&!fatal;
}
inline bool accepts(const Event& e,uint32_t generation,uint32_t wanted,bool stopped,bool fatal){
 return e.generation==generation&&currentGeneration(generation,wanted,stopped,fatal);
}
enum class InitOutcome:uint8_t {Ready,Cancelled,Codec,Audio,Volume};

class Failures {
 std::atomic<int> primary_{0},cleanup_{0};
 public:
 void reset(){primary_.store(0);cleanup_.store(0);}
 void note(int code){if(code>0){int empty=0;primary_.compare_exchange_strong(empty,code);}}
 void cleanup(int code){if(code>0){int empty=0;cleanup_.compare_exchange_strong(empty,code);}}
 int primary()const{return primary_.load();}
 int cleanup()const{return cleanup_.load();}
};

struct Resources {
 bool codecAttempted=false,audioAttempted=false;
 template<class IO,class Current> InitOutcome initialize(IO& io,Current current,uint8_t volume){
  if(!current())return InitOutcome::Cancelled;
  codecAttempted=true;if(!io.beginCodec())return InitOutcome::Codec;
  if(!current())return InitOutcome::Cancelled;
  audioAttempted=true;if(!io.beginAudio())return InitOutcome::Audio;
  if(!current())return InitOutcome::Cancelled;
  if(!io.setVolume(volume))return InitOutcome::Volume;
  return current()?InitOutcome::Ready:InitOutcome::Cancelled;
 }
 template<class IO,class Pause> bool cleanup(IO& io,Pause pause){
  bool okay=true,standbyUncertain=false;
  if(audioAttempted){
   bool stopped=io.stopAudio(),ended=io.endAudio();
   standbyUncertain=io.standbyFailed();okay=stopped&&ended;
  }
  if(codecAttempted||io.codecOwned()){bool ended=io.endCodec();okay=ended&&okay;}
  for(unsigned attempt=0;!okay&&attempt<2;++attempt){
   pause();bool a=io.endAudio(),b=io.endCodec();
   standbyUncertain=standbyUncertain||io.standbyFailed();
   okay=a&&b&&!standbyUncertain;
  }
  return okay&&!standbyUncertain;
 }
};
}

namespace Audio {
struct MediaSpan {
 bool active=false,haveEnd=false;uint32_t began=0,lastEnd=0;
 void begin(uint32_t now){if(!active){active=true;haveEnd=false;began=now;}}
 void submitted(uint32_t now){lastEnd=now;haveEnd=true;}
 uint32_t pending(uint32_t now)const{return active?uint32_t(now-began):0;}
 uint32_t close(){uint32_t us=active&&haveEnd?uint32_t(lastEnd-began):0;active=haveEnd=false;return us;}
};
inline bool prebufferReady(Source source,size_t queued,unsigned required,bool ordinaryStop,bool mediaStarted){
 return source==Source::Pcm||mediaStarted||ordinaryStop||queued>=required;
}
inline void accountSamples(Stats& stats,Conversation::Playout::WriteKind kind,size_t count){
 if(kind==Conversation::Playout::WriteKind::Media)stats.mediaSamples+=uint32_t(count);
 else{stats.silentSamples+=uint32_t(count);if(kind==Conversation::Playout::WriteKind::Guard)stats.guardSamples+=uint32_t(count);else stats.padSamples+=uint32_t(count);}
}


enum class MediaRead:uint8_t {Ready,Stale,Bounds,Order,Checksum,Decode};
template<class Decode,class Clock> MediaRead mediaFrame(const Conversation::Event& event,
 uint32_t generation,uint32_t wanted,uint32_t turn,bool stopped,bool fatal,uint32_t& expected,
 int16_t* decoded,Stats& stats,Decode decode,Clock clock){
 using namespace Conversation;
 if(!accepts(event,generation,wanted,stopped,fatal)||event.epoch!=turn)return MediaRead::Stale;
 if(!decoded||!event.bytes||event.bytes>sizeof(event.data)||
    (event.kind!=EventKind::Data&&event.kind!=EventKind::Pcm))return MediaRead::Bounds;
 if(event.sequence!=expected){++stats.orderErrors;return MediaRead::Order;}
 if(event.hash!=checksum(event.data,event.bytes)){++stats.checksumErrors;return MediaRead::Checksum;}
 if(event.kind==EventKind::Pcm){
  if(event.bytes!=1920||!event.mediaSamples||event.mediaSamples>960)return MediaRead::Bounds;
  for(size_t i=0;i<960;++i)decoded[i]=getLE(event.data+i*2);
 }else{
  if(event.bytes>1275)return MediaRead::Bounds;
  uint32_t at=clock();bool good=decode(event.data,event.bytes,decoded,960);
  uint32_t elapsed=uint32_t(clock()-at);++stats.decodeCalls;if(elapsed>stats.decodeUs)stats.decodeUs=elapsed;
  if(!good)return MediaRead::Decode;
 }
 ++expected;return MediaRead::Ready;
}

struct TxCall {int status=0,lastError=0;size_t accepted=0;bool okay=false,timedOut=false;};
struct FirstWriteFailure {
 bool present=false;int status=0,lastError=0;uint32_t requested=0,knownAccepted=0,elapsedUs=0,kind=0,cursor=0;
 void note(const TxCall& r,size_t requestedCount,size_t acceptedCount,uint32_t elapsed,uint32_t writeKind,size_t position){
  if(present)return;present=true;status=r.status;lastError=r.lastError;requested=uint32_t(requestedCount);knownAccepted=uint32_t(acceptedCount);elapsedUs=elapsed;kind=writeKind;cursor=uint32_t(position);
 }
 int format(char* buffer,size_t capacity)const{
  return std::snprintf(buffer,capacity,"[AUDIO-FAIL] st=%d err=%d req=%u known=%u us=%u kind=%u cur=%u",status,lastError,unsigned(requested),unsigned(knownAccepted),unsigned(elapsedUs),unsigned(kind),unsigned(cursor));
 }
};
template<class Call,class Clock,class Current,class Accepted>
bool speakerWrite(const int16_t* input,size_t count,size_t& submitted,uint32_t& waitUs,
 Conversation::Playout::WriteKind kind,size_t cursor,uint8_t limiter,Stats& stats,FirstWriteFailure& failure,
 Call call,Clock clock,Current current,Accepted accepted){
 submitted=0;waitUs=0;if(!input||!count||count>256||!current())return false;
 int16_t limited[256];for(size_t i=0;i<count;++i)limited[i]=limit(input[i],limiter,stats.limiterHits);
 const uint32_t began=clock();
 while(submitted<count){
  if(!current()){waitUs=uint32_t(clock()-began);return false;}
  const size_t before=submitted;
  size_t portion=count-before;if(portion>128)portion=128;
  const uint32_t at=clock();
  const TxCall result=call(limited+before,portion,20);
  const uint32_t end=clock(),elapsed=uint32_t(end-at);waitUs=uint32_t(end-began);
  ++stats.txCalls;if(elapsed>stats.txCallUs)stats.txCallUs=elapsed;
  const size_t known=result.accepted<=portion?result.accepted:0;
  submitted+=known;accountSamples(stats,kind,known);
  if(known)accepted(known,end,result.okay&&known==portion);
  if(result.timedOut)++stats.writeTimeouts;
  else if(!result.okay||result.accepted!=portion)++stats.writeErrors;
  if(!result.okay||result.accepted!=portion){
   failure.note(result,portion,submitted,elapsed,uint32_t(kind),cursor+(kind==Conversation::Playout::WriteKind::Media?before:0));
   return false;
  }
 }
 return true;
}

enum class Segment:uint8_t {Idle,Guard,Prebuffer,Media,Padding};
struct Segments {
 Segment phase=Segment::Idle;uint32_t at=0;bool known=false;
 void enter(Segment next,uint32_t now,Stats& s){
  if(known){uint32_t dt=uint32_t(now-at);if(phase==Segment::Guard)s.guardUs+=dt;if(phase==Segment::Prebuffer)s.prebufferUs+=dt;if(phase==Segment::Padding)s.paddingUs+=dt;}
  phase=next;at=now;known=true;
 }
};

struct TxWork {bool worked=false;uint32_t waitUs=0;};
template<class Clock,class Current,class QueueWork,class Read,class Write,class Sleep>
bool cycle(const Settings& settings,Schedule& schedule,Stats& stats,Clock clock,Current current,QueueWork queueWork,Read read,Write write,Sleep sleep){
 schedule.lastSleepUs=0;if(!current())return false;uint32_t began=clock();bool worked=queueWork();
 if(!current())return false;
 for(unsigned i=0;i<settings.rx&&current();++i){uint32_t at=clock();int got=read();uint32_t dt=uint32_t(clock()-at);if(dt>stats.rxCallUs)stats.rxCallUs=dt;if(got<0)return false;worked|=got>0;if(got<256)break;}
 if(!current())return false;
 TxWork tx=write();worked|=tx.worked;
 uint32_t duration=uint32_t(clock()-began);if(duration>stats.loopUs)stats.loopUs=duration;
 if(!current())return false;
 uint32_t ticks=schedule.pauseTicks(settings,tx.waitUs,stats.tickUs,worked);
 if(ticks){uint32_t at=clock();sleep(ticks);duration=uint32_t(clock()-at);schedule.lastSleepUs=duration;if(duration>stats.sleepUs)stats.sleepUs=duration;}
 return current();
}
}

} // namespace Kibi::XiaozhiClient::Core
