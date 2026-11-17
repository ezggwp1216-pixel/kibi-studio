// Public, temporary hardware acceptance test. No credentials or provider calls.
// Diagnostic owns platform initialization. This is NOT an app_feature recipe.
#include <Arduino.h>
#include <atomic>
#include <cmath>
#include <algorithm>
#include "display_touch.h"
#include "state_info.h"
#include "microphone_i2s.h"
#include "audio_codec_power.h"
#include "power_management.h"
#include "kibi_typography.h"

using namespace Tamagotchi;
static std::atomic<int> requestedMode{0},audioMode{-1},audioError{0},leftLevel{0},rightLevel{0},apCount{-2},bestRssi{-127};
static std::atomic<uint32_t> toneRequest{0},audioStack{0};
static DeviceAudio::Session duplex;
static MicrophoneI2s::StandardDriver micDriver;
static MicrophoneI2s::Capture<MicrophoneI2s::StandardDriver> mic(micDriver);
static DeviceAudio::SharedWireBus codecBus;
static MicrophonePower::Codecs<DeviceAudio::SharedWireBus> codecs(codecBus);
static MicrophonePower::Lifecycle<decltype(mic),decltype(codecs)> lifecycle(mic,codecs);
static uint32_t plusCount=0,minusCount=0,tapCount=0,lastFrame=0,lastReport=0;
static int touchX=-1,touchY=-1;
static bool screenSleeping=false;
static bool trackingTouch=false,touchMoved=false;
static int startX=0,startY=0;

struct DebouncedButton {
 int pin;bool raw=false,stable=false;uint32_t changed=0;
 void begin(){pinMode(pin,INPUT_PULLUP);raw=stable=digitalRead(pin)==LOW;changed=millis();}
 bool pressed(uint32_t now){const bool value=digitalRead(pin)==LOW;if(value!=raw){raw=value;changed=now;}if(raw!=stable&&uint32_t(now-changed)>=35){stable=raw;return stable;}return false;}
};
static DebouncedButton plus{Board::kPlus},minus{Board::kMinus};
static int level(const int16_t* samples,size_t count,size_t stride=1){
 if(!count)return 0;uint64_t sum=0;for(size_t i=0;i<count;i++){const int32_t v=samples[i*stride];sum+=uint64_t(v*v);}return int(std::sqrt(double(sum)/count));
}
static void sound(){requestedMode.store(1);toneRequest.fetch_add(1);}

static void audioWorker(void*){
 PowerManagement::PerformanceLease performance;
 if(!performance.held()){audioError.store(1);vTaskDelete(nullptr);return;}
 bool micHeld=false,duplexHeld=false;int current=-1;uint32_t seenTone=0,primedAt=0,toneCursor=0;
 int16_t samples[512];
 for(;;){
  const int wanted=requestedMode.load();
  if(current!=wanted){
   if(micHeld){if(!lifecycle.standby()){audioError.store(2);vTaskDelay(pdMS_TO_TICKS(10));continue;}micHeld=false;}
   if(duplexHeld){if(!duplex.end()){audioError.store(3);vTaskDelay(pdMS_TO_TICKS(10));continue;}duplexHeld=false;}
   current=-1;audioMode.store(-1);
   if(wanted==0){
    micHeld=true;const auto result=lifecycle.wake([]{return millis();},[](uint32_t ms){vTaskDelay(pdMS_TO_TICKS(ms?ms:1));},[]{return requestedMode.load()!=0;},millis());
    if(result!=MicrophonePower::WakeStatus::Ready){audioError.store(10+int(result));vTaskDelay(pdMS_TO_TICKS(20));continue;}
   }else{
    duplexHeld=true;if(!duplex.begin()){audioError.store(30+int(duplex.lastError()));vTaskDelay(pdMS_TO_TICKS(20));continue;}
    duplex.setVolume(20);seenTone=0;
   }
   current=wanted;audioMode.store(current);audioError.store(0);
  }
  size_t count=0;
  if(current==0){
   const auto result=mic.read(samples,256,count,5);
   if(result==MicrophoneI2s::ReadStatus::Error){audioError.store(50);current=-1;continue;}
   if(count){leftLevel.store(level(samples,count,2));rightLevel.store(level(samples+1,count,2));}
  }else{
   const uint32_t command=toneRequest.load();
   if(command!=seenTone){
    if(!duplex.stopPlayback()||!duplex.preparePlayback()){audioError.store(60);current=-1;continue;}
    seenTone=command;toneCursor=0;primedAt=millis();
   }
   const auto read=duplex.readMicMono(samples,256,count,2);
   if(read==DeviceAudio::Status::Error){audioError.store(61);current=-1;continue;}
   if(count)leftLevel.store(level(samples,count));
   // Measured startup guard from the working speaker test; still service RX/UI.
   if(uint32_t(millis()-primedAt)>=120){
    constexpr uint32_t media=3*2560,drain=1280,total=media+drain;
    const size_t amount=std::min<size_t>(256,total-toneCursor);
    for(size_t i=0;i<amount;i++){
     const uint32_t at=toneCursor+i;
     samples[i]=at<media&&at%2560<1280?int16_t(at%20<10?4000:-4000):0;
    }
    size_t written=0;const auto result=duplex.writeSpeakerMono(samples,amount,written,5);
    if(result==DeviceAudio::Status::Error){audioError.store(62);current=-1;continue;}
    toneCursor+=written;
    // Submit > one full DMA ring of silence after media. No cloud ACK is made.
    if(toneCursor==total){if(!duplex.stopPlayback())audioError.store(63);requestedMode.store(0);}
   }
  }
  audioStack.store(uint32_t(uxTaskGetStackHighWaterMark(nullptr)));vTaskDelay(1);
 }
}

