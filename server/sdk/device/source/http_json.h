#pragma once

#include <ArduinoJson.h>
#include <stddef.h>
#include <stdint.h>
#include <cstring>
#include <initializer_list>
#include "audio_file.h"
#include "network_gate.h"
#include "tls_diagnostics.h"
#include "server_endpoint.h"

namespace Tamagotchi::Https {
// 32 KiB UTF-8 dictation can expand when JSON-escaped, plus routing context.
inline constexpr size_t kMaximumRequestBytes=256*1024;
// Plain HTTP is an explicit, unauthenticated GET exception for the public
// forecast endpoint. Credentialed/external API requests retain HTTPS defaults.
inline bool jsonRequestAllowed(bool secure,const char* url,const char* bearer,const char* post) {
  if(!url || std::strpbrk(url,"\r\n\t ")) return false;
  if(secure) return ServerTransport::usesTls(url);
  constexpr char forecast[]="http://api.open-meteo.com/v1/forecast?";
  return !bearer && !post && !std::strncmp(url,forecast,sizeof forecast-1);
}
#ifdef ARDUINO
class PsramJsonAllocator final : public ArduinoJson::Allocator {
 public:
  void* allocate(size_t bytes) override { return heap_caps_malloc(bytes,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT); }
  void deallocate(void* pointer) override { free(pointer); }
  void* reallocate(void* pointer,size_t bytes) override { return heap_caps_realloc(pointer,bytes,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT); }
};
#endif


// Transferred bytes and completed TLS renew the idle limit; socket polling does not.
// Unsigned differences preserve both limits across millis() rollover.
class RequestDeadline {
 public:
  explicit RequestDeadline(uint32_t now,uint32_t maximum=90000):started_(now),progressAt_(now),maximum_(maximum) {}
  bool expired(uint32_t now) {
    timedOut_ |= uint32_t(now-started_)>=maximum_ || uint32_t(now-progressAt_)>=8000;
    return timedOut_;
  }
  void progress(uint32_t now,size_t bytes) {
    if(bytes && !expired(now)) progressAt_=now;
  }
  void transportReady(uint32_t now) {
    timedOut_|=uint32_t(now-started_)>=maximum_;
    progressAt_=now;
  }
  bool timedOut() const { return timedOut_; }
  bool afterConnect(bool connected,uint32_t now) {
    if(!connected) return false;
    // SDK's handshake uses raw TLS BIO rather than wrapper read/write calls.
    // Only the response-idle clock renews; the total request cap still applies.
    transportReady(now);
    return !expired(now);
  }
 private:
  uint32_t started_,progressAt_,maximum_;
  bool timedOut_=false;
};

// Data-only contract shared by the device adapter and portable fake transports.
// No response text, URL, request header or credential is retained in a result.
enum class JsonError { None,InvalidRequest,Cancelled,Timeout,Busy,Transport,Redirect,
                       Authentication,RateLimited,HttpStatus,ResponseTooLarge,MalformedJson,NoMemory };
struct JsonResult {
  JsonError error=JsonError::None;
  int httpStatus=0;
  bool retryable=false;
  uint32_t retryAfterSeconds=0;
  bool ok() const { return error==JsonError::None; }
};
struct JsonHeader { const char* name=nullptr; const char* value=nullptr; };
struct JsonHeaders { const JsonHeader* entries=nullptr; size_t count=0; };
enum class JsonAuthKind { None,Bearer,ApiKey,Anthropic };
struct JsonAuth { JsonAuthKind kind=JsonAuthKind::None; const char* key=nullptr; const char* version=nullptr; };
inline JsonAuth bearerAuth(const char* key) { return {JsonAuthKind::Bearer,key,nullptr}; }
inline JsonAuth apiKeyAuth(const char* key) { return {JsonAuthKind::ApiKey,key,nullptr}; }
inline JsonAuth anthropicAuth(const char* key,const char* version="2023-06-01") { return {JsonAuthKind::Anthropic,key,version}; }
struct JsonOptions {
  JsonHeaders headers;
  JsonAuth auth;
  NetworkGate::Priority priority=NetworkGate::Priority::Background;
  uint32_t maximumMs=20000;
  size_t maximumResponseBytes=16384;
  bool (*keepRunning)()=nullptr;
};

namespace JsonDetail {
inline constexpr size_t kHeaderCount=8,kHeaderNameBytes=64,kHeaderValueBytes=1024,kHeaderTotalBytes=4096;
inline constexpr size_t kAuthKeyBytes=4096,kResponseBytes=16384;
inline size_t boundedLength(const char* text,size_t maximum) {
  if(!text) return maximum+1;
  size_t length=0;while(length<=maximum && text[length]) ++length;return length;
}
inline bool sameHeader(const char* left,const char* right) {
  while(*left && *right) {
    const auto fold=[](char c) { return c>='A'&&c<='Z'?char(c-'A'+'a'):c; };
    if(fold(*left++)!=fold(*right++)) return false;
  }
  return *left==*right;
}
inline bool safeValue(const char* value,size_t maximum,bool token=false) {
  const size_t length=boundedLength(value,maximum);if(length>maximum || (token&&!length)) return false;
  for(size_t i=0;i<length;++i) {
    const unsigned char c=static_cast<unsigned char>(value[i]);
    if(c<32 || c==127 || (token&&(c<=32||c>=127))) return false;
  }
  return true;
}
inline bool safeName(const char* name) {
  const size_t length=boundedLength(name,kHeaderNameBytes);if(!length||length>kHeaderNameBytes) return false;
  for(size_t i=0;i<length;++i) {
    const char c=name[i];
    if(!((c>='A'&&c<='Z')||(c>='a'&&c<='z')||(c>='0'&&c<='9')||std::strchr("!#$%&'*+-.^_`|~",c))) return false;
  }
  for(const char* reserved:{"Host","Content-Length","Transfer-Encoding","Connection","Content-Type","Accept","Accept-Encoding","User-Agent"})
    if(sameHeader(name,reserved)) return false;
  return true;
}
inline bool safeUrl(const char* url) {
  const size_t length=boundedLength(url,2048);if(length>2048||length<9||!ServerTransport::usesTls(url)) return false;
  for(size_t i=0;i<length;++i) {const unsigned char c=static_cast<unsigned char>(url[i]);if(c<=32||c==127||c=='\\'||c=='#') return false;}
  const char* authority=url+8;const char* end=authority;
  while(*end && *end!='/' && *end!='?') ++end;
  if(end==authority) return false;
  const char* colon=nullptr;
  for(const char* p=authority;p<end;++p) {
    const char c=*p;
    if(c==':') {if(colon) return false;colon=p;}
    else if(!((c>='A'&&c<='Z')||(c>='a'&&c<='z')||(c>='0'&&c<='9')||c=='.'||c=='-')) return false;
  }
  if(colon) {
    if(colon==authority||colon+1==end) return false;
    unsigned port=0;
    for(const char* p=colon+1;p<end;++p) {if(*p<'0'||*p>'9'||port>6553) return false;port=port*10+unsigned(*p-'0');}
    if(!port||port>65535) return false;
  }
  return true;
}
inline bool valid(const char* url,const char* post,const JsonOptions& options) {
  if(!safeUrl(url)||(post&&boundedLength(post,kMaximumRequestBytes)>kMaximumRequestBytes)||!options.maximumMs||options.maximumMs>90000||!options.maximumResponseBytes||options.maximumResponseBytes>kResponseBytes||
     (options.priority!=NetworkGate::Priority::Background&&options.priority!=NetworkGate::Priority::Voice)||options.headers.count>kHeaderCount||(options.headers.count&&!options.headers.entries)) return false;
  const auto& auth=options.auth;
  if(auth.kind!=JsonAuthKind::None&&auth.kind!=JsonAuthKind::Bearer&&auth.kind!=JsonAuthKind::ApiKey&&auth.kind!=JsonAuthKind::Anthropic) return false;
  if(auth.kind==JsonAuthKind::None) {if(auth.key) return false;}
  else if(!safeValue(auth.key,kAuthKeyBytes,true)) return false;
  if(auth.kind==JsonAuthKind::Anthropic) {
    if(boundedLength(auth.version,10)!=10) return false;
    for(size_t i=0;i<10;++i) if((i==4||i==7)?auth.version[i]!='-':auth.version[i]<'0'||auth.version[i]>'9') return false;
  }
  size_t total=0;
  for(size_t i=0;i<options.headers.count;++i) {
    const auto& header=options.headers.entries[i];
    if(!safeName(header.name)||!safeValue(header.value,kHeaderValueBytes)) return false;
    total+=std::strlen(header.name)+std::strlen(header.value);if(total>kHeaderTotalBytes) return false;
    for(size_t j=0;j<i;++j) if(sameHeader(header.name,options.headers.entries[j].name)) return false;
    if((auth.kind==JsonAuthKind::Bearer||auth.kind==JsonAuthKind::ApiKey)&&sameHeader(header.name,"Authorization")) return false;
    if(auth.kind==JsonAuthKind::Anthropic&&(sameHeader(header.name,"x-api-key")||sameHeader(header.name,"anthropic-version")||sameHeader(header.name,"Authorization"))) return false;
  }
  return true;
}
// The sink must copy each value during this call, just as HTTPClient.addHeader
// does. Auth scratch is owned here and never returned as a dangling view.
template<class Sink> bool emitHeaders(const JsonOptions& options,Sink sink) {
  for(size_t i=0;i<options.headers.count;++i) sink(options.headers.entries[i].name,options.headers.entries[i].value);
  const auto& auth=options.auth;
  if(auth.kind==JsonAuthKind::Anthropic) {sink("x-api-key",auth.key);sink("anthropic-version",auth.version);}
  else if(auth.kind==JsonAuthKind::Bearer||auth.kind==JsonAuthKind::ApiKey) {
    const char* prefix=auth.kind==JsonAuthKind::Bearer?"Bearer ":"Api-Key ";BoundedText authorization;
    if(!authorization.reserve(std::strlen(prefix)+std::strlen(auth.key)+1)) return false;
    std::strcpy(authorization.data(),prefix);std::strcat(authorization.data(),auth.key);sink("Authorization",authorization.data());
  }
  return true;
}
inline uint32_t retryAfterSeconds(const char* text) {
  const size_t length=boundedLength(text,128);if(!length||length>128) return 0;
  uint32_t seconds=0;
  for(size_t i=0;i<length;++i) {if(text[i]<'0'||text[i]>'9') return 0;if(seconds<3600){seconds=seconds*10+unsigned(text[i]-'0');if(seconds>3600)seconds=3600;}}
  return seconds;
}
struct BodyRead { size_t bytes=0; bool overflow=false,interrupted=false,invalid=false; };
// ArduinoJson intentionally stops after a complete root value. Reject trailing
// frames/text too: a successful first object is not proof of a complete reply.
inline bool singleJsonValue(const char* text,size_t length) {
  const auto space=[](char c){return c==' '||c=='\t'||c=='\r'||c=='\n';};
  const auto digit=[](char c){return c>='0'&&c<='9';};
  const auto tail=[&](size_t from){while(from<length&&space(text[from]))++from;return from==length;};
  size_t start=0;while(start<length&&space(text[start]))++start;if(start==length)return false;
  if(text[start]=='{'||text[start]=='['||text[start]=='"') {
    const bool scalarString=text[start]=='"';bool quoted=scalarString,escaped=false;unsigned depth=scalarString?0:1;
    for(size_t i=start+1;i<length;++i) {
      const char c=text[i];
      if(quoted) {if(escaped)escaped=false;else if(c=='\\')escaped=true;else if(c=='"'){quoted=false;if(scalarString)return tail(i+1);}continue;}
      if(c=='"')quoted=true;
      else if(c=='{'||c=='[')++depth;
      else if(c=='}'||c==']'){if(!depth)return false;if(--depth==0)return tail(i+1);}
    }
    return false;
  }
  for(const char* literal:{"true","false","null"}) {const size_t bytes=std::strlen(literal);if(length-start>=bytes&&!std::memcmp(text+start,literal,bytes))return tail(start+bytes);}
  size_t at=start;if(text[at]=='-')++at;if(at==length)return false;
  if(text[at]=='0')++at;
  else {if(text[at]<'1'||text[at]>'9')return false;while(at<length&&digit(text[at]))++at;}
  if(at<length&&text[at]=='.'){const size_t begin=++at;while(at<length&&digit(text[at]))++at;if(at==begin)return false;}
  if(at<length&&(text[at]=='e'||text[at]=='E')){++at;if(at<length&&(text[at]=='+'||text[at]=='-'))++at;const size_t begin=at;while(at<length&&digit(text[at]))++at;if(at==begin)return false;}
  return tail(at);
}
template<class Http> JsonResult perform(Http& http,const char* url,const char* post,JsonDocument& output,const JsonDocument& filter,const JsonOptions& options) {
  output.clear();
  if(!valid(url,post,options)) return {JsonError::InvalidRequest};
  const auto continuing=[&] {return !options.keepRunning||options.keepRunning();};
  if(!continuing()) return {JsonError::Cancelled};
  struct End {Http& http;~End(){http.end();}} end{http};
  const auto transportError=[&] {return !continuing()||http.cancelled()?JsonError::Cancelled:http.timedOut()?JsonError::Timeout:http.busy()?JsonError::Busy:http.failure();};
  const auto mayRetry=[&](JsonError error) {return !post&&(error==JsonError::Transport||error==JsonError::Timeout||error==JsonError::Busy);};
  if(!http.begin(url,post,options)) {const auto error=transportError();return {error,0,mayRetry(error)};}
  const int status=http.send(post);
  const int httpStatus=status>=100&&status<=599?status:0;
  if(!continuing()||http.cancelled()||http.timedOut()||http.busy()||http.failure()!=JsonError::Transport) {const auto error=transportError();return {error,httpStatus,mayRetry(error)};}
  const uint32_t retry=retryAfterSeconds(http.retryAfter());
  if(status<200||status>=300) {
    const auto error=!httpStatus?JsonError::Transport:status>=300&&status<400?JsonError::Redirect:status==401||status==403?JsonError::Authentication:status==429?JsonError::RateLimited:JsonError::HttpStatus;
    return {error,httpStatus,!post&&(!httpStatus||status==408||status==429||(status>=500&&status<=599)),retry};
  }
  if(status==204||status==205) return {JsonError::None,status};
  const int advertised=http.responseSize();
  if(advertised>int(options.maximumResponseBytes)) return {JsonError::ResponseTooLarge,status};
  BoundedText response;if(!response.reserve(options.maximumResponseBytes+1)) return {JsonError::NoMemory,status};
  const BodyRead read=http.readBody(response.data(),options.maximumResponseBytes);
  if(!continuing()||http.cancelled()||http.timedOut()||http.busy()) {const auto error=transportError();return {error,status,mayRetry(error)};}
  if(read.invalid) return {JsonError::MalformedJson,status};
  if(read.overflow||read.bytes>options.maximumResponseBytes) return {JsonError::ResponseTooLarge,status};
  if(read.interrupted||(advertised>=0&&read.bytes!=size_t(advertised))) return {JsonError::Transport,status,!post};
  if(!singleJsonValue(response.data(),read.bytes)) return {JsonError::MalformedJson,status};
  const auto parsed=deserializeJson(output,static_cast<const char*>(response.data()),read.bytes,DeserializationOption::Filter(filter),DeserializationOption::NestingLimit(12));
  if(parsed==DeserializationError::NoMemory||output.overflowed()) {output.clear();return {JsonError::NoMemory,status};}
  if(parsed) {output.clear();return {JsonError::MalformedJson,status};}
  return {JsonError::None,status};
}
} // namespace JsonDetail
}  // namespace Tamagotchi::Https

