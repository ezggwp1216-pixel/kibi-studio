#pragma once

#include "design.h"
#include "embedded_assets.h"
#include "ui_diagnostics.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

#ifdef ARDUINO
#include <Arduino.h>
#include <SPI.h>
#include <Wire.h>
#include <Preferences.h>
#include <esp_heap_caps.h>
#include <LittleFS.h>
#include <jpeg_decoder.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/queue.h>
#include <atomic>
#endif

namespace Tamagotchi {

constexpr int kBackgroundMaxOffsetY = kBackgroundHeight - kScreenHeight;

namespace DisplayTouchDetail {

constexpr size_t kTransferPixels = kScreenWidth * 4;
constexpr size_t kTransferBytes = kTransferPixels * sizeof(uint16_t);

constexpr uint16_t backlightDuty(unsigned percent) {
  return uint16_t(((percent > 100 ? 100 : percent) * 1023 + 50) / 100);
}

enum class LcdPowerCommand : uint8_t { None, SleepIn, SleepOut, DisplayOn };

// The JD9853 needs settling time after sleep-in, sleep-out and display-on.
// Advancing the sequence from loop() leaves button recording free to start now.
class LcdPowerSequence {
 public:
  bool awakeRequested() const { return awake_; }
  bool ready() const { return awake_ && phase_ == Phase::Ready; }
  LcdPowerCommand request(bool awake, uint32_t now) {
    awake_ = awake;
    return tick(now);
  }
  LcdPowerCommand tick(uint32_t now) {
    const uint32_t age = uint32_t(now - phaseAt_);
    if (!awake_) {
      // A cancelled wake still observes the sleep-out settling guard before
      // the opposite command. Its backlight was already switched off.
      if (phase_ == Phase::Ready || (phase_ == Phase::SleepOutWait && age >= 120) ||
          (phase_ == Phase::DisplayOnWait && age >= 50)) {
        phase_ = Phase::Asleep;
        phaseAt_ = now;
        return LcdPowerCommand::SleepIn;
      }
      return LcdPowerCommand::None;
    }
    if (phase_ == Phase::Asleep && age >= 120) {
      phase_ = Phase::SleepOutWait;
      phaseAt_ = now;
      return LcdPowerCommand::SleepOut;
    }
    if (phase_ == Phase::SleepOutWait && age >= 120) {
      phase_ = Phase::DisplayOnWait;
      phaseAt_ = now;
      return LcdPowerCommand::DisplayOn;
    }
    if (phase_ == Phase::DisplayOnWait && age >= 50) phase_ = Phase::Ready;
    return LcdPowerCommand::None;
  }

