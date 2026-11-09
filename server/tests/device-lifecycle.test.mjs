import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
async function compiled(t,source,headers=[]){
 const dir=await mkdtemp(join(tmpdir(),'kibi-device-life-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 for(const name of headers)await copyFile(new URL('../sdk/device/source/'+name,import.meta.url),join(dir,name));
 await writeFile(join(dir,'main.cpp'),source);
 await run(process.env.CXX||'c++',['-std=c++17','-Wall','-Wextra','-Werror','-I',dir,join(dir,'main.cpp'),'-o',join(dir,'check')],{timeout:30000});
 const r=await run(join(dir,'check'),[],{timeout:5000});assert.equal(r.stderr,'');
}
test('reviewed audio lifecycle preserves ownership, bounds, cancellation and explicit silent preparation',async t=>{
 let source=await readFile(new URL('./fixtures/device-audio.cpp',import.meta.url),'utf8');
 const preparation=String.raw`
 {Bus bus;Driver driver;Audio audio(driver,bus,true);
  assert(!audio.preparePlayback());assert(audio.begin());assert(audio.preparePlayback());
  assert(driver.ampOn&&!audio.playing()&&driver.sent.empty());
  const auto calls=driver.calls;assert(audio.preparePlayback());assert(driver.calls==calls);
  int16_t silent[2]={};size_t count=0;
  assert(audio.writeSpeakerMono(silent,2,count)==DeviceAudio::Status::Ok&&count==2);
  assert(driver.ampOn&&!audio.playing());assert(audio.stopPlayback()&&!driver.ampOn);
  assert(audio.preparePlayback()&&driver.ampOn);assert(audio.setVolume(0)&&!driver.ampOn);
  assert(!audio.preparePlayback());assert(audio.setVolume(20)&&audio.preparePlayback());
  driver.outcome=DeviceAudio::Status::Error;int16_t sample=100;
  assert(audio.writeSpeakerMono(&sample,1,count)==DeviceAudio::Status::Error&&!driver.ampOn);
  driver.outcome=DeviceAudio::Status::Ok;assert(audio.preparePlayback());
  assert(audio.end()&&!driver.ampOn&&!audio.preparePlayback());}
 `;
 assert.equal(source.split('int main() {').length,2);source=source.replace('int main() {','int main() {'+preparation);
 await compiled(t,source,['audio_codec_power.h']);
});
test('actual battery and charging state keep unknown, expiry and millis rollover semantics',async t=>{
 const header=await readFile(new URL('../sdk/device/source/state_info.h',import.meta.url),'utf8');
 const start=header.indexOf('inline int batteryPercentFromRaw('),end=header.indexOf('inline void drawStateInfo(');
 assert.ok(start>=0&&end>start);
 const functions=header.slice(start,end);
 await compiled(t,String.raw`
 #include <cassert>
 #include <cstdint>
 namespace Tamagotchi {constexpr int kBatteryFullRaw=2482;
 `+functions+String.raw`
 }
 using namespace Tamagotchi;
 int main(){
  BatteryMonitor battery;assert(battery.percentage(0)==-1);
  uint16_t samples[16];for(auto& v:samples)v=2172;
  battery.acceptSeries(samples,0);assert(battery.percentage(0)==40);
  assert(battery.percentage(29999)==40&&battery.percentage(30000)==-1);
  samples[0]=0;battery.acceptSeries(samples,30001);assert(battery.percentage(30001)==-1);
  for(auto& v:samples)v=2482;
  battery.acceptSeries(samples,UINT32_MAX-100);assert(battery.percentage(50)==100);
  assert(battery.percentage(30000)==-1);
  assert(batteryPercentFromRaw(1985)==0&&batteryPercentFromRaw(2048)==20);
  assert(batteryPercentFromRaw(2172)==40&&batteryPercentFromRaw(2296)==60);
  assert(batteryPercentFromRaw(2420)==80&&batteryPercentFromRaw(2482)==100);
  ChargingMonitor charge;assert(!charge.known&&!charge.active);
  charge.sample(true,UINT32_MAX-100);assert(charge.known&&charge.active);
  charge.sample(false,2898);assert(charge.active);charge.sample(false,2899);assert(!charge.active);
 }
 `);
});
