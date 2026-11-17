#pragma once

#include "design.h"
#include "wifi.h"
#include <stdio.h>

#ifdef ARDUINO
#include <Arduino.h>
#endif

namespace Tamagotchi {

struct StateInfo {
  int hour = -1, minute = -1;
  int wifiLevel = 0;
  int batteryPercent = -1;
  bool chargingKnown = false, charging = false;
  uint8_t chargingStep = 0;
};

inline uint8_t chargingAnimationStep(int percent, bool charging, uint32_t now) {
  if (!charging || percent < 0 || batteryDisplayFull(percent) || percent > 100) return 0;
  const int completed = percent * kBatterySectionCount / 100;
  return uint8_t((now / kBatteryAnimationStepMs + 1) % (kBatterySectionCount - completed + 1));
}

inline int batteryPercentFromRaw(int raw) {
  constexpr int levels[] = {1985, 2048, 2172, 2296, 2420, kBatteryFullRaw};
  static_assert(kBatteryFullRaw>2420 && kBatteryFullRaw<4032,"Keep battery calibration monotonic and valid");
  if (raw <= levels[0]) return 0;
  if (raw >= levels[5]) return 100;
  for (int i = 1; i < 6; ++i) {
    if (raw <= levels[i]) {
      const int span = levels[i] - levels[i - 1];
      return (i - 1) * 20 + ((raw - levels[i - 1]) * 20 + span / 2) / span;
    }
  }
  return 100;
}

class BatteryMonitor {
 public:
  void acceptSeries(const uint16_t (&samples)[16], uint32_t now) {
    uint32_t sum = 0;
    for (const uint16_t sample : samples) {
      if (sample < 64 || sample > 4031) return;
      sum += sample;
    }
    const int average = int((sum + 8) / 16);
    filtered_ = valid_ && age(now) < 30000 ? (3 * filtered_ + average + 2) / 4 : average;
    valid_ = true;
    measuredAt_ = now;
  }
  int percentage(uint32_t now) const {
    return !valid_ || age(now) >= 30000 ? -1 : batteryPercentFromRaw(filtered_);
  }
  int raw() const { return filtered_; }
  uint32_t age(uint32_t now) const { return valid_ ? uint32_t(now - measuredAt_) : UINT32_MAX; }

 private:
  int filtered_ = -1;
  bool valid_ = false;
  uint32_t measuredAt_ = 0;
};

class ChargingMonitor {
 public:
  bool known = false, active = false;
  void sample(bool charging, uint32_t now) {
    known = true;
    if (charging) {
      lastChargingAt_ = now;
      active = true;
    } else if (active && uint32_t(now - lastChargingAt_) >= 3000) {
      active = false;
    }
  }