 private:
  enum class Phase : uint8_t { Ready, Asleep, SleepOutWait, DisplayOnWait };
  Phase phase_ = Phase::Ready;
  uint32_t phaseAt_ = 0;
  bool awake_ = true;
};

inline bool hasBackgroundJpegHeader(const uint8_t* data, size_t length) {
  if (!data || length < 4 || data[0] != 0xFF || data[1] != 0xD8) return false;
  size_t offset = 2;
  while (offset < length) {
    if (data[offset++] != 0xFF) return false;
    while (offset < length && data[offset] == 0xFF) ++offset;
    if (offset == length) return false;
    const uint8_t marker = data[offset++];
    if (marker == 0xD8 || marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7)) continue;
    if (marker == 0 || marker == 0xD9 || marker == 0xDA || length - offset < 2) return false;
    const size_t segment = (size_t(data[offset]) << 8) | data[offset + 1];
    if (segment < 2 || segment > length - offset) return false;
    if (marker >= 0xC0 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC) {
      if (marker != 0xC0 || segment < 8 || data[offset + 2] != 8) return false;
      const int components = data[offset + 7];
      if ((components != 1 && components != 3) || segment < size_t(8 + 3 * components)) return false;
      const int height = (int(data[offset + 3]) << 8) | data[offset + 4];
      const int width = (int(data[offset + 5]) << 8) | data[offset + 6];
      return width == kBackgroundWidth && height == kBackgroundHeight;
    }
    offset += segment;
  }
  return false;
}

inline int clampBackgroundOffset(int offsetY) {
  if (offsetY < 0) return 0;
  if (offsetY > kBackgroundMaxOffsetY) return kBackgroundMaxOffsetY;
  return offsetY;
}

inline void renderBackground(uint16_t* frame, const uint16_t* background, int offsetY) {
  const size_t first = size_t(clampBackgroundOffset(offsetY)) * kBackgroundWidth;
  memcpy(frame, background + first, kFrameBytes);
}

inline void maskRoundedCorners(uint16_t* frame) {
  const int r = kScreenCornerRadius;
  for (int y = 0; y < r; ++y) {
    const int dy = 2 * y + 1 - 2 * r;
    for (int x = 0; x < r; ++x) {
      const int dx = 2 * x + 1 - 2 * r;
      if (dx * dx + dy * dy <= 4 * r * r) continue;
      frame[y * kScreenWidth + x] = 0;
      frame[y * kScreenWidth + kScreenWidth - 1 - x] = 0;
      frame[(kScreenHeight - 1 - y) * kScreenWidth + x] = 0;
      frame[(kScreenHeight - 1 - y) * kScreenWidth + kScreenWidth - 1 - x] = 0;
    }
  }
}

inline size_t encodeRotatedStrip(const uint16_t* frame, size_t first, uint8_t* output) {
  if (first >= kFramePixelCount) return 0;
  const size_t remaining = kFramePixelCount - first;
  const size_t count = remaining < kTransferPixels ? remaining : kTransferPixels;
  for (size_t i = 0; i < count; ++i) {
    const uint16_t pixel = frame[kFramePixelCount - 1 - first - i];
    output[2 * i] = uint8_t(pixel >> 8);
    output[2 * i + 1] = uint8_t(pixel);
  }
  return count;
}

struct TouchPoint { int x; int y; };
// Matches the existing tama_touch/cal record layout in NVS.
struct TouchCalibration { int16_t x0, y0, ux, uy, vx, vy; };

inline int clamp(int value, int maximum) {
  if (value < 0) return 0;
  return value > maximum ? maximum : value;
}

inline bool validTouchCalibration(const TouchCalibration& c) {
  const int64_t det = int64_t(c.ux) * c.vy - int64_t(c.uy) * c.vx;
  return (det > 300 || det < -300) && c.x0 >= 0 && c.x0 <= 4095 &&
         c.y0 >= 0 && c.y0 <= 4095;
}

inline TouchPoint mapTouch(TouchPoint raw, const TouchCalibration* calibration) {
  if (calibration && validTouchCalibration(*calibration)) {
    const TouchCalibration& c = *calibration;
    const float det = float(c.ux) * c.vy - float(c.uy) * c.vx;
    const float rx = float(raw.x - c.x0), ry = float(raw.y - c.y0);
    const float a = (rx * c.vy - ry * c.vx) / det;
    const float b = (c.ux * ry - c.uy * rx) / det;
    return {clamp(int(lroundf(60 + a * 120)), 239),
            clamp(int(lroundf(78 + b * 138)), 295)};
  }
  // Preserve the working hardware coordinate transform without another inversion.
  const int x = clamp((raw.y - 12) * 180 / 211 + 30, 239);
  const int y = clamp((260 - raw.x) * 216 / 222 + 40, 295);
  return {239 - x, 295 - y};
}

class VerticalScroll {
 public:
  explicit VerticalScroll(int maximum=0):maximum_(maximum<0?0:maximum) {}
  void begin(int y, uint32_t now);
  void move(int y, uint32_t now);
  void release(uint32_t now);
  void cancel();
  void tick(uint32_t now);
  void scrollTo(int offset, uint32_t now);
  void setRange(int maximum, bool reset=false);
  int offsetY() const;
  bool active() const { return down_ || animating_ || velocity_ != 0; }

