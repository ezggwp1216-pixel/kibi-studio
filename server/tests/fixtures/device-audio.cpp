#include "audio_codec_power.h"
#include <cassert>
#include <vector>
#include <tuple>
using namespace Tamagotchi;

struct Bus {
 bool found=true,fail=false;
 unsigned calls=0;
 std::vector<std::tuple<uint8_t,uint8_t,uint8_t>> writes;
 bool present(uint8_t) {++calls;return found;}
 bool write(uint8_t a,uint8_t r,uint8_t v) {++calls;writes.emplace_back(a,r,v);return !fail;}
};
struct Driver {
 bool ampOn=false,active=false,failBegin=false,failEnd=false,malformed=false;
 unsigned calls=0,stops=0;uint32_t timeout=0;
 DeviceAudio::Status outcome=DeviceAudio::Status::Ok;
 std::vector<int16_t> received{100,-100,32767,-32768};
 std::vector<int16_t> sent;
 bool begin() {++calls;active=true;return !failBegin;}
 bool end() {++calls;if(failEnd)return false;active=false;return true;}
 void amp(bool value) {++calls;ampOn=value;}
 bool preparePlayback() {++calls;if(!active)return false;ampOn=true;return true;}
 void pause(uint32_t) {++calls;}
 bool stopPlayback() {++calls;++stops;sent.clear();return true;}
 DeviceAudio::Status read(int16_t* target,size_t bytes,size_t& read,uint32_t ms) {
  ++calls;timeout=ms;read=malformed?3:received.size()*2;
  for(size_t i=0;i<received.size()&&i<bytes/2;++i)target[i]=received[i];
  return outcome;
 }
 DeviceAudio::Status write(const int16_t* source,size_t bytes,size_t& written,uint32_t ms) {
  ++calls;timeout=ms;sent.assign(source,source+bytes/2);written=malformed?3:bytes;return outcome;
 }
};
using Audio=DeviceAudio::SessionCore<Driver,Bus>;

