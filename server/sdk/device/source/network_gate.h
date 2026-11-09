#pragma once
#include <atomic>
#include <cstdint>
#ifdef ARDUINO
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#endif

namespace Tamagotchi::NetworkGate {
enum class Priority { Background,Voice };
struct Snapshot { uintptr_t owner; unsigned waitingVoice; bool voiceOwner; };
// mbedTLS ECDH math can run without blocking for longer than the idle watchdog
// limit. Share this connect call's CPU with IDLE0, then restore normal streaming
// priority. Scheduler callbacks keep restoration independently testable.
class TlsHandshakeScope {
 public:
  using Read=uint32_t(*)();
  using Set=void(*)(uint32_t);
  TlsHandshakeScope(Read read,Set set):set_(set),previous_(read()) {
    if(previous_) set_(0);
  }
#ifdef ARDUINO
  TlsHandshakeScope():TlsHandshakeScope(readCurrent,setCurrent) {
    static_assert(configUSE_PREEMPTION==1 && configUSE_TIME_SLICING==1,
        "TLS must share CPU time with the idle task to preserve its watchdog feed");
    static_assert(tskIDLE_PRIORITY==0,"TLS idle scheduling expects priority zero");
  }
#endif
  ~TlsHandshakeScope() { if(previous_) set_(previous_); }
  TlsHandshakeScope(const TlsHandshakeScope&)=delete;
  TlsHandshakeScope& operator=(const TlsHandshakeScope&)=delete;
 private:
#ifdef ARDUINO
  static uint32_t readCurrent() { return uint32_t(uxTaskPriorityGet(nullptr)); }
  static void setCurrent(uint32_t priority) { vTaskPrioritySet(nullptr,UBaseType_t(priority)); }
#endif
  Set set_;
  uint32_t previous_;
};

// One task owns transport work at a time. The owner can recurse (for example,
// weather refresh inside sync), but yields that opportunity to waiting voice.
// Gate recursion is not a TLS context count; tls_diagnostics.h observes each
// transport's connect/close lifetime independently.
// Ownership uses atomic task tokens: it requires no lazy mutex allocation
// and never spins while waiting for network I/O or another task.
class Gate {
 public:
  bool tryTake(uintptr_t task,Priority priority) {
    if(!task) return false;
    if(owner_.load(std::memory_order_acquire)==task) {
      if(priority==Priority::Background && waitingVoice_.load() && !voiceOwner_.load()) return false;
      ++depth_;
      if(priority==Priority::Voice) voiceOwner_.store(true);
      return true;
    }
    if(priority==Priority::Background && waitingVoice_.load()) return false;
    uintptr_t empty=0;
    if(!owner_.compare_exchange_strong(empty,task,std::memory_order_acquire)) return false;
    depth_=1; voiceOwner_.store(priority==Priority::Voice);
    // A voice waiter may have registered between the first check and CAS.
    if(priority==Priority::Background && waitingVoice_.load()) { give(task); return false; }
    return true;
  }
  bool give(uintptr_t task) {
    if(!task || owner_.load(std::memory_order_acquire)!=task) return false;
    if(--depth_==0) {
      voiceOwner_.store(false);
      owner_.store(0,std::memory_order_release);
    }
    return true;
  }
  void waitForVoice() { waitingVoice_.fetch_add(1); }
  void stopWaitingForVoice() { waitingVoice_.fetch_sub(1); }
  bool voiceBusy() const { return waitingVoice_.load() || voiceOwner_.load(); }
  bool allowsTransport(Priority priority) const { return priority==Priority::Voice || !voiceBusy(); }
  // Diagnostic fields are individually atomic; this never waits or takes ownership.
  Snapshot snapshot() const {
    return {owner_.load(std::memory_order_relaxed),waitingVoice_.load(std::memory_order_relaxed),
            voiceOwner_.load(std::memory_order_relaxed)};
  }
 private:
  std::atomic<uintptr_t> owner_{0};
  std::atomic<unsigned> waitingVoice_{0};
  std::atomic<bool> voiceOwner_{false};
  unsigned depth_=0; // Only the owning task accesses recursion depth.
};
inline Gate gate;
inline bool voiceBusy() { return gate.voiceBusy(); }

class Lease {
 public:
  using Clock=uint32_t(*)();
  using Pause=void(*)();
  Lease(Gate& gate,uintptr_t task,Priority priority,uint32_t budget,Clock now,Pause pause,Pause acquired)
      :gate_(gate),task_(task) {
    if(!task) return;
    const bool voice=priority==Priority::Voice;
    if(voice) gate_.waitForVoice();
    const uint32_t started=now?now():0;
    for(;;) {
      if(gate_.tryTake(task_,priority)) { held_=true; break; }
      if(!voice || !now || !pause || uint32_t(now()-started)>=budget) break;
      pause();
    }
    if(voice) gate_.stopWaitingForVoice();
    // Even two serialized ECDSA handshakes must leave IDLE0 a scheduling
    // opportunity between sessions. taskYIELD alone only runs equal priorities.
    if(held_ && acquired) acquired();
  }
#ifdef ARDUINO
  explicit Lease(Priority priority,uint32_t budget)
      :Lease(gate,reinterpret_cast<uintptr_t>(xTaskGetCurrentTaskHandle()),priority,budget,
             clock,pauseTask,pauseTask) {}
#endif
  ~Lease() { if(held_) gate_.give(task_); }
  Lease(const Lease&)=delete;
  Lease& operator=(const Lease&)=delete;
  explicit operator bool() const { return held_; }
 private:
#ifdef ARDUINO
  static uint32_t clock() { return uint32_t(xTaskGetTickCount())*portTICK_PERIOD_MS; }
  static void pauseTask() { vTaskDelay(1); }
#endif
  Gate& gate_;
  uintptr_t task_;
  bool held_=false;
};
} // namespace Tamagotchi::NetworkGate
