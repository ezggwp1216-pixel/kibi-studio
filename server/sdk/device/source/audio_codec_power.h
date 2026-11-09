#pragma once
#include <cstddef>
#include <cstdint>
#include <atomic>

namespace Tamagotchi::AudioOwnership {
// Positive values are legacy capture/codec leases, -1 is one duplex owner.
// Codec operations also lease the bus, so DAC standby cannot race speaker init.
inline std::atomic<int32_t> users{0};
inline bool legacyAcquire() {
  int32_t value=users.load();
  while(value>=0) { if(users.compare_exchange_weak(value,value+1)) return true; }
  return false;
}
inline void legacyRelease() { users.fetch_sub(1); }
inline bool duplexAcquire() {int32_t empty=0;return users.compare_exchange_strong(empty,-1);}
inline void duplexRelease() {users.store(0);}
class LegacyLease {
 public:
  LegacyLease():held_(legacyAcquire()) {}
  ~LegacyLease() {if(held_)legacyRelease();}
  explicit operator bool() const {return held_;}
 private:
  bool held_;
};
}

namespace Tamagotchi::MicrophonePower {
inline constexpr uint32_t kReadyBudgetMs=600,kClockPrerollMs=80;
enum class WakeStatus : uint8_t { Ready,Cancelled,TimedOut,DriverError,CodecError };
enum class DacStatus : uint8_t { Absent,Suspended,WriteError };
struct Register { uint8_t address,value; };

// Preserve the DS02's working stereo initialization, bias and 30 dB gain.
inline constexpr Register kInitializeAdc[]={
  {0x00,0xFF},{0x00,0x41},{0x01,0x3F},{0x09,0x30},{0x0A,0x30},{0x23,0x2A},
  {0x22,0x0A},{0x20,0x0A},{0x21,0x2A},{0x08,0x10},{0x40,0x43},{0x41,0x70},
  {0x42,0x70},{0x07,0x20},{0x02,0xC1},{0x11,0x60},{0x12,0x00},{0x01,0x34},
  {0x06,0x00},{0x47,0x08},{0x48,0x08},{0x4B,0x00},{0x4C,0xFF},{0x43,0x1A},
  {0x44,0x1A},{0x40,0x43},{0x00,0x71},{0x00,0x41}
};
// Standby sequences derived from Espressif Systems' Apache-2.0 esp_codec_dev:
// https://github.com/espressif/esp-adf/blob/release/v2.x/components/esp_codec_dev/device/es7210/es7210.c#L294-L306
// https://github.com/espressif/esp-adf/blob/release/v2.x/components/esp_codec_dev/device/es8311/es8311.c#L265-L286
inline constexpr Register kStandbyAdc[]={
  {0x47,0xFF},{0x48,0xFF},{0x49,0xFF},{0x4A,0xFF},{0x4B,0xFF},{0x4C,0xFF},
  {0x40,0xC0},{0x01,0x7F},{0x06,0x07}
};
inline constexpr Register kSuspendDac[]={
  {0x32,0x00},{0x17,0x00},{0x0E,0xFF},{0x12,0x02},{0x14,0x00},{0x0D,0xFA},
  {0x15,0x00},{0x02,0x10},{0x00,0x00},{0x00,0x1F},{0x01,0x30},{0x01,0x00},
  {0x45,0x00},{0x0D,0xFC},{0x02,0x00}
};

template<class Bus> class Codecs {
 public:
  explicit Codecs(Bus& bus):bus_(bus) {}
  template<class Clock,class Cancelled>
  WakeStatus initialize(Clock clock,Cancelled cancelled,uint32_t started) {
    AudioOwnership::LegacyLease lease;
    if(!lease) return WakeStatus::DriverError;
    for(const auto reg:kInitializeAdc) {
      if(cancelled()) return WakeStatus::Cancelled;
      // Each Wire transaction has the existing 20 ms timeout. Do not start one
      // unless it fits the remaining shared budget; never change the shared bus.
      if(uint32_t(clock()-started)>=kReadyBudgetMs-20) return WakeStatus::TimedOut;
      if(!bus_.write(0x40,reg.address,reg.value)) return WakeStatus::CodecError;
    }
    if(cancelled()) return WakeStatus::Cancelled;
    return uint32_t(clock()-started)>=kReadyBudgetMs?WakeStatus::TimedOut:WakeStatus::Ready;
  }
  bool standby() { AudioOwnership::LegacyLease lease;return lease && writeAll(0x40,kStandbyAdc); }
  DacStatus suspendUnusedDac() {
    AudioOwnership::LegacyLease lease;
    if(!lease) return DacStatus::WriteError;
    if(dacChecked_) return dacStatus_;
    dacChecked_=true;
    if(bus_.present(0x18)) dacStatus_=writeAll(0x18,kSuspendDac)?DacStatus::Suspended:DacStatus::WriteError;
    return dacStatus_;
  }
 private:
  template<size_t N> bool writeAll(uint8_t address,const Register (&sequence)[N]) {
    bool ok=true;
    // A failed write must not prevent attempts to shut down the other blocks.
    for(const auto reg:sequence) { const bool written=bus_.write(address,reg.address,reg.value); ok=written && ok; }
    return ok;
  }
  Bus& bus_;
  bool dacChecked_=false;
  DacStatus dacStatus_=DacStatus::Absent;
};

template<class Capture,class Codec> class Lifecycle {
 public:
  Lifecycle(Capture& capture,Codec& codec):capture_(capture),codec_(codec) {}
  template<class Clock,class Pause,class Cancelled>
  WakeStatus wake(Clock clock,Pause pause,Cancelled cancelled,uint32_t started) {
    if(cancelled()) return WakeStatus::Cancelled;
    // Failed cleanup is retried and must succeed before a fresh capture.
    if(attempted_ && !standbyKnown_ && !standby()) return WakeStatus::CodecError;
    if(!leased_) {
      if(!AudioOwnership::legacyAcquire()) return WakeStatus::DriverError;
      leased_=true;
    }
    attempted_=true;standbyKnown_=false;
    if(uint32_t(clock()-started)>=kReadyBudgetMs) return WakeStatus::TimedOut;
    if(!capture_.begin() || !capture_.start()) return WakeStatus::DriverError;
    const uint32_t clockAt=clock();
    while(uint32_t(clock()-clockAt)<kClockPrerollMs) {
      if(cancelled()) return WakeStatus::Cancelled;
      if(uint32_t(clock()-started)>=kReadyBudgetMs) return WakeStatus::TimedOut;
      pause(5);
    }
    return codec_.initialize(clock,cancelled,started);
  }
  bool standby() {
    if(standbyKnown_) return true;
    // Power down the analog/ADC/bias blocks while MCLK is still available.
    // end() deletes the channel: disable() alone leaves MCLK running in IDF.
    const bool codecOk=codec_.standby();
    const bool driverOk=capture_.end();
    standbyKnown_=codecOk && driverOk;
    // A codec fault remains reportable/retriable, but cannot retain a lease
    // after all channel resources are gone (the owner may be a local boot scope).
    if(driverOk && leased_) {AudioOwnership::legacyRelease();leased_=false;}
    return standbyKnown_;
  }
  bool standbyKnown() const { return standbyKnown_; }
 private:
  Capture& capture_;
  Codec& codec_;
  bool attempted_=false,standbyKnown_=false,leased_=false;
};

// Explicit close reports failures before success can escape; destruction is the
// cancellation/error safety net, reporting the same checked result to its owner.
template<class Owner,class Observe> class StandbyScope {
 public:
  StandbyScope(Owner& owner,Observe observe):owner_(owner),observe_(observe) {}
  StandbyScope(const StandbyScope&)=delete;
  StandbyScope& operator=(const StandbyScope&)=delete;
  ~StandbyScope() { if(!closed_) close(); }
  bool close() {
    if(closed_) return result_;
    closed_=true; result_=owner_.standby(); observe_(result_); return result_;
  }
 private:
  Owner& owner_;
  Observe observe_;
  bool closed_=false,result_=false;
};
} // namespace Tamagotchi::MicrophonePower