int main() {
 {
  Bus bus;Driver driver;Audio audio(driver,bus,false);
  assert(!audio.begin()&&audio.lastError()==DeviceAudio::Error::Unsupported);
  size_t count=55;int16_t sample=1;
  assert(audio.writeSpeakerMono(&sample,1,count,2000)==DeviceAudio::Status::Unsupported&&count==0);
  assert(audio.end()&&driver.calls==0&&bus.calls==0);
 }
 {
  Bus bus;Driver driver;Audio audio(driver,bus,true);
  assert(audio.begin()&&audio.ready()&&!audio.playing()&&!driver.ampOn);
  bool dacZeroDb=false;
  for(const auto& w:bus.writes)if(std::get<0>(w)==0x18&&std::get<1>(w)==0x32){assert(std::get<2>(w)<=0xbf);dacZeroDb=true;}
  assert(dacZeroDb);
  int16_t samples[]={32767,-32768,10000};size_t count=0;
  assert(audio.writeSpeakerMono(samples,3,count,5000)==DeviceAudio::Status::Ok&&count==3);
  assert(driver.timeout==20&&driver.ampOn&&audio.playing());
  assert((driver.sent==std::vector<int16_t>{6553,6553,-6553,-6553,2000,2000}));
  const unsigned stops=driver.stops;int16_t silence[2]={0,0};
  assert(audio.writeSpeakerMono(silence,2,count)==DeviceAudio::Status::Ok&&count==2);
  assert(driver.stops==stops&&driver.ampOn&&audio.playing());
  assert((driver.sent==std::vector<int16_t>{0,0,0,0}));
  assert(!audio.setVolume(101));assert(audio.setVolume(100));
  assert(audio.writeSpeakerMono(samples,3,count,0)==DeviceAudio::Status::Ok);
  assert((driver.sent==std::vector<int16_t>{32767,32767,-32768,-32768,10000,10000}));
  assert(audio.stopPlayback()&&!driver.ampOn&&!audio.playing());
  int16_t mic[2]={};
  assert(audio.readMicMono(mic,2,count,5000)==DeviceAudio::Status::Ok&&count==2);
  assert(mic[0]==100&&mic[1]==32767&&driver.timeout==20);
  assert(audio.setVolume(0));
  assert(audio.writeSpeakerMono(samples,3,count)==DeviceAudio::Status::Ok&&!driver.ampOn);
  assert(audio.end()&&!audio.ready()&&!driver.active&&!driver.ampOn);
 }
 {
  Bus bus;Driver a,b;Audio first(a,bus,true),second(b,bus,true);
  assert(first.begin());assert(!second.begin()&&second.lastError()==DeviceAudio::Error::Busy);
  assert(b.calls==0);
  MicrophonePower::Codecs codecs(bus);const unsigned before=bus.calls;
  assert(!codecs.standby());assert(codecs.suspendUnusedDac()==MicrophonePower::DacStatus::WriteError);
  assert(bus.calls==before);assert(first.end());assert(second.begin());assert(second.end());
 }
 {
  Bus bus;Driver driver;Audio audio(driver,bus,true);driver.failBegin=true;
  assert(!audio.begin()&&!driver.ampOn&&!driver.active&&audio.lastError()==DeviceAudio::Error::Driver);
  driver.failBegin=false;assert(audio.begin());
  int16_t sample=100;size_t count=5;
  assert(audio.writeSpeakerMono(&sample,257,count)==DeviceAudio::Status::Error&&count==0&&!driver.ampOn);
  driver.outcome=DeviceAudio::Status::TimedOut;
  assert(audio.writeSpeakerMono(&sample,1,count)==DeviceAudio::Status::TimedOut&&!driver.ampOn);
  assert(audio.lastError()==DeviceAudio::Error::TimedOut);
  driver.outcome=DeviceAudio::Status::Ok;
  assert(audio.writeSpeakerMono(&sample,1,count)==DeviceAudio::Status::Ok&&driver.ampOn);
  driver.outcome=DeviceAudio::Status::TimedOut;
  int16_t timedOutMic[2];
  assert(audio.readMicMono(timedOutMic,2,count)==DeviceAudio::Status::TimedOut&&driver.ampOn);
  driver.outcome=DeviceAudio::Status::Ok;driver.malformed=true;
  assert(audio.writeSpeakerMono(&sample,1,count)==DeviceAudio::Status::Error&&!driver.ampOn&&count==0);
  int16_t mic[2];assert(audio.readMicMono(mic,2,count)==DeviceAudio::Status::Error&&count==0);
  driver.malformed=false;driver.failEnd=true;
  assert(!audio.end()&&!driver.ampOn);
  Bus otherBus;Driver other;Audio blocked(other,otherBus,true);assert(!blocked.begin());
  driver.failEnd=false;assert(audio.end());assert(blocked.begin());assert(blocked.end());
 }
 {
  Bus bus;bus.fail=true;Driver driver;Audio audio(driver,bus,true);
  assert(!audio.begin()&&!audio.ready()&&!driver.ampOn&&!driver.active);
  assert(audio.lastError()==DeviceAudio::Error::Codec);
  bus.fail=false;assert(audio.begin());assert(audio.end());
 }
 {
  struct Capture {
   bool active=false;
   bool begin(){active=true;return true;}bool start(){return true;}bool end(){active=false;return true;}
  } capture;
  Bus bus;MicrophonePower::Codecs codecs(bus);MicrophonePower::Lifecycle lifecycle(capture,codecs);
  uint32_t now=0;auto clock=[&]{return now;};auto pause=[&](uint32_t ms){now+=ms;};
  assert(lifecycle.wake(clock,pause,[]{return false;},0)==MicrophonePower::WakeStatus::Ready);
  Driver driver;Audio audio(driver,bus,true);
  assert(!audio.begin()&&driver.calls==0);
  bus.fail=true;assert(!lifecycle.standby());bus.fail=false;
  assert(lifecycle.wake(clock,pause,[]{return false;},now)==MicrophonePower::WakeStatus::Ready);
  assert(!audio.begin()&&driver.calls==0);
  assert(lifecycle.standby());assert(audio.begin());assert(audio.end());
 }
 {
  Bus bus;
  struct Capture {bool begin(){return true;}bool start(){return true;}bool end(){return true;}} capture;
  {
   MicrophonePower::Codecs codecs(bus);MicrophonePower::Lifecycle local(capture,codecs);
   uint32_t now=0;
   assert(local.wake([&]{return now;},[&](uint32_t ms){now+=ms;},[]{return false;},0)==MicrophonePower::WakeStatus::Ready);
   bus.fail=true;assert(!local.standby());
  }
  bus.fail=false;Driver driver;Audio audio(driver,bus,true);
  assert(audio.begin()&&audio.end());
 }
}
