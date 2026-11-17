#pragma once
#include <atomic>
#include <cstdint>
#include <initializer_list>
#ifdef ARDUINO
#include <Arduino.h>
#include <driver/gpio.h>
#include <esp_pm.h>
#include <esp_sleep.h>
#include "config.h"
#if defined(KIBI_REQUIRE_PM) && (!CONFIG_PM_ENABLE || !CONFIG_FREERTOS_USE_TICKLESS_IDLE)
#error "The low-power release requires real PM/tickless-enabled SDK libraries"
#endif
#endif

namespace Tamagotchi::PowerManagement {

// Each worker owns its requirement. Releasing the display hold cannot lower
// performance while audio still owns another hold on the same IDF PM lock.
template<class Backend> class Hold {
 public:
  explicit Hold(Backend& backend,bool acquire=true):backend_(backend) { set(acquire); }
  ~Hold() { if(held_) backend_.release(); }
  Hold(const Hold&)=delete;
  Hold& operator=(const Hold&)=delete;
  bool held() const { return held_; }
  bool set(bool wanted) {
    if(wanted==held_) return true;
    if(!(wanted?backend_.acquire():backend_.release())) return false;
    held_=wanted;
    return true;
  }
 private:
  Backend& backend_;
  bool held_=false;
};

class WakeLatch {
 public:
#ifdef ARDUINO
  void ARDUINO_ISR_ATTR fired() { masked_.store(true,std::memory_order_relaxed); }
#else
  void fired() { masked_.store(true,std::memory_order_relaxed); }
#endif
  bool rearm(bool released) {
    return released && masked_.exchange(false,std::memory_order_relaxed);
  }
 private:
  std::atomic<bool> masked_{false};
};
inline constexpr uint32_t idlePauseMs(bool screenOn,bool adcSampling) {
  return screenOn?1u:(adcSampling?2u:1000u);
}

#ifdef ARDUINO
namespace Detail {
class Backend {
 public:
  bool begin() {
#if CONFIG_PM_ENABLE && CONFIG_FREERTOS_USE_TICKLESS_IDLE
    return esp_pm_lock_create(ESP_PM_CPU_FREQ_MAX,0,"kibi-active",&lock_)==ESP_OK;
#else
    return false;
#endif
  }
  bool acquire() {
#if CONFIG_PM_ENABLE && CONFIG_FREERTOS_USE_TICKLESS_IDLE
    return lock_ && esp_pm_lock_acquire(lock_)==ESP_OK;
#else
    return false;
#endif
  }
  bool release() {
#if CONFIG_PM_ENABLE && CONFIG_FREERTOS_USE_TICKLESS_IDLE
    const esp_err_t result=lock_?esp_pm_lock_release(lock_):ESP_ERR_INVALID_STATE;
    if(result!=ESP_OK) Serial.printf("[POWER] PM release failed: %d\n",int(result));
    return result==ESP_OK;
#else
    return false;
#endif
  }
 private:
#if CONFIG_PM_ENABLE && CONFIG_FREERTOS_USE_TICKLESS_IDLE
  esp_pm_lock_handle_t lock_=nullptr;
#endif
};
inline Backend backend;
inline Hold<Backend> interactive(backend,false);
inline bool attempted=false,locksReady=false,configured=false;
} // namespace Detail

class PerformanceLease:public Hold<Detail::Backend> {
 public:
  PerformanceLease():Hold(Detail::backend) {}
};

// Acquire the boot/display lease before peripheral workers start. GPIO wake is
// armed separately, after the final pinMode calls and button ISR installation.
inline bool begin() {
  using namespace Detail;
  if(attempted) return locksReady;
  attempted=true;
#if CONFIG_PM_ENABLE && CONFIG_FREERTOS_USE_TICKLESS_IDLE
  if(!backend.begin() || !interactive.set(true)) {
    Serial.println("[POWER] PM lock unavailable; keeping ordinary CPU operation");
    return false;
  }
  locksReady=true;
#else
  Serial.println("[POWER] SDK lacks PM/tickless; automatic light sleep unavailable");
#endif
  return locksReady;
}

// pinMode preserves the GPIO interrupt type, and gpio_config enables CPU IRQs
// for nonzero types. Never call pinMode after setting a wake level here: CHRG
// has no CPU ISR. gpio_wakeup_enable itself preserves an already-masked button
// IRQ, including a button held at boot whose ISR has already fired once.
inline bool armWakeSources() {
  using namespace Detail;
  if(configured) return true;
#if CONFIG_PM_ENABLE && CONFIG_FREERTOS_USE_TICKLESS_IDLE
  if(!locksReady) return false;
  for(const int pin:{Board::kPlus,Board::kMinus,Board::kCharging}) {
    // Digital wake supports GPIO39/40 in light sleep. Keep active pin/pull
    // configuration; never repurpose the power latch or PSRAM pins.
    if(gpio_sleep_sel_dis(gpio_num_t(pin))!=ESP_OK ||
       gpio_wakeup_enable(gpio_num_t(pin),GPIO_INTR_LOW_LEVEL)!=ESP_OK) {
      Serial.println("[POWER] GPIO wake unavailable; automatic sleep remains disabled");
      return false;
    }
  }
  if(gpio_intr_disable(gpio_num_t(Board::kCharging))!=ESP_OK) {
    Serial.println("[POWER] Cannot mask charging CPU interrupt; automatic sleep remains disabled");
    return false;
  }
  // No manual timer wake: IDF coordinates DTIM and FreeRTOS deadlines.
  const esp_pm_config_t config{.max_freq_mhz=240,.min_freq_mhz=40,.light_sleep_enable=true};
  const esp_err_t wake=esp_sleep_enable_gpio_wakeup();
  const esp_err_t result=wake==ESP_OK?esp_pm_configure(&config):wake;
  configured=result==ESP_OK;
  Serial.printf("[POWER] auto-light-sleep=%u DFS=40..240 MHz init=%d\n",unsigned(configured),int(result));
#endif
  return configured;
}
inline void setInteractive(bool wanted) {
  if(Detail::configured && !Detail::interactive.set(wanted))
    Serial.println("[POWER] Cannot apply interactive performance requirement");
}
inline bool automaticSleepEnabled() { return Detail::configured; }
inline void printDiagnostics() {
  Serial.printf("[POWER-DIAG] automatic_sleep=%u cpu_mhz=%u interactive_hold=%u wake_cause=%u\n",
      unsigned(Detail::configured),unsigned(getCpuFrequencyMhz()),unsigned(Detail::interactive.held()),
      unsigned(esp_sleep_get_wakeup_cause()));
#if CONFIG_PM_ENABLE && CONFIG_PM_PROFILING
  esp_pm_dump_locks(stdout);
#endif
}
#endif
} // namespace Tamagotchi::PowerManagement