 private:
  float position_ = 0;
  float velocity_ = 0;
  bool down_ = false;
  bool dragging_ = false;
  int startY_ = 0;
  int lastY_ = 0;
  uint32_t sampleAt_ = 0;
  uint32_t motionAt_ = 0;
  uint32_t tickAt_ = 0;
  bool animating_ = false;
  float animationFrom_ = 0, animationTo_ = 0;
  uint32_t animationAt_ = 0;
  int maximum_ = 0;
  float bound(float value) const;
};

inline float VerticalScroll::bound(float value) const {
  const int maximum=maximum_;
  return value<0 ? 0 : (value>maximum ? float(maximum) : value);
}
inline void VerticalScroll::setRange(int maximum,bool reset) {
  maximum_=maximum<0 ? 0 : maximum;
  cancel();
  position_=reset ? 0 : bound(position_);
}

inline void VerticalScroll::begin(int y, uint32_t now) {
  down_ = true;
  dragging_ = false;
  velocity_ = 0;
  animating_ = false;
  startY_ = lastY_ = y;
  sampleAt_ = motionAt_ = tickAt_ = now;
}

inline void VerticalScroll::move(int y, uint32_t now) {
  if (!down_) return;
  if (!dragging_) {
    if (abs(y - startY_) < 4) return;
    dragging_ = true;
  }
  const int delta = lastY_ - y;
  const float requested = position_ + delta;
  position_ = bound(requested);
  const uint32_t elapsed = uint32_t(now - sampleAt_);
  if (elapsed && elapsed <= 100) {
    float measured = float(delta) * 1000 / elapsed;
    if (measured > 1500) measured = 1500;
    if (measured < -1500) measured = -1500;
    velocity_ = velocity_ * 0.4f + measured * 0.6f;
  } else {
    velocity_ = 0;
  }
  if (requested != position_) velocity_ = 0;
  if (delta) motionAt_ = now;
  lastY_ = y;
  sampleAt_ = now;
}

inline void VerticalScroll::release(uint32_t now) {
  down_ = false;
  if (!dragging_ || uint32_t(now - motionAt_) > 80) velocity_ = 0;
  tickAt_ = now;
}

inline void VerticalScroll::cancel() {
  down_ = false;
  dragging_ = false;
  velocity_ = 0;
  animating_ = false;
}

inline void VerticalScroll::scrollTo(int offset, uint32_t now) {
  cancel();
  animationFrom_ = position_;
  animationTo_ = bound(float(offset));
  animationAt_ = tickAt_ = now;
  animating_ = true;
}

inline void VerticalScroll::tick(uint32_t now) {
  uint32_t elapsed = uint32_t(now - tickAt_);
  tickAt_ = now;
  position_ = bound(position_);
  if (animating_) {
    const uint32_t age = uint32_t(now-animationAt_);
    const float t = age >= 300 ? 1.0f : float(age)/300;
    const float remaining = 1-t;
    position_ = bound(animationFrom_+(animationTo_-animationFrom_)*(1-remaining*remaining*remaining));
    if (age >= 300) animating_ = false;
    return;
  }
  if (down_ || velocity_ == 0 || !elapsed) return;
  if (elapsed > 50) elapsed = 50;
  const float dt = float(elapsed) / 1000;
  const float speed = fabsf(velocity_);
  const float duration = speed / 3200;
  const float movingTime = dt < duration ? dt : duration;
  const float nextSpeed = dt >= duration ? 0 : speed - 3200 * movingTime;
  const float direction = velocity_ > 0 ? 1.0f : -1.0f;
  const float requested = position_ + direction * (speed + nextSpeed) * 0.5f * movingTime;
  position_ = bound(requested);
  velocity_ = requested == position_ ? direction * nextSpeed : 0;
}

inline int VerticalScroll::offsetY() const {
  return int(lroundf(bound(position_)));
}

#ifdef ARDUINO

// Preserve the complete display initialization already verified in this project.
struct LcdInitCommand { uint8_t cmd, len, data[32]; uint16_t waitMs; };
inline constexpr LcdInitCommand kLcdInitTable[] PROGMEM = {
  {0xDF,2,{0x98,0x53},0}, {0xDE,1,{0x00},0}, {0xB2,1,{0x25},0},
  {0xB7,4,{0x00,0x21,0x00,0x49},0}, {0xBB,6,{0x1F,0x9A,0x55,0x73,0x63,0xF0},0},
  {0xC0,2,{0x22,0x22},0}, {0xC1,1,{0x12},0},
  {0xC3,8,{0x7D,0x07,0x14,0x06,0xC8,0x6A,0x6C,0x77},0},
  {0xC4,12,{0x00,0x00,0xA0,0x6F,0x1E,0x1A,0x16,0x79,0x1E,0x1A,0x16,0x82},0},
  {0xC8,32,{0x3F,0x2C,0x26,0x20,0x25,0x26,0x21,0x21,0x1F,0x1F,0x1F,0x13,0x11,0x0B,0x04,0x00,
             0x3F,0x2C,0x26,0x20,0x25,0x27,0x21,0x21,0x1F,0x1F,0x1F,0x13,0x11,0x0B,0x04,0x00},0},
  {0xD0,5,{0x04,0x06,0x62,0x0F,0x00},0}, {0xD7,2,{0x00,0x30},0},
  {0xE6,1,{0x14},0}, {0xDE,1,{0x01},0},
  {0xB7,5,{0x03,0x13,0xEF,0x35,0x35},0},
  {0xC1,3,{0x14,0x15,0xC0},0}, {0xC2,3,{0x06,0x3A,0xC7},0},
  {0xC4,2,{0x72,0x12},0}, {0xBE,1,{0x00},0}, {0xDE,1,{0x00},0},
  {0x35,1,{0x00},0}, {0x36,1,{0x00},0}, {0x3A,1,{0x05},0},
  {0x2A,4,{0x00,0x00,0x00,0xEF},0}, // x 0..239
  {0x2B,4,{0x00,0x00,0x01,0x27},0}, // y 0..295
  {0x11,0,{},120}, {0x29,0,{},50}
};

constexpr int kSclk=Board::kSclk,kMosi=Board::kMosi,kDc=Board::kDc,kCs=Board::kCs,kReset=Board::kReset,kBacklight=Board::kBacklight;
constexpr uint8_t kTouchAddress=Board::kTouchAddress;
constexpr uint32_t kCalibrationMagic = 0x544303B4;
struct StoredCalibration { uint32_t magic; TouchCalibration cal; };
static_assert(sizeof(StoredCalibration) == 16, "Preserve existing NVS format");

enum class TouchKind : uint8_t { Down, Move, Up, Cancel };
struct TouchEvent {
  TouchKind kind; TouchPoint point; uint32_t at; uint32_t epoch;
#if KIBI_UI_DIAGNOSTICS
  uint32_t sampleUs=0; // Separate clock from gesture milliseconds and sleep epoch.
#endif
};

struct Runtime {
  SPIClass lcd{FSPI};
  uint16_t* frame = nullptr;
  uint16_t* background = nullptr;
  QueueHandle_t touchEvents = nullptr;
  TaskHandle_t touchTask = nullptr;
  TouchCalibration calibration{};
  TouchPoint lastTouch{};
  bool ready = false;
  bool firstFrame = true;
  LcdPowerSequence power{};
  uint8_t brightness = 100;
  bool backlightPwm = false;
  std::atomic<bool> touchEnabled{true};
  std::atomic<uint32_t> touchEpoch{0};
  bool calibrated = false;
  bool touchDown = false;
  bool readError = false;
  int misses = 0;
};
// One shared instance even if this header is included by multiple source files.
inline Runtime runtime;

inline void writeBacklight(unsigned percent) {
  if (runtime.backlightPwm) {
    if (ledcWrite(kBacklight, backlightDuty(percent))) return;
    Serial.println("[POWER] Backlight PWM write failed; using on/off output");
    ledcDetach(kBacklight);
    runtime.backlightPwm = false;
    pinMode(kBacklight, OUTPUT);
  }
  digitalWrite(kBacklight, percent ? HIGH : LOW);
}

inline void applyBacklight() {
  writeBacklight(runtime.ready && runtime.power.ready() && !runtime.firstFrame
                     ? runtime.brightness : 0);
}


inline bool loadBackground(const char* path=nullptr) {
  const char* requested=path ? path : theme().backgroundPath;
  File file;
  if(LittleFS.begin(false)) file=LittleFS.open(requested,FILE_READ);
  const bool validFile=file && !file.isDirectory() && file.size()>=4 && file.size()<=1024*1024;
  const auto* fallback=validFile?nullptr:KibiAssets::lookup(requested);
  if(!validFile && !fallback) return false;
  const size_t length=validFile?file.size():fallback->size;
  auto* encoded=static_cast<uint8_t*>(heap_caps_malloc(length,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT));
  if(!encoded) return false;
  size_t read=length;
  if(validFile) read=file.read(encoded,length);
  else memcpy(encoded,fallback->data,length);
  file.close();
  if (read != length || !hasBackgroundJpegHeader(encoded, length)) {
    free(encoded);
    Serial.printf("[ERROR] Background must be a baseline %dx%d JPEG\n", kBackgroundWidth, kBackgroundHeight);
    return false;
  }
  constexpr size_t bytes = kBackgroundPixelCount * sizeof(uint16_t);
  auto* decoded = static_cast<uint16_t*>(
      heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!decoded) {
    free(encoded);
    Serial.println("[ERROR] Cannot allocate decoded background in PSRAM");
    return false;
  }
  esp_jpeg_image_cfg_t config{};
  config.indata = encoded;
  config.indata_size = length;
  config.outbuf = reinterpret_cast<uint8_t*>(decoded);
  config.outbuf_size = bytes;
  config.out_format = JPEG_IMAGE_FORMAT_RGB565;
  config.out_scale = JPEG_IMAGE_SCALE_0;
  // Native little-endian uint16_t pixels; SPI serialization sends the high byte first.
  config.flags.swap_color_bytes = false;
  esp_jpeg_image_output_t image{};
  const esp_err_t result = esp_jpeg_decode(&config, &image);
  free(encoded);
  if (result != ESP_OK || image.width != kBackgroundWidth ||
      image.height != kBackgroundHeight || image.output_len != bytes) {
    free(decoded);
    Serial.println("[ERROR] JPEG decoding failed");
    return false;
  }
  free(runtime.background);
  runtime.background = decoded;
  return true;
}

inline void lcdCommand(uint8_t value, const uint8_t* data, size_t length) {
  runtime.lcd.beginTransaction(SPISettings(40000000, MSBFIRST, SPI_MODE0));
  digitalWrite(kCs, LOW);
  digitalWrite(kDc, LOW);
  runtime.lcd.write(value);
  if (length) {
    digitalWrite(kDc, HIGH);
    runtime.lcd.writeBytes(data, length);
  }
  digitalWrite(kCs, HIGH);
  runtime.lcd.endTransaction();
}

inline void presentFrame() {
  if (!runtime.ready || !runtime.frame || !runtime.power.ready()) return;
#if KIBI_UI_DIAGNOSTICS
  const uint32_t presentationAtUs=micros();
#endif
  maskRoundedCorners(runtime.frame);
  const uint8_t columns[] = {0, 0, 0, 239}, rows[] = {0, 0, 1, 0x27};
  lcdCommand(0x2A, columns, sizeof(columns));
  lcdCommand(0x2B, rows, sizeof(rows));
  lcdCommand(0x2C, nullptr, 0);
  runtime.lcd.beginTransaction(SPISettings(40000000, MSBFIRST, SPI_MODE0));
  digitalWrite(kCs, LOW);
  digitalWrite(kDc, HIGH);
  uint8_t strip[kTransferBytes];
  for (size_t first = 0; first < kFramePixelCount; first += kTransferPixels) {
    const size_t count = encodeRotatedStrip(runtime.frame, first, strip);
    runtime.lcd.writeBytes(strip, count * 2);
  }
  digitalWrite(kCs, HIGH);
  runtime.lcd.endTransaction();
#if KIBI_UI_DIAGNOSTICS
  const uint32_t completedAtUs=micros();
  // This ends at SPI transaction completion; it does not measure panel photons.
  UiDiagnostics::framePresented(uint32_t(completedAtUs-presentationAtUs),completedAtUs);
#endif
  if (runtime.firstFrame) {
    runtime.firstFrame = false;
    applyBacklight();
  }
}

inline void applyPowerCommand(LcdPowerCommand command) {
  switch (command) {
    case LcdPowerCommand::SleepIn:
      lcdCommand(0x28, nullptr, 0);
      lcdCommand(0x10, nullptr, 0);
      break;
    case LcdPowerCommand::SleepOut: lcdCommand(0x11, nullptr, 0); break;
    case LcdPowerCommand::DisplayOn: lcdCommand(0x29, nullptr, 0); break;
    case LcdPowerCommand::None: break;
  }
}

inline void touchWorker(void*) {
  TickType_t nextPoll = xTaskGetTickCount();
  uint32_t epoch = runtime.touchEpoch.load();
  bool waitForRelease = false;
  for (;;) {
    const uint32_t currentEpoch = runtime.touchEpoch.load();
    if (epoch != currentEpoch) {
      epoch = currentEpoch;
      runtime.touchDown = false;
      runtime.readError = false;
      runtime.misses = 0;
      waitForRelease = true;
    }
    if (!runtime.touchEnabled.load()) {
      // A counting notification cannot lose a wake sent between the flag check
      // and this wait. No timed polling or I2C work runs while the LCD sleeps.
      ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
      nextPoll = xTaskGetTickCount();
      continue;
    }
    const uint32_t now = millis();
    TouchPoint raw{};
    int readState = -1;
#if KIBI_UI_DIAGNOSTICS
    const uint32_t sampleUs=micros();
#endif
    Wire.beginTransmission(kTouchAddress);
    Wire.write(uint8_t(0x02));
    if (Wire.endTransmission(false) == 0) {
      if (Wire.requestFrom(kTouchAddress, uint8_t(5)) == 5) {
        uint8_t data[5];
        for (auto& byte : data) byte = uint8_t(Wire.read());
        readState = (data[0] & 0x0F) ? 1 : 0;
        if (readState > 0) {
          raw = {((data[1] & 0x0F) << 8) | data[2],
                 ((data[3] & 0x0F) << 8) | data[4]};
        }
      } else {
        while (Wire.available()) Wire.read();
      }
    }
#if KIBI_UI_DIAGNOSTICS
    UiDiagnostics::inputPolled(uint32_t(micros()-sampleUs));
#endif
    TouchEvent event{};
    bool hasEvent = false;
    if (waitForRelease) {
      if (readState == 0) waitForRelease = false;
      readState = 0;
    }
    if (readState > 0) {
      runtime.misses = 0;
      runtime.readError = false;
      runtime.lastTouch = mapTouch(raw, runtime.calibrated ? &runtime.calibration : nullptr);
      event = {runtime.touchDown ? TouchKind::Move : TouchKind::Down, runtime.lastTouch, now, epoch};
      runtime.touchDown = true;
      hasEvent = true;
    } else if (runtime.touchDown) {
      if (readState < 0) runtime.readError = true;
      if (++runtime.misses >= 3) {
        runtime.touchDown = false;
        runtime.misses = 0;
        event = {runtime.readError ? TouchKind::Cancel : TouchKind::Up, runtime.lastTouch, now, epoch};
        hasEvent = true;
      }
    }
#if KIBI_UI_DIAGNOSTICS
    if(hasEvent) event.sampleUs=sampleUs;
#endif
    // A main-core sleep can race an in-flight I2C read. Never enqueue its tap.
    if (hasEvent && runtime.touchEnabled.load() && epoch == runtime.touchEpoch.load() &&
        xQueueSend(runtime.touchEvents, &event, 0) != pdTRUE) {
#if KIBI_UI_DIAGNOSTICS
      UiDiagnostics::enqueueFailed();
      UiDiagnostics::overflowCancelled();
#endif
      // Cancel an unfinished gesture if rendering stalls for too long.
      xQueueReset(runtime.touchEvents);
      event.kind = TouchKind::Cancel;
#if KIBI_UI_DIAGNOSTICS
      if(xQueueSend(runtime.touchEvents,&event,0)!=pdTRUE) UiDiagnostics::enqueueFailed();
#else
      xQueueSend(runtime.touchEvents, &event, 0);
#endif
    }
    vTaskDelayUntil(&nextPoll, pdMS_TO_TICKS(14));
  }
}

#endif  // ARDUINO
}  // namespace DisplayTouchDetail