namespace Tamagotchi::DeviceAudio {
enum class Status : uint8_t {Ok,TimedOut,Error,Unsupported,Busy};
enum class Error : uint8_t {None,Unsupported,Busy,Driver,Codec,InvalidArgument,TimedOut};
inline constexpr size_t kMaxSamples=256;
inline constexpr uint32_t kSampleRate=16000,kMaxIoWaitMs=20;
// MIT: ALTIO-AI-PRIVATE-LIMITED/cheeko-gotchi, hardware_test, commit d6bf1f81.
// See docs/hardware/ostb-audio-reference.md for provenance and retained licence.
/* Copyright (c) 2026 ALTIO AI Private Limited
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE. */
// ES8311 volume 0xBF = 0 dB; 0xFF would boost to +32 dB and is never used.
inline constexpr MicrophonePower::Register kInitializeDac[]={
  {0x00,0x1F},{0x00,0x00},{0x00,0x80},{0x01,0x3F},{0x02,0x00},{0x03,0x10},
  {0x04,0x10},{0x05,0x00},{0x06,0x03},{0x07,0x00},{0x08,0xFF},{0x09,0x0C},
  {0x0A,0x0C},{0x0D,0x01},{0x0E,0x02},{0x12,0x00},{0x13,0x10},{0x1C,0x6A},
  {0x31,0x00},{0x32,0xBF},{0x37,0x08}
};

// One worker owns this object. RX and TX run simultaneously in hardware;
// interleave these bounded calls, and stopPlayback at end-of-utterance/cancel.
// Bus is the already initialized shared Wire bus: never change its clock/timeout.
template<class Driver,class Bus> class SessionCore {
 public:
  SessionCore(Driver& driver,Bus& bus,bool supported):driver_(driver),bus_(bus),supported_(supported) {}
  SessionCore(const SessionCore&)=delete;
  SessionCore& operator=(const SessionCore&)=delete;
  ~SessionCore() {end();}
  bool begin() {
    if(!supported_) {error_=Error::Unsupported;return false;}
    if(ready_) return true;
    if(owned_ || !AudioOwnership::duplexAcquire()) {error_=Error::Busy;return false;}
    owned_=true;
    if(!driver_.begin()) return fail(Error::Driver);
    driver_.pause(MicrophonePower::kClockPrerollMs);
    if(!bus_.present(0x18) || !bus_.present(0x40)) return fail(Error::Codec);
    codecsTouched_=true;
    if(!writeAll(0x18,kInitializeDac,true) || !writeAll(0x40,MicrophonePower::kInitializeAdc)) return fail(Error::Codec);
    ready_=true;error_=Error::None;return true;
  }
  bool end() {
    primed_=false;playing_=false;
    if(!owned_) return true;
    driver_.amp(false);ready_=false;
    bool codecOkay=true;
    if(codecsTouched_) {
      // Clock remains available until both analog blocks have been suspended.
      const bool adc=writeAll(0x40,MicrophonePower::kStandbyAdc);
      const bool dac=writeAll(0x18,MicrophonePower::kSuspendDac);
      codecOkay=adc && dac;
    }
    const bool driverOkay=driver_.end();
    if(driverOkay) {owned_=false;codecsTouched_=false;AudioOwnership::duplexRelease();}
    if(!driverOkay) error_=Error::Driver;
    else if(!codecOkay) error_=Error::Codec;
    return codecOkay && driverOkay;
  }
  bool setVolume(uint8_t percent) {
    if(percent>100) {error_=Error::InvalidArgument;return false;}
    volume_=percent;
    if(!percent && ready_) return stopPlayback();
    return true;
  }
  bool stopPlayback() {
    primed_=false;playing_=false;
    if(!owned_) return true;
    driver_.amp(false);
    if(!ready_) return true;
    if(!driver_.stopPlayback()) {error_=Error::Driver;return false;}
    return true;
  }
  // Request amp-on before media. The owner supplies any measured guard;
  // this does not wait, submit PCM, or claim analog readiness.
  bool preparePlayback() {
    if(!supported_) {error_=Error::Unsupported;return false;}
    if(!owned_ || !ready_) {error_=Error::Driver;return false;}
    if(!volume_) {error_=Error::InvalidArgument;return false;}
    if(primed_ || playing_) {error_=Error::None;return true;}
    if(!driver_.preparePlayback()) {
      primed_=false;playing_=false;driver_.amp(false);error_=Error::Driver;return false;
    }
    primed_=true;error_=Error::None;return true;
  }
  Status readMicMono(int16_t* target,size_t capacity,size_t& samples,uint32_t timeoutMs=20) {
    samples=0;
    const Status state=check(target,capacity);
    if(state!=Status::Ok) return state;
    int16_t stereo[kMaxSamples*2];size_t bytes=0;
    const Status result=driver_.read(stereo,capacity*4,bytes,boundedWait(timeoutMs));
    if(result==Status::Error || bytes>capacity*4 || bytes%4) return ioFailure(Status::Error);
    samples=bytes/4;
    for(size_t i=0;i<samples;++i) target[i]=stereo[i*2];
    // An RX wait is not a playback interruption. Return any aligned partial
    // microphone frames and let the owner retry without resetting the TX clock.
    if(result==Status::TimedOut) {error_=Error::TimedOut;return result;}
    error_=Error::None;return result;
  }
  Status writeSpeakerMono(const int16_t* source,size_t count,size_t& samples,uint32_t timeoutMs=20) {
    samples=0;
    const Status state=check(source,count);
    if(state!=Status::Ok) return state;
    int16_t stereo[kMaxSamples*2];bool nonzero=false;
    for(size_t i=0;i<count;++i) {
      const int16_t value=int16_t(int32_t(source[i])*volume_/100);
      stereo[i*2]=stereo[i*2+1]=value;nonzero|=value!=0;
    }
    // Silence is PCM within an utterance, never an implicit cancellation.
    // Leave queued tails and clocks alone; only explicit stop/mute flushes TX.
    playing_=volume_>0 && (playing_ || nonzero);
    if(playing_) primed_=false;
    driver_.amp(volume_>0 && (primed_ || playing_));
    size_t bytes=0;
    const Status result=driver_.write(stereo,count*4,bytes,boundedWait(timeoutMs));
    if(result!=Status::Ok || bytes!=count*4) return ioFailure(result==Status::TimedOut?result:Status::Error);
    samples=bytes/4;error_=Error::None;return Status::Ok;
  }
  bool ready() const {return ready_;}
  bool playing() const {return playing_;}
  Error lastError() const {return error_;}
 private:
  template<size_t N> bool writeAll(uint8_t address,const MicrophonePower::Register (&sequence)[N],bool resetPause=false) {
    bool okay=true;
    for(size_t i=0;i<N;++i) {
      const bool written=bus_.write(address,sequence[i].address,sequence[i].value);okay=written && okay;
      if(resetPause && i==0) driver_.pause(20);
    }
    return okay;
  }
  bool fail(Error reason) {end();error_=reason;return false;}
  static uint32_t boundedWait(uint32_t requested) {return requested>kMaxIoWaitMs?kMaxIoWaitMs:requested;}
  Status check(const void* buffer,size_t count) {
    if(!supported_) {error_=Error::Unsupported;return Status::Unsupported;}
    if(!ready_) {error_=Error::Driver;return Status::Error;}
    if(!buffer || !count || count>kMaxSamples) {stopPlayback();error_=Error::InvalidArgument;return Status::Error;}
    return Status::Ok;
  }
  Status ioFailure(Status status) {
    stopPlayback();error_=status==Status::TimedOut?Error::TimedOut:Error::Driver;return status;
  }
  Driver& driver_;Bus& bus_;
  const bool supported_;
  bool owned_=false,ready_=false,playing_=false,primed_=false,codecsTouched_=false;
  uint8_t volume_=20;
  Error error_=Error::None;
};
} // namespace Tamagotchi::DeviceAudio