 private:
  uint32_t lastChargingAt_ = 0;
};

inline void drawStateInfo(uint16_t* frame, int width, int height, const StateInfo& info) {
  if (!frame || width <= 0 || height <= 0) return;
  // Logical sizes preserve the original proportions; the whole group grows by 35%.
  constexpr int wifiLeft = 66, batteryLeft = 89, iconTop = 1, groupWidth = 115;
  auto scaled = [](int value) { return (value * theme().statusScale + 50) / 100; };
  const int left = (width - scaled(groupWidth)) / 2;
  auto pixel = [&](int x, int y, uint16_t color) {
    for (int yy = theme().statusTop + scaled(y); yy < theme().statusTop + scaled(y + 1); ++yy) {
      for (int xx = left + scaled(x); xx < left + scaled(x + 1); ++xx) {
        if (xx >= 0 && xx < width && yy >= 0 && yy < height) frame[yy * width + xx] = color;
      }
    }
  };
  char clock[6] = "--:--";
  if (info.hour >= 0 && info.hour < 24 && info.minute >= 0 && info.minute < 60) {
    snprintf(clock, sizeof(clock), "%02d:%02d", info.hour, info.minute);
  }
  for (int character = 0; character < 5; ++character) {
    const char value = clock[character];
    const int glyph = value >= '0' && value <= '9' ? value - '0' : (value == ':' ? 10 : 11);
    for (int row = 0; row < 7; ++row) {
      for (int col = 0; col < 5; ++col) {
        if (!(theme().font->digits[glyph][row] & (1 << (4 - col)))) continue;
        for (int yy = 0; yy < 2; ++yy) {
          for (int xx = 0; xx < 2; ++xx) pixel(character * 12 + col * 2 + xx, row * 2 + yy, theme().text);
        }
      }
    }
  }
  for (int bar = 0; bar < 3; ++bar) {
    const uint16_t color = bar < info.wifiLevel ? theme().text : theme().muted;
    for (int y = 12 - kStatusWifiBarHeights[bar]; y < 12; ++y) {
      for (int x = 0; x < 3; ++x) {
        pixel(wifiLeft + bar * 6 + x, iconTop + y, color);
      }
    }
  }

  const bool charging = info.chargingKnown && info.charging;
  const int percent = info.batteryPercent > 100 ? 100 : info.batteryPercent;
  const bool full=batteryDisplayFull(percent);
  const int completed = full?kBatterySectionCount:(percent >= 0 ? percent * kBatterySectionCount / 100 : 0);
  const int litSections = completed + (charging && !full && percent >= 0 ? info.chargingStep : 0);
  const uint16_t fillColor = charging ? theme().charging : (percent <= 20 ? theme().lowBattery : theme().text);
  for (int section = 0; section < kBatterySectionCount; ++section) {
    const uint16_t color = section < litSections ? fillColor : theme().muted;
    const int sectionLeft = batteryLeft + 2 + section * kBatteryFillWidth / kBatterySectionCount;
    const int sectionRight = batteryLeft + 2 + (section + 1) * kBatteryFillWidth / kBatterySectionCount;
    for (int y = 3; y < 9; ++y) {
      for (int x = sectionLeft; x < sectionRight; ++x) pixel(x, iconTop + y, color);
    }
  }
  for (int y = 0; y < 12; ++y) {
    for (int x = 0; x < 26; ++x) {
      if (kStatusBatteryRows[y] & (uint32_t(1) << x)) {
        pixel(batteryLeft + x, iconTop + y, percent >= 0 ? theme().text : theme().muted);
      }
    }
  }
}

#ifdef ARDUINO
namespace StateInfoDetail {
struct Runtime {
  StateInfo info;
  BatteryMonitor battery;
  ChargingMonitor charger;
  uint16_t samples[16]{};
  int sampleCount = 0;
  bool sampling = false;
  uint32_t seriesAt = 0, sampleAt = 0, chargeAt = 0, statusAt = 0, logAt = 0;
};
inline Runtime runtime;
}

inline void beginStateInfo() {
  using namespace StateInfoDetail;
  analogReadResolution(12);
  analogSetPinAttenuation(Board::kBattery, ADC_11db);
  pinMode(Board::kCharging, INPUT_PULLUP);
  // The first complete series is read before starting Wi-Fi (GPIO17 is ADC2).
  for (auto& sample : runtime.samples) {
    sample = analogRead(Board::kBattery);
    delay(2);
  }
  const uint32_t now = millis();
  runtime.battery.acceptSeries(runtime.samples, now);
  runtime.info.batteryPercent = runtime.battery.percentage(now);
  runtime.seriesAt = runtime.chargeAt = now;
  runtime.charger.sample(digitalRead(Board::kCharging) == LOW, now);
  runtime.info.chargingKnown = runtime.charger.known;
  runtime.info.charging = runtime.charger.active;
  runtime.info.chargingStep = chargingAnimationStep(runtime.info.batteryPercent,
      runtime.info.chargingKnown && runtime.info.charging, now);
  Serial.printf("[BATTERY] indicator full_raw=%d; approximate calibration\n",kBatteryFullRaw);
  DeviceWifi::beginAfterPlatformReady();
}

inline bool updateStateInfo(bool pauseAdc=false,bool screenOff=false) {
  using namespace StateInfoDetail;
  const StateInfo before = runtime.info;
  const uint32_t now = millis();
  DeviceWifi::tick(now);
  if (pauseAdc) {
    runtime.sampling=false;
    runtime.sampleCount=0;
    runtime.seriesAt=now;
  } else if (!runtime.sampling && uint32_t(now - runtime.seriesAt) >= (screenOff?15000u:2000u)) {
    runtime.sampling = true;
    runtime.seriesAt = now;
    runtime.sampleCount = 0;
    runtime.sampleAt = now - 2;
  }
  if (!pauseAdc && runtime.sampling && uint32_t(now - runtime.sampleAt) >= 2) {
    runtime.samples[runtime.sampleCount++] = analogRead(Board::kBattery);
    runtime.sampleAt = now;
    if (runtime.sampleCount == 16) {
      runtime.battery.acceptSeries(runtime.samples, now);
      runtime.sampling = false;
    }
  }
  runtime.info.batteryPercent = runtime.battery.percentage(now);
  if (uint32_t(now - runtime.chargeAt) >= 100) {
    runtime.chargeAt = now;
    runtime.charger.sample(digitalRead(Board::kCharging) == LOW, now);
    runtime.info.chargingKnown = runtime.charger.known;
    runtime.info.charging = runtime.charger.active;
  }
  runtime.info.chargingStep = chargingAnimationStep(runtime.info.batteryPercent,
      runtime.info.chargingKnown && runtime.info.charging, now);
  if (uint32_t(now - runtime.statusAt) >= 1000) {
    runtime.statusAt = now;
    updateWifi(runtime.info.hour, runtime.info.minute, runtime.info.wifiLevel);
  }
  if (uint32_t(now - runtime.logAt) >= (screenOff?60000u:5000u)) {
    runtime.logAt = now;
    Serial.printf("[BATTERY] raw=%d percent=%d charging=%s age_ms=%lu\n",
        runtime.battery.raw(), runtime.info.batteryPercent,
        !runtime.charger.known ? "unknown" : (runtime.charger.active ? "yes" : "no"),
        static_cast<unsigned long>(runtime.battery.age(now)));
  }
  return before.hour != runtime.info.hour || before.minute != runtime.info.minute ||
         before.wifiLevel != runtime.info.wifiLevel ||
         before.batteryPercent != runtime.info.batteryPercent ||
         before.chargingKnown != runtime.info.chargingKnown || before.charging != runtime.info.charging ||
         before.chargingStep != runtime.info.chargingStep;
}

inline void drawStateInfo(uint16_t* frame, int width, int height) {
  drawStateInfo(frame, width, height, StateInfoDetail::runtime.info);
}
#endif  // ARDUINO

}  // namespace Tamagotchi
