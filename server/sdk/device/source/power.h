#pragma once

#include <cstdint>
#include "config.h"

namespace Tamagotchi::Power {
enum class Mode { Normal,Rational };
enum class Stage { Active,Dim,Off };
struct View { Stage stage;uint8_t brightness;bool screenOn; };
struct Policy { uint32_t dimAfterMs=30000,offAfterMs=90000;uint8_t dimBrightness=20; };

// Pure display policy: no key events are consumed and no network/audio work is
// performed here. Call activity() before handling the original + / - input.
class Controller {
 public:
  void begin(Mode mode,uint32_t now) {
    mode_=mode;
    activity(now);
  }
  void setMode(Mode mode,uint32_t now) {
    if(mode_==mode) return;
    mode_=mode;
    activity(now);
  }
  void setBrightness(uint8_t percent) {
    brightness_=percent?percent>100?100:percent:1;
  }
  bool setPolicy(const Policy& policy) {
    if((policy.dimAfterMs && (policy.dimAfterMs<15000 || policy.dimAfterMs>900000)) ||
       (policy.offAfterMs && (policy.offAfterMs<30000 || policy.offAfterMs>3600000)) ||
       (policy.dimAfterMs && policy.offAfterMs && policy.offAfterMs<=policy.dimAfterMs) ||
       policy.dimBrightness<5 || policy.dimBrightness>25 || policy.dimBrightness%5) return false;
    policy_=policy;
    return true;
  }
  void setGlance(bool enabled) {
    glanceEnabled_=enabled;
    if(!enabled) glanceActive_=false;
  }
  void activity(uint32_t now) {
    lastActivity_=lastGlance_=now;
    notificationActive_=glanceActive_=false;
  }
  void notify(uint32_t now) {
    if(mode_!=Mode::Rational) return;
    notificationAt_=lastGlance_=now;
    notificationActive_=true;
    glanceActive_=false;
  }
  View update(uint32_t now,bool externalPower,bool busy,int batteryPercent=-1) {
    // Percentage alone cannot distinguish a full cell from an attached charger.
    (void)batteryPercent;
    if(mode_==Mode::Normal) return active();
    if(externalPower || busy) {
      // Unplugging or finishing a request gets a complete ordinary idle cycle.
      activity(now);
      return active();
    }
    if(notificationActive_) {
      if(uint32_t(now-notificationAt_)<30000) return active();
      notificationActive_=false;
    }
    const uint32_t idle=uint32_t(now-lastActivity_);
    if(!policy_.offAfterMs || idle<policy_.offAfterMs)
      return policy_.dimAfterMs && idle>=policy_.dimAfterMs?dim():active();
    if(glanceActive_ && uint32_t(now-lastGlance_)>=5000) glanceActive_=false;
    if(glanceEnabled_ && !glanceActive_ && uint32_t(now-lastGlance_)>=600000) {
      lastGlance_=now;
      glanceActive_=true;
    }
    return glanceActive_?dim():View{Stage::Off,0,false};
  }

 private:
  View active() const { return {Stage::Active,brightness_,true}; }
  View dim() const { return {Stage::Dim,brightness_<policy_.dimBrightness?brightness_:policy_.dimBrightness,true}; }

  Mode mode_=Mode::Normal;
  uint8_t brightness_=100;
  Policy policy_{};
  uint32_t lastActivity_=0,lastGlance_=0,notificationAt_=0;
  bool glanceEnabled_=false,glanceActive_=false,notificationActive_=false;
};
} // namespace Tamagotchi::Power