#ifdef ARDUINO
#include "config.h"
#if __has_include("kibi_screen_config.h")
#include "kibi_screen_config.h"
#endif
#include <Arduino.h>
#include <Wire.h>
#include <driver/i2s_std.h>
#include <esp_attr.h>
#include <esp_memory_utils.h>
#include <freertos/FreeRTOS.h>
#if !defined(CONFIG_I2S_ISR_IRAM_SAFE) || !CONFIG_I2S_ISR_IRAM_SAFE
#error "Kibi duplex audio requires the installed IRAM-safe standard I2S driver"
#endif

namespace Tamagotchi::DeviceAudio {
struct SharedWireBus {
  bool present(uint8_t address) {Wire.beginTransmission(address);return Wire.endTransmission()==0;}
  bool write(uint8_t address,uint8_t reg,uint8_t value) {
    Wire.beginTransmission(address);Wire.write(reg);Wire.write(value);return Wire.endTransmission()==0;
  }
};
class StandardDuplexDriver {
 public:
  bool begin() {
    // IDF callbacks run with flash cache disabled. A Session in PSRAM is rejected
    // before allocation or pin routing; use a static/global Session in DRAM.
    if(!esp_ptr_internal(&state_)) return false;
    pinMode(Board::kAmplifier,OUTPUT);pinsReady_=true;amp(false);
    i2s_chan_config_t channel=I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0,I2S_ROLE_MASTER);
    channel.dma_desc_num=4;channel.dma_frame_num=128;channel.auto_clear=true;
    if(i2s_new_channel(&channel,&tx_,&rx_)!=ESP_OK) return false;
    i2s_std_config_t standard{};
    standard.clk_cfg=I2S_STD_CLK_DEFAULT_CONFIG(kSampleRate);
    standard.clk_cfg.mclk_multiple=I2S_MCLK_MULTIPLE_256;
    standard.slot_cfg=I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT,I2S_SLOT_MODE_STEREO);
    standard.gpio_cfg.mclk=gpio_num_t(Board::kMicMclk);standard.gpio_cfg.bclk=gpio_num_t(Board::kMicBclk);
    standard.gpio_cfg.ws=gpio_num_t(Board::kMicWs);standard.gpio_cfg.din=gpio_num_t(Board::kMicDin);
    standard.gpio_cfg.dout=gpio_num_t(Board::kSpeakerDout);
    if(i2s_channel_init_std_mode(tx_,&standard)!=ESP_OK || i2s_channel_init_std_mode(rx_,&standard)!=ESP_OK) return false;
    i2s_event_callbacks_t callbacks{};callbacks.on_recv=received;callbacks.on_recv_q_ovf=overflowed;
    if(i2s_channel_register_event_callback(rx_,&callbacks,&state_)!=ESP_OK) return false;
    if(i2s_channel_enable(tx_)!=ESP_OK) return false;
    txEnabled_=true;
    if(i2s_channel_enable(rx_)!=ESP_OK) return false;
    rxEnabled_=true;return true;
  }
  bool end() {
    amp(false);bool okay=true;
    if(rxEnabled_) {if(i2s_channel_disable(rx_)==ESP_OK)rxEnabled_=false;else okay=false;}
    if(txEnabled_) {if(i2s_channel_disable(tx_)==ESP_OK)txEnabled_=false;else okay=false;}
    if(rx_ && !rxEnabled_) {if(i2s_del_channel(rx_)==ESP_OK)rx_=nullptr;else okay=false;}
    if(tx_ && !txEnabled_) {if(i2s_del_channel(tx_)==ESP_OK)tx_=nullptr;else okay=false;}
    if(okay) pinsReady_=false;
    return okay;
  }
  void amp(bool enabled) {if(pinsReady_)digitalWrite(Board::kAmplifier,enabled?HIGH:LOW);}
  bool preparePlayback() {
    if(!pinsReady_ || !txEnabled_ || !rxEnabled_) return false;
    amp(true);return true;
  }
  void pause(uint32_t ms) {delay(ms);}
  bool stopPlayback() {
    amp(false);
    if(!txEnabled_) return false;
    if(i2s_channel_disable(tx_)!=ESP_OK) return false;
    txEnabled_=false;
    // disable() resets the TX queue/cursor, but retains DMA memory. In READY
    // state preload starts at descriptor zero: clear all four 128-frame stereo
    // descriptors before restarting, otherwise a cancelled utterance can replay.
    const int16_t silence[4*128*2]={};size_t cleared=0;
    if(i2s_channel_preload_data(tx_,silence,sizeof(silence),&cleared)!=ESP_OK || cleared!=sizeof(silence)) return false;
    if(i2s_channel_enable(tx_)!=ESP_OK) return false;
    txEnabled_=true;return true;
  }
  Status read(int16_t* out,size_t capacity,size_t& bytes,uint32_t timeoutMs) {
    bytes=0;
    if(!rxEnabled_ || !out || !capacity || capacity>kMaxSamples*4 || capacity%4) return Status::Error;
    return transfer(capacity,bytes,timeoutMs,[&](size_t offset,size_t remaining,size_t& moved) {
      return i2s_channel_read(rx_,reinterpret_cast<uint8_t*>(out)+offset,remaining,&moved,0);
    });
  }
  Status write(const int16_t* in,size_t size,size_t& bytes,uint32_t timeoutMs) {
    bytes=0;
    if(!txEnabled_ || !in || !size || size>kMaxSamples*4 || size%4) return Status::Error;
    return transfer(size,bytes,timeoutMs,[&](size_t offset,size_t remaining,size_t& moved) {
      return i2s_channel_write(tx_,reinterpret_cast<const uint8_t*>(in)+offset,remaining,&moved,0);
    });
  }
 private:
  struct State {portMUX_TYPE lock=portMUX_INITIALIZER_UNLOCKED;uint32_t received=0,overflowed=0;} state_;
  i2s_chan_handle_t tx_=nullptr,rx_=nullptr;
  bool txEnabled_=false,rxEnabled_=false,pinsReady_=false;
  template<class Transfer> static Status transfer(size_t total,size_t& bytes,uint32_t timeoutMs,Transfer operation) {
    const uint32_t budget=timeoutMs>kMaxIoWaitMs?kMaxIoWaitMs:timeoutMs;
    const uint32_t started=millis();
    // IDF applies its timeout separately to internal DMA waits. Request zero
    // driver waiting and enforce one total wall-clock budget across all partial
    // buffers instead. Byte offsets may cross any aligned position in the ring.
    bool first=true;
    for(;;) {
      if(!first && uint32_t(millis()-started)>=budget) return Status::TimedOut;
      first=false;
      size_t moved=0;const size_t remaining=total-bytes;
      const esp_err_t result=operation(bytes,remaining,moved);
      if(moved>remaining || moved%4 || (result!=ESP_OK && result!=ESP_ERR_TIMEOUT)) return Status::Error;
      bytes+=moved;
      if(bytes==total) return Status::Ok;
      if(uint32_t(millis()-started)>=budget) return Status::TimedOut;
      if(!moved) delay(1);
    }
  }
  static bool IRAM_ATTR received(i2s_chan_handle_t,i2s_event_data_t*,void* context) {
    auto& state=*static_cast<State*>(context);portENTER_CRITICAL_ISR(&state.lock);++state.received;portEXIT_CRITICAL_ISR(&state.lock);return false;
  }
  static bool IRAM_ATTR overflowed(i2s_chan_handle_t,i2s_event_data_t*,void* context) {
    auto& state=*static_cast<State*>(context);portENTER_CRITICAL_ISR(&state.lock);++state.overflowed;portEXIT_CRITICAL_ISR(&state.lock);return false;
  }
};
class Session {
 public:
  Session():core_(driver_,bus_,supported()) {}
  Session(const Session&)=delete;
  Session& operator=(const Session&)=delete;
  bool begin() {return core_.begin();}
  bool end() {return core_.end();}
  bool setVolume(uint8_t percent) {return core_.setVolume(percent);}
  bool stopPlayback() {return core_.stopPlayback();}
  bool preparePlayback() {return core_.preparePlayback();}
  bool ready() const {return core_.ready();}
  bool playing() const {return core_.playing();}
  Error lastError() const {return core_.lastError();}
  Status readMicMono(int16_t* out,size_t capacity,size_t& samples,uint32_t timeoutMs=20) {return core_.readMicMono(out,capacity,samples,timeoutMs);}
  Status writeSpeakerMono(const int16_t* in,size_t count,size_t& samples,uint32_t timeoutMs=20) {return core_.writeSpeakerMono(in,count,samples,timeoutMs);}
 private:
  static constexpr bool supported() {
#if defined(KIBI_DEVICE_HAS_SPEAKER) && KIBI_DEVICE_HAS_SPEAKER == 1
    return true;
#else
    return false;
#endif
  }
  StandardDuplexDriver driver_;
  SharedWireBus bus_;
  SessionCore<StandardDuplexDriver,SharedWireBus> core_;
};
} // namespace Tamagotchi::DeviceAudio
#endif