#ifdef ARDUINO
#include <Arduino.h>
#include <HTTPClient.h>
#include <NetworkClientSecure.h>
#include <esp_heap_caps.h>

namespace Tamagotchi::Https {

// HTTPClient 3.3.12 can keep polling an open response socket indefinitely after
// a body read times out. Stop the transport itself so its chunk/body loops exit.
// Existing connect/TLS timeouts also bound an individual blocking transport call.
template<class Transport,bool Secure> class BasicDeadlineClient final : public Transport {
 public:
  static constexpr bool kSecure=Secure;
  using Continue=bool(*)();
  explicit BasicDeadlineClient(uint32_t maximum=90000,NetworkGate::Priority priority=NetworkGate::Priority::Background,
                          Continue keepRunning=nullptr)
      :deadline_(millis(),maximum),gate_(priority,priority==NetworkGate::Priority::Voice?maximum:0),keepRunning_(keepRunning),priority_(priority) {
    if(gate_) deadline_.transportReady(millis());
  }
  // Members are destroyed before the base class. Close TLS explicitly before
  // the lease releases another task, including an early HTTP error/timeout.
  ~BasicDeadlineClient() override { stop(); }
  int connect(IPAddress ip,uint16_t port) override {
    return observedConnect([&] { return Transport::connect(ip,port); });
  }
  int connect(IPAddress ip,uint16_t port,int32_t timeout) override {
    return observedConnect([&] { return Transport::connect(ip,port,timeout); });
  }
  int connect(const char* host,uint16_t port) override {
    return observedConnect([&] { return Transport::connect(host,port); });
  }
  int connect(const char* host,uint16_t port,int32_t timeout) override {
    return observedConnect([&] { return Transport::connect(host,port,timeout); });
  }
  void stop() override {
    if constexpr(Secure) {
      TlsDiagnostics::Context::Closing closing(tlsDiagnostics_);
      Transport::stop();
    } else Transport::stop();
  }
  // Keep Stream and socket timeouts in milliseconds, including after connect()
  // overwrites ESP32 NetworkClient's separate connection/socket timeout field.
  void setTimeout(unsigned long milliseconds) {
    ioTimeoutMs_=uint32_t(milliseconds);
    ServerTransport::configureIoTimeout(static_cast<Transport&>(*this),ioTimeoutMs_);
    if constexpr(Secure) this->sslclient->socket_timeout=ioTimeoutMs_;
  }
  void setCACert(const char* ca) { if constexpr(Secure) Transport::setCACert(ca); }
  void useBuiltinCACertBundle() { if constexpr(Secure) Transport::useBuiltinCACertBundle(); }
  void setHandshakeTimeout(unsigned long seconds) { if constexpr(Secure) Transport::setHandshakeTimeout(seconds); }
  int lastError(char* buffer,size_t capacity) {
    if constexpr(Secure) return Transport::lastError(buffer,capacity);
    else { if(capacity) buffer[0]=0; return 0; }
  }
  uint8_t connected() override { return alive() ? Transport::connected() : 0; }
  int available() override { return alive() ? Transport::available() : 0; }
  int peek() override { return alive() ? Transport::peek() : -1; }
  int read() override { uint8_t value; return read(&value,1)>0 ? value : -1; }
  int read(uint8_t* out,size_t bytes) override {
    if(!alive()) return -1;
    if(received_>=receiveLimit_) {receiveLimitReached_=true;stopped_=true;stop();Stream::setTimeout(1);return -1;}
    if(bytes>receiveLimit_-received_) bytes=receiveLimit_-received_;
    const int received=Transport::read(out,bytes);
    if(received>0) {received_+=size_t(received);deadline_.progress(millis(),size_t(received));}
    return received;
  }
  size_t readBytes(char* out,size_t bytes) override {
    size_t used=0;
    while(used<bytes && alive()) {
      const int received=read(reinterpret_cast<uint8_t*>(out)+used,bytes-used);
      if(received>0) used+=size_t(received);
      else if(!connected()) break;
      else delay(1);
    }
    return used;
  }
  size_t readBytes(uint8_t* out,size_t bytes) override {
    return readBytes(reinterpret_cast<char*>(out),bytes);
  }
  size_t write(uint8_t value) override { return write(&value,1); }
  size_t write(const uint8_t* data,size_t bytes) override {
    if(!alive()) return 0;
    const size_t sent=Transport::write(data,bytes);
    deadline_.progress(millis(),sent);
    return sent;
  }
  bool timedOut() const { return deadline_.timedOut(); }
  bool deadlineExpired() { return deadline_.expired(millis()); }
  bool cancelled() const { return cancelled_; }
  bool busy() const { return !gate_||preempted_; }
  bool readLimitReached() const { return receiveLimitReached_; }
  void setReadLimit(size_t bytes) { receiveLimit_=bytes; }
 private:
  RequestDeadline deadline_;
  NetworkGate::Lease gate_;
  Continue keepRunning_;
  NetworkGate::Priority priority_;
  bool stopped_=false;
  bool cancelled_=false,preempted_=false,receiveLimitReached_=false;
  size_t received_=0,receiveLimit_=SIZE_MAX;
  uint32_t ioTimeoutMs_=8000;
  TlsDiagnostics::Context tlsDiagnostics_{TlsDiagnostics::tracker,TlsDiagnostics::clock,TlsDiagnostics::internalHeap};
  template<class Connect> int observedConnect(Connect connect) {
    if(!alive()) return 0;
    if constexpr(Secure) {
      TlsDiagnostics::Context::Attempt attempt(tlsDiagnostics_);
      // Core timeout overloads dispatch virtually to the simpler overloads.
      // Their outer call alone owns the handshake scope/deadline/diagnostics.
      if(!attempt.outer()) { const int connected=connect(); attempt.finish(connected!=0); return connected; }
      NetworkGate::TlsHandshakeScope idle;
      const int connected=finishConnect(connect());
      attempt.finish(connected!=0);
      return connected;
    } else return finishConnect(connect());
  }
  int finishConnect(int connected) {
    if(deadline_.afterConnect(connected!=0,millis()) && alive()) {
      setTimeout(ioTimeoutMs_);
      if constexpr(!Secure) ServerTransport::finishPlainConnect(static_cast<Transport&>(*this),connected);
      return connected;
    }
    stop();
    return 0;
  }
  bool alive() {
    if(!gate_ || stopped_) return false;
    if(NetworkGate::gate.allowsTransport(priority_)) {
      if(!keepRunning_||keepRunning_()) {if(!deadline_.expired(millis())) return true;}
      else cancelled_=true;
    } else preempted_=true;
    if(!stopped_) {
      stopped_=true;
      stop();
      // Stream::readStringUntil() owns a polling loop too. Its next failed read
      // must return promptly after this transport has reached its deadline.
      Stream::setTimeout(1);
    }
    return false;
  }
};
using DeadlineClient=BasicDeadlineClient<NetworkClientSecure,true>;
using PlainDeadlineClient=BasicDeadlineClient<NetworkClient,false>;

// A bounded sink also used by speech transcription. HTTPClient handles chunked
// transfer framing; neither parser nor caller can accept a partial response.
class BoundedStream final : public Stream {
 public:
  BoundedStream(char* out,size_t capacity):out_(out),capacity_(capacity) { if(capacity_) out_[0]=0; }
  int available() override { return 0; }
  int peek() override { return -1; }
  int read() override { return -1; }
  void flush() override {}
  size_t write(uint8_t value) override { return write(&value,1); }
  size_t write(const uint8_t* data,size_t bytes) override {
    if(!capacity_ || bytes>capacity_-1-used_) { overflow=true; return 0; }
    if(memchr(data,0,bytes)) {invalid=true;overflow=true;return 0;}
    memcpy(out_+used_,data,bytes); used_+=bytes; out_[used_]=0; return bytes;
  }
  size_t size() const { return used_; }
  bool overflow=false,invalid=false;
 private:
  char* out_; size_t capacity_,used_=0;
};

namespace JsonDetail {
class DeviceHttp final {
 public:
  explicit DeviceHttp(const JsonOptions& options):client_(options.maximumMs,options.priority,options.keepRunning),options_(options) {}
  bool begin(const char* url,const char* post,const JsonOptions&) {
    const uint32_t normal=options_.priority==NetworkGate::Priority::Background?3000:8000;
    const uint16_t timeout=uint16_t(options_.maximumMs<normal?options_.maximumMs:normal);
    client_.useBuiltinCACertBundle();client_.setHandshakeTimeout((timeout+999)/1000);client_.setTimeout(timeout);
    // Limit all decoded HTTP bytes as well as the JSON body, so an unbounded
    // server header line cannot consume the heap before body validation runs.
    client_.setReadLimit(options_.maximumResponseBytes+8192);
    http_.setUserAgent("Kibi/1.0");http_.setConnectTimeout(timeout<6000?timeout:6000);http_.setTimeout(timeout);http_.setReuse(false);
    http_.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
    const char* responseHeaders[]={"Retry-After"};http_.collectHeaders(responseHeaders,1);
    if(!http_.begin(client_,url)) return false;
    http_.addHeader("Accept","application/json");http_.addHeader("Accept-Encoding","identity");
    if(post) http_.addHeader("Content-Type","application/json");
    if(!emitHeaders(options_,[&](const char* name,const char* value){http_.addHeader(name,value);})) {failure_=JsonError::NoMemory;return false;}
    return true;
  }
  int send(const char* post) {return post?http_.POST(reinterpret_cast<uint8_t*>(const_cast<char*>(post)),std::strlen(post)):http_.GET();}
  int responseSize() {return http_.getSize();}
  const char* retryAfter() {retryAfter_=http_.header("Retry-After");if(retryAfter_.length()>128)retryAfter_="";return retryAfter_.c_str();}
  BodyRead readBody(char* target,size_t maximum) {
    BoundedStream response(target,maximum+1);const int received=http_.writeToStream(&response);
    return {response.size(),response.overflow||client_.readLimitReached(),received<0,response.invalid};
  }
  bool timedOut() {return client_.deadlineExpired();}
  bool cancelled() const {return client_.cancelled();}
  bool busy() const {return client_.busy();}
  JsonError failure() const {return client_.readLimitReached()?JsonError::ResponseTooLarge:failure_;}
  void end() {http_.end();client_.stop();}
 private:
  DeadlineClient client_;
  HTTPClient http_;
  const JsonOptions& options_;
  String retryAfter_;
  JsonError failure_=JsonError::Transport;
};
} // namespace JsonDetail

// GET when post==nullptr; otherwise POST of already serialized JSON. This
// worker-only synchronous API never retries and never forwards auth redirects.
inline JsonResult requestJson(const char* url,const char* post,JsonDocument& output,
                              const JsonDocument& filter,const JsonOptions& options={}) {
  output.clear();
  if(!JsonDetail::valid(url,post,options)) return {JsonError::InvalidRequest};
  if(options.keepRunning&&!options.keepRunning()) return {JsonError::Cancelled};
  JsonDetail::DeviceHttp http(options);return JsonDetail::perform(http,url,post,output,filter,options);
}

template<class Client=DeadlineClient>
inline bool jsonRequest(const char* url,const char* bearer,const char* post,
                        JsonDocument& output,const JsonDocument& filter,char* error,size_t capacity,
                        NetworkGate::Priority priority=NetworkGate::Priority::Voice,uint32_t maximum=90000,
                        typename Client::Continue keepRunning=nullptr) {
  auto fail=[&](const char* message) { if(capacity) snprintf(error,capacity,"%s",message); return false; };
  output.clear();
  if(!jsonRequestAllowed(Client::kSecure,url,bearer,post)) return fail("Invalid service address.");
  constexpr size_t responseMaximum=16384;
  auto* buffer=static_cast<char*>(heap_caps_malloc(responseMaximum+1,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT));
  if(!buffer) return fail("Not enough memory for the service response.");
  struct Release { char* data; ~Release() { free(data); } } release{buffer};
  Client client(maximum,priority,keepRunning);
  // A background forecast yields to voice between transport calls. Keep each
  // indivisible connect/TLS/read call short as well; voice retains its defaults.
  const uint16_t timeout=priority==NetworkGate::Priority::Background?3000:8000;
  client.useBuiltinCACertBundle(); client.setHandshakeTimeout(timeout/1000); client.setTimeout(timeout);
  HTTPClient http;
  http.setUserAgent("Tamagotchi/1.0"); http.setConnectTimeout(timeout<6000?timeout:6000); http.setTimeout(timeout); http.setReuse(false);
  if(!http.begin(client,url)) return fail("Could not connect to the service.");
  http.addHeader("Accept","application/json"); http.addHeader("Accept-Encoding","identity");
  if(bearer) http.addHeader("Authorization",String("Bearer ")+bearer);
  int status=0;
  if(post) {
    http.addHeader("Content-Type","application/json");
    // HTTPClient's legacy signature is mutable, but it only reads the payload.
    status=http.POST(reinterpret_cast<uint8_t*>(const_cast<char*>(post)),strlen(post));
  }
  else status=http.GET();
  if(status!=200) {
    http.end();
    if(status==401 || status==403) return fail("Access denied. Check your settings.");
    if(status==429) return fail("Service limit reached. Try again later.");
    if(status<0) return fail("No service response. Check your connection.");
    return fail("Service unavailable. Try again later.");
  }
  BoundedStream response(buffer,responseMaximum+1);
  const bool tooLarge=http.getSize()>int(responseMaximum);
  const int read=tooLarge ? -1 : http.writeToStream(&response);
  http.end();
  if(client.timedOut()) return fail("The service response timed out.");
  if(tooLarge || response.overflow || read<0) return fail("The service response was too large or interrupted.");
  // A const input makes ArduinoJson own its strings before this scratch buffer
  // is released; mutable input would leave dangling zero-copy pointers.
  const auto parsed=deserializeJson(output,static_cast<const char*>(buffer),response.size(),DeserializationOption::Filter(filter),DeserializationOption::NestingLimit(12));
  if(parsed || output.overflowed()) { output.clear(); return fail("The service returned an unsupported response."); }
  return true;
}
inline bool getJson(const char* url,JsonDocument& output,const JsonDocument& filter,char* error,size_t capacity,
                    NetworkGate::Priority priority=NetworkGate::Priority::Voice,uint32_t maximum=90000,
                    DeadlineClient::Continue keepRunning=nullptr) {
  return jsonRequest(url,nullptr,nullptr,output,filter,error,capacity,priority,maximum,keepRunning);
}
inline bool postJson(const char* url,const char* bearer,const JsonDocument& request,
                     JsonDocument& output,const JsonDocument& filter,char* error,size_t capacity) {
  if(measureJson(request)>kMaximumRequestBytes || request.overflowed()) {
    if(capacity) snprintf(error,capacity,"The question is too long."); return false;
  }
  BoundedText body;
  const size_t bytes=measureJson(request);
  if(!body.reserve(bytes+1) || serializeJson(request,body.data(),body.capacity())!=bytes) {
    if(capacity) snprintf(error,capacity,"Not enough memory for the request."); return false;
  }
  return jsonRequest(url,bearer,body.data(),output,filter,error,capacity);
}
}  // namespace Tamagotchi::Https
namespace Tamagotchi::Http {
inline bool getPublicForecastJson(const char* url,JsonDocument& output,const JsonDocument& filter,
                                 char* error,size_t capacity,
                                 NetworkGate::Priority priority=NetworkGate::Priority::Background,
                                 uint32_t maximum=20000,Https::PlainDeadlineClient::Continue keepRunning=nullptr) {
  return Https::jsonRequest<Https::PlainDeadlineClient>(
      url,nullptr,nullptr,output,filter,error,capacity,priority,maximum,keepRunning);
}
} // namespace Tamagotchi::Http
#endif