static void radioWorker(void*){
 // ADC2 first sampling has completed. No station credentials are used or saved.
 WiFi.persistent(false);
 if(!WiFi.mode(WIFI_STA)){apCount.store(-3);vTaskDelete(nullptr);return;}
 const int started=WiFi.scanNetworks(true,true,false,180);
 if(started<0&&started!=WIFI_SCAN_RUNNING){apCount.store(-4);vTaskDelete(nullptr);return;}
 int count=started;const uint32_t since=millis();
 while(count==WIFI_SCAN_RUNNING&&uint32_t(millis()-since)<20000){vTaskDelay(pdMS_TO_TICKS(50));count=WiFi.scanComplete();}
 if(count>=0){int strongest=-127;for(int i=0;i<count;i++)strongest=std::max(strongest,int(WiFi.RSSI(i)));bestRssi.store(strongest);apCount.store(count);}else apCount.store(-5);
 WiFi.scanDelete();vTaskDelete(nullptr);
}

static void text(uint16_t* pixels,int x,int y,const char* value,uint16_t color=0xffff){
 using namespace KibiTypography;Framebuffer f{pixels,size_t(240)*296,240,296,240};draw(f,getFace(Font::Body18),value,x,y,color,{0,0,240,296});
}
static void rectangle(uint16_t* pixels,int x,int y,int w,int h,uint16_t color){for(int j=std::max(0,y);j<std::min(296,y+h);j++)for(int i=std::max(0,x);i<std::min(240,x+w);i++)pixels[j*240+i]=color;}
static void render(){
 uint16_t* pixels=prepareDisplayFrame(0);if(!pixels)return;std::fill(pixels,pixels+240*296,0x0000);
 text(pixels,54,21,"KIBI CHECK");char line[64];
 snprintf(line,sizeof(line),"Wi-Fi scan: %d AP",apCount.load());text(pixels,20,56,line);
 snprintf(line,sizeof(line),"Mic L: %d  R: %d",leftLevel.load(),rightLevel.load());text(pixels,20,80,line);
 const auto battery=StateInfoDetail::runtime.info;
 if(battery.batteryPercent<0)snprintf(line,sizeof(line),"Battery: --");else snprintf(line,sizeof(line),"Battery: %d%%",battery.batteryPercent);text(pixels,20,104,line);
 snprintf(line,sizeof(line),"Charge: %s",!battery.chargingKnown?"unknown":battery.charging?"yes":"no");text(pixels,20,128,line);
 snprintf(line,sizeof(line),"Buttons +%lu  -%lu",static_cast<unsigned long>(plusCount),static_cast<unsigned long>(minusCount));text(pixels,20,152,line);
 snprintf(line,sizeof(line),"Touch: %d %d / %lu",touchX,touchY,static_cast<unsigned long>(tapCount));text(pixels,20,176,line);
 snprintf(line,sizeof(line),"Audio %s / E%d",audioMode.load()==0?"stereo":"speaker",audioError.load());text(pixels,20,200,line);
 rectangle(pixels,17,229,65,35,0x39e7);rectangle(pixels,87,229,65,35,0x39e7);rectangle(pixels,157,229,65,35,0x39e7);
 text(pixels,23,236,"- MIC");text(pixels,93,236,"SLEEP");text(pixels,163,236,"+ BEEP");
 if(touchX>=0)rectangle(pixels,touchX-2,touchY-2,5,5,0x07e0);
 presentDisplayFrame();
}
void setup(){
 Serial.begin(115200);PowerManagement::begin();
 if(!beginDisplay()){Serial.println("HTEST display_error=1");return;}
 beginInputBus();beginStateInfo();codecs.standby();codecs.suspendUnusedDac();
 plus.begin();minus.begin();beginTouch();setDisplayBrightnessPercent(65);
 if(xTaskCreatePinnedToCore(audioWorker,"kibi-test-audio",16384,nullptr,2,nullptr,0)!=pdPASS)audioError.store(70);
 if(xTaskCreatePinnedToCore(radioWorker,"kibi-test-radio",8192,nullptr,1,nullptr,1)!=pdPASS)apCount.store(-6);
}
void loop(){
 const uint32_t now=millis();tickDisplayPower(now);updateStateInfo(false,screenSleeping);
 if(plus.pressed(now)){plusCount++;if(screenSleeping){screenSleeping=false;setDisplayAwake(true);}else sound();}
 if(minus.pressed(now)){minusCount++;if(screenSleeping){screenSleeping=false;setDisplayAwake(true);}else requestedMode.store(0);}
 DisplayTouchDetail::TouchEvent event;
 while(nextTouchEvent(event)){
  touchX=event.point.x;touchY=event.point.y;
  if(event.kind==DisplayTouchDetail::TouchKind::Down){trackingTouch=true;touchMoved=false;startX=touchX;startY=touchY;}
  if(event.kind==DisplayTouchDetail::TouchKind::Move&&(std::abs(touchX-startX)>12||std::abs(touchY-startY)>12))touchMoved=true;
  if(event.kind==DisplayTouchDetail::TouchKind::Cancel)trackingTouch=false;
  if(event.kind==DisplayTouchDetail::TouchKind::Up&&trackingTouch&&!touchMoved){
   tapCount++;if(touchY>=225){if(touchX<84)requestedMode.store(0);else if(touchX<155){screenSleeping=true;setDisplayAwake(false);}else sound();}
  }
  if(event.kind==DisplayTouchDetail::TouchKind::Up)trackingTouch=false;
 }
 if(!screenSleeping&&uint32_t(now-lastFrame)>=100){lastFrame=now;render();}
 if(uint32_t(now-lastReport)>=1000){
  lastReport=now;const auto battery=StateInfoDetail::runtime.info;
  Serial.printf("HTEST ms=%lu left=%d right=%d mode=%d audio_error=%d aps=%d rssi=%d plus=%lu minus=%lu taps=%lu x=%d y=%d battery=%d charge_known=%d charge=%d stack=%lu internal=%u\n",
   static_cast<unsigned long>(now),leftLevel.load(),rightLevel.load(),audioMode.load(),audioError.load(),apCount.load(),bestRssi.load(),static_cast<unsigned long>(plusCount),static_cast<unsigned long>(minusCount),static_cast<unsigned long>(tapCount),touchX,touchY,battery.batteryPercent,int(battery.chargingKnown),int(battery.charging),static_cast<unsigned long>(audioStack.load()),unsigned(heap_caps_get_free_size(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT)));
 }
 delay(2);
}
