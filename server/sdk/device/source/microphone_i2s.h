#pragma once
#include "config.h"

namespace Tamagotchi::MicrophoneI2s {
struct Configuration {
  uint32_t rate=kAudioSampleRate;
  unsigned sampleBits=16,channels=2,mclkMultiple=256,dmaDescriptors=8,dmaFrames=512;
  int mclk=Board::kMicMclk,bclk=Board::kMicBclk,ws=Board::kMicWs,din=Board::kMicDin;
};
inline constexpr Configuration kConfiguration{};
enum class ReadStatus { Ok,TimedOut,Error };
struct Counters {
  uint32_t rxDone=0,rxOverflow=0;
  __attribute__((always_inline)) inline void recordReceived() { ++rxDone; }
  __attribute__((always_inline)) inline void recordOverflow() { ++rxOverflow; }
};
// One worker owns this channel. Driver callbacks only touch their bounded DRAM
// counters. No waveform, flash, allocation or network work happens in an ISR.
template<class Driver> class Capture {
 public:
  explicit Capture(Driver& driver):driver_(driver) {}
  Capture(const Capture&)=delete;
  Capture& operator=(const Capture&)=delete;
  ~Capture() { end(); }
  bool begin() {
    if(created_ || !driver_.create(kConfiguration)) return false;
    created_=true;
    // Configuration can start MCLK before a later step fails. Keep ownership
    // until the codec-aware caller powers down the ADC and invokes end().
    if(!driver_.configure(kConfiguration) || !driver_.registerCallbacks()) return false;
    ready_=true; return true;
  }
  bool start() {
    if(!ready_ || running_) return false;
    driver_.resetCounters();
    if(!driver_.enable()) return false;
    // The standard driver's enable resets its RX queue; disable resets the
    // partial-buffer cursor. Previous captures cannot enter the fresh read.
    running_=true; return true;
  }
  bool stop() {
    if(!running_ || !driver_.disable()) return false;
    running_=false; return true;
  }
  bool end() {
    if(!created_) return true;
    if(running_ && !stop()) return false;
    if(!driver_.destroy()) return false;
    created_=ready_=false; return true;
  }
  ReadStatus read(int16_t* stereo,size_t capacity,size_t& frames,uint32_t timeoutMs) {
    frames=0;
    if(!running_ || !stereo || !capacity || capacity>SIZE_MAX/4) return ReadStatus::Error;
    size_t bytes=0;
    const auto status=driver_.read(stereo,capacity*4,bytes,timeoutMs);
    if(status==ReadStatus::Error || bytes>capacity*4 || bytes%4) return ReadStatus::Error;
    frames=bytes/4; return status;
  }
  bool ready() const { return ready_; }
  bool running() const { return running_; }
  Counters snapshot() { return driver_.snapshot(); }
  float sampleRate() { return ready_?driver_.sampleRate():0; }
 private:
  Driver& driver_;
  bool created_=false,ready_=false,running_=false;
};
}

#ifdef ARDUINO
#include <driver/i2s_std.h>
#include <esp_attr.h>
#include <esp_memory_utils.h>
#include <freertos/FreeRTOS.h>
#if !defined(CONFIG_I2S_ISR_IRAM_SAFE) || !CONFIG_I2S_ISR_IRAM_SAFE
#error "kibi microphone requires an IRAM-safe standard I2S driver in the installed SDK"
#endif

namespace Tamagotchi::MicrophoneI2s {
class StandardDriver {
 public:
  bool create(const Configuration& config) {
    i2s_chan_config_t channel=I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0,I2S_ROLE_MASTER);
    channel.dma_desc_num=config.dmaDescriptors; channel.dma_frame_num=config.dmaFrames;
    return i2s_new_channel(&channel,nullptr,&channel_)==ESP_OK;
  }
  bool configure(const Configuration& config) {
    i2s_std_config_t standard{};
    standard.clk_cfg=I2S_STD_CLK_DEFAULT_CONFIG(config.rate);
    standard.clk_cfg.mclk_multiple=I2S_MCLK_MULTIPLE_256;
    standard.slot_cfg=I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT,I2S_SLOT_MODE_STEREO);
    standard.gpio_cfg.mclk=gpio_num_t(config.mclk); standard.gpio_cfg.bclk=gpio_num_t(config.bclk);
    standard.gpio_cfg.ws=gpio_num_t(config.ws); standard.gpio_cfg.din=gpio_num_t(config.din);
    standard.gpio_cfg.dout=I2S_GPIO_UNUSED;
    return i2s_channel_init_std_mode(channel_,&standard)==ESP_OK;
  }
  bool registerCallbacks() {
    if(!esp_ptr_internal(&state_)) return false;
    i2s_event_callbacks_t callbacks{};
    callbacks.on_recv=received; callbacks.on_recv_q_ovf=overflowed;
    return i2s_channel_register_event_callback(channel_,&callbacks,&state_)==ESP_OK;
  }
  bool enable() { return i2s_channel_enable(channel_)==ESP_OK; }
  bool disable() { return i2s_channel_disable(channel_)==ESP_OK; }
  bool destroy() {
    if(i2s_del_channel(channel_)!=ESP_OK) return false;
    channel_=nullptr; return true;
  }
  ReadStatus read(int16_t* out,size_t capacity,size_t& receivedBytes,uint32_t timeoutMs) {
    const auto status=i2s_channel_read(channel_,out,capacity,&receivedBytes,timeoutMs);
    return status==ESP_OK?ReadStatus::Ok:status==ESP_ERR_TIMEOUT?ReadStatus::TimedOut:ReadStatus::Error;
  }
  void resetCounters() {
    portENTER_CRITICAL(&state_.lock); state_.counts={}; portEXIT_CRITICAL(&state_.lock);
  }
  Counters snapshot() {
    portENTER_CRITICAL(&state_.lock); const auto counts=state_.counts; portEXIT_CRITICAL(&state_.lock);
    return counts;
  }
  float sampleRate() {
    i2s_chan_info_t info{};
    return i2s_channel_get_info(channel_,&info)==ESP_OK?float(info.mclk_hz)/256:0;
  }
 private:
  struct State { portMUX_TYPE lock=portMUX_INITIALIZER_UNLOCKED; Counters counts; } state_;
  i2s_chan_handle_t channel_=nullptr;
  static bool IRAM_ATTR received(i2s_chan_handle_t,i2s_event_data_t*,void* data) {
    auto& state=*static_cast<State*>(data);
    portENTER_CRITICAL_ISR(&state.lock); state.counts.recordReceived(); portEXIT_CRITICAL_ISR(&state.lock);
    return false;
  }
  static bool IRAM_ATTR overflowed(i2s_chan_handle_t,i2s_event_data_t*,void* data) {
    auto& state=*static_cast<State*>(data);
    portENTER_CRITICAL_ISR(&state.lock); state.counts.recordOverflow(); portEXIT_CRITICAL_ISR(&state.lock);
    return false;
  }
};
}
#endif