#ifdef ARDUINO

// Hardware initialization and presentation; app.h owns application state.
inline bool beginDisplay(const char* backgroundPath=nullptr) {
  using namespace DisplayTouchDetail;
  pinMode(kBacklight, OUTPUT);
  digitalWrite(kBacklight, LOW);
  runtime.backlightPwm = ledcAttach(kBacklight, 20000, 10);
  if (!runtime.backlightPwm)
    Serial.println("[POWER] Cannot attach backlight PWM; using on/off output");
  writeBacklight(0);
  // Keep the unused amplifier off. Leave GPIO2 and GPIO37 untouched.
  pinMode(Board::kAmplifier, OUTPUT);
  digitalWrite(Board::kAmplifier, LOW);
  if (!psramFound()) {
    Serial.println("[ERROR] Enable OPI PSRAM in Arduino IDE");
    return false;
  }
  if (!loadBackground(backgroundPath)) return false;
  runtime.frame = static_cast<uint16_t*>(
      heap_caps_malloc(kFrameBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!runtime.frame) {
    free(runtime.background);
    runtime.background = nullptr;
    Serial.println("[ERROR] Cannot allocate framebuffer in PSRAM");
    return false;
  }
  memset(runtime.frame, 0, kFrameBytes);
  pinMode(kCs, OUTPUT);
  pinMode(kDc, OUTPUT);
  pinMode(kReset, OUTPUT);
  digitalWrite(kCs, HIGH);
  runtime.lcd.begin(kSclk, -1, kMosi, -1);
  digitalWrite(kReset, LOW);
  delay(50);
  digitalWrite(kReset, HIGH);
  delay(150);
  for (const auto& item : kLcdInitTable) {
    lcdCommand(item.cmd, item.data, item.len);
    if (item.waitMs) delay(item.waitMs);
  }
  lcdCommand(0x20, nullptr, 0);
  runtime.ready = true;
  return true;
}

inline void beginInputBus() {
  Wire.begin(Board::kSda,Board::kScl,Board::kI2cHz);
  Wire.setTimeOut(20);
}

inline bool beginTouch() {
  using namespace DisplayTouchDetail;
  Wire.beginTransmission(kTouchAddress);
  if (Wire.endTransmission() != 0) {
    Serial.println("[ERROR] CST810 touch not found at 0x15");
    return true;  // The display remains usable without touch.
  }
  Preferences preferences;
  // Read-only access to the existing calibration record.
  if (preferences.begin("tama_touch", true)) {
    StoredCalibration saved{};
    if (preferences.getBytesLength("cal") == sizeof(saved) &&
        preferences.getBytes("cal", &saved, sizeof(saved)) == sizeof(saved) &&
        saved.magic == kCalibrationMagic && validTouchCalibration(saved.cal)) {
      runtime.calibration = saved.cal;
      runtime.calibrated = true;
    }
    preferences.end();
  }
  Serial.printf("[TOUCH] calibration=%s\n", runtime.calibrated ? "NVS" : "reference mapping");
  runtime.touchEvents = xQueueCreate(32, sizeof(TouchEvent));
  if (!runtime.touchEvents) {
    Serial.println("[ERROR] Cannot allocate touch event queue");
    return true;
  }
  // Poll I2C independently of full-frame SPI transfers on the other core.
  if (xTaskCreatePinnedToCore(touchWorker, "touch", 4096, nullptr, 1, &runtime.touchTask, 0) != pdPASS) {
    Serial.println("[ERROR] Cannot start touch task");
    vQueueDelete(runtime.touchEvents);
    runtime.touchEvents = nullptr;
    runtime.touchTask = nullptr;
  }
  return true;
}

inline uint16_t* prepareDisplayFrame(int offsetY) {
  using namespace DisplayTouchDetail;
  if (!runtime.ready || !runtime.power.ready()) return nullptr;
  renderBackground(runtime.frame,runtime.background,offsetY);
  return runtime.frame;
}
inline void presentDisplayFrame() { DisplayTouchDetail::presentFrame(); }
inline void setDisplayBrightnessPercent(uint8_t percent) {
  auto& runtime = DisplayTouchDetail::runtime;
  percent = percent > 100 ? 100 : percent;
  if (runtime.brightness == percent) return;
  runtime.brightness = percent;
  DisplayTouchDetail::applyBacklight();
}
inline bool displayIsAwake() {
  return DisplayTouchDetail::runtime.power.awakeRequested();
}
inline bool displayReadyToPresent() {
  const auto& runtime = DisplayTouchDetail::runtime;
  return runtime.ready && runtime.power.ready();
}
inline void discardDisplayTouchEvents() {
#if KIBI_UI_DIAGNOSTICS
  UiDiagnostics::cancelInput();
#endif
  auto& runtime = DisplayTouchDetail::runtime;
  runtime.touchEpoch.fetch_add(1);
  if (runtime.touchEvents) xQueueReset(runtime.touchEvents);
}
inline void setDisplayAwake(bool awake) {
  using namespace DisplayTouchDetail;
  if (!runtime.ready || runtime.power.awakeRequested() == awake) return;
  runtime.touchEnabled.store(false);
  discardDisplayTouchEvents();
  runtime.firstFrame = true;
  writeBacklight(0);
  applyPowerCommand(runtime.power.request(awake, millis()));
}
inline bool tickDisplayPower(uint32_t now) {
  using namespace DisplayTouchDetail;
  if (!runtime.ready) return false;
  const bool wasReady = runtime.power.ready();
  applyPowerCommand(runtime.power.tick(now));
  const bool becameReady = runtime.power.ready() &&
      (!wasReady || !runtime.touchEnabled.load());
  if (becameReady) {
    runtime.touchEnabled.store(true);
    if (runtime.touchTask) xTaskNotifyGive(runtime.touchTask);
  }
  return becameReady;
}
inline bool nextTouchEvent(DisplayTouchDetail::TouchEvent& event) {
  const auto& runtime = DisplayTouchDetail::runtime;
  if (!runtime.touchEnabled.load()) return false;
  const auto queue=runtime.touchEvents;
  if (!queue) return false;
  while (xQueueReceive(queue, &event, 0) == pdTRUE)
    if (event.epoch == runtime.touchEpoch.load()) return true;
  return false;
}

#endif  // ARDUINO
}  // namespace Tamagotchi
