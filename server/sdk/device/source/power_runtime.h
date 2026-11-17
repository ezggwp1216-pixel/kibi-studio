#pragma once

#include <cstdint>

#ifdef ARDUINO
#include <Arduino.h>
// The project also has wifi.h; use the library's unambiguous public entry point.
#include <WiFiMulti.h>
#include "network_gate.h"
#if defined(ARDUINO_USB_MODE) && ARDUINO_USB_MODE && \
    defined(ARDUINO_USB_CDC_ON_BOOT) && ARDUINO_USB_CDC_ON_BOOT && \
    defined(SOC_USB_SERIAL_JTAG_SUPPORTED) && SOC_USB_SERIAL_JTAG_SUPPORTED
#include <driver/usb_serial_jtag.h>
#endif
#endif

namespace Tamagotchi::PowerRuntime {

// Positive evidence only. False does not distinguish a full battery on a wall
// charger from battery operation: GPIO47 is CHRG, and USB SOF needs a data host.
inline constexpr bool confirmedExternalPower(bool charging,bool usbHost) {
  return charging || usbHost;
}
inline bool confirmedExternalPower(bool charging) {
#if defined(ARDUINO) && defined(ARDUINO_USB_MODE) && ARDUINO_USB_MODE && \
    defined(ARDUINO_USB_CDC_ON_BOOT) && ARDUINO_USB_CDC_ON_BOOT && \
    defined(SOC_USB_SERIAL_JTAG_SUPPORTED) && SOC_USB_SERIAL_JTAG_SUPPORTED
  return confirmedExternalPower(charging,usb_serial_jtag_is_connected());
#else
  return charging;
#endif
}

// Main-loop owner. Failed requests are never mistaken for applied settings.
// Retry a failed sleep enable at most once per second; disabling for voice has
// no retry delay. The driver keeps the station associated in either mode.
class RadioController {
 public:
  template<class Apply>
  bool update(bool rational,bool busy,bool transportBusy,uint32_t now,Apply apply) {
    // Background HTTP tolerates DTIM wake latency and must not hold the radio
    // fully awake throughout every network timeout. Voice is the exception.
    (void)transportBusy;
    const bool sleep=rational && !busy;
    if(known_ && applied_==sleep) return true;
    if(sleep && failed_ && uint32_t(now-attemptedAt_)<1000) return false;
    attemptedAt_=now;
    if(!apply(sleep)) { failed_=true;return false; }
    applied_=sleep;
    known_=true;
    failed_=false;
    return true;
  }
 private:
  uint32_t attemptedAt_=0;
  bool known_=false,applied_=false,failed_=false;
};

#ifdef ARDUINO
inline RadioController radio;
inline bool update(bool rational,bool screenOn,bool busy) {
  // A lit but idle screen does not require low-latency radio operation.
  (void)screenOn;
  const auto network=NetworkGate::gate.snapshot();
  const bool transportBusy=network.owner;
  busy=busy || network.waitingVoice || network.voiceOwner;
  return radio.update(rational,busy,transportBusy,millis(),
      [](bool sleep) { return WiFi.setSleep(sleep); });
}
// CPU/light-sleep policy lives in power_management.h; modem sleep alone does
// not suspend the processor. Workers acquire their own performance leases.
#endif
} // namespace Tamagotchi::PowerRuntime
