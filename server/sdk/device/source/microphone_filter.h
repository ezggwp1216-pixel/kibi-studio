#pragma once
#include "config.h"

namespace Tamagotchi::MicrophoneAudio {
// Keep the approved rumble/presence filtering, then apply the clarity EQ chosen
// in a same-recording comparison. Fixed headroom avoids automatic gain or a
// gate that could cut quiet syllables. State is per capture.
class VoiceFilter {
  struct Coefficients { float b0,b1,b2,a1,a2; };
  struct Biquad {
    float first=0,second=0;
    float process(float sample,const Coefficients& c) {
      const float output=c.b0*sample+first;
      first=c.b1*sample-c.a1*output+second;
      second=c.b2*sample-c.a2*output;
      return output;
    }
  };
  static_assert(kAudioSampleRate==16000,"Microphone filter coefficients require 16 kHz PCM");
  // RBJ high-pass: 100 Hz, Q=1/sqrt(2). Shelf: 1200 Hz, +2 dB, S=1.
  inline static constexpr Coefficients kHighPass={
      0.9726138984998437f,-1.9452277969996874f,0.9726138984998437f,
      -1.9444776577670932f,0.9459779362322812f};
  inline static constexpr Coefficients kPresence={
      1.212599733642932f,-1.6769574463878423f,0.6459772417788794f,
      -1.3133776435245132f,0.4949971725584827f};
  // RBJ bell: 400 Hz, -3 dB, Q=0.8. Shelf: 2000 Hz, +2.5 dB, S=1.
  inline static constexpr Coefficients kBoxReduction={
      0.9695958223897546f,-1.7697309474507485f,0.822195043931889f,
      -1.7697309474507485f,0.7917908663216437f};
  inline static constexpr Coefficients kClarity={
      1.2358013486891426f,-1.2424816903628424f,0.4403137448225534f,
      -0.8775027122274959f,0.3111361153763495f};
 public:
  float process(float sample) {
    const float voiced=presence_.process(highPass_.process(sample,kHighPass),kPresence);
    return 0.8f*clarity_.process(boxReduction_.process(voiced,kBoxReduction),kClarity);
  }
  void reset() { highPass_={}; presence_={}; boxReduction_={}; clarity_={}; }
 private:
  Biquad highPass_,presence_,boxReduction_,clarity_;
};
} // namespace Tamagotchi::MicrophoneAudio
