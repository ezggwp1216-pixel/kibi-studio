import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
let directory;
let executable;

// The reviewed bundle is preferred once integrated. During review the same
// tests consume the isolated candidate, or an explicitly selected public header.
async function headerPath() {
  if (process.env.KIBI_WIFI_HEADER) return resolve(process.env.KIBI_WIFI_HEADER);
  const bundled = new URL('../sdk/device/source/wifi.h', import.meta.url);
  try { await access(bundled); return bundled; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return new URL('../output/development-reliability/wifi/wifi.h', import.meta.url);
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'kibi-wifi-controller-'));
  executable = join(directory, 'wifi-controller');
  await writeFile(join(directory, 'wifi-under-test.h'), await readFile(await headerPath()));
  await writeFile(join(directory, 'main.cpp'), harness);
  const compiled = await run(process.env.CXX || 'c++', [
    '-std=c++17', '-Wall', '-Wextra', '-Werror', '-pedantic',
    join(directory, 'main.cpp'), '-o', executable,
  ], { timeout: 30000 });
  assert.equal(compiled.stderr, '');
});

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

for (const [scenario, description] of [
  ['platform', 'does not initialize radio before platform readiness'],
  ['recovered', 'publishes backend recovery after a stopped station without restarting it'],
  ['failed-start', 'explicit retry recovers a failed initial start after the cooldown'],
  ['stopped-retry', 'explicit retry restarts a stopped station rather than connecting an absent driver'],
  ['failed-again', 'failed restart preserves backoff and can recover on a later explicit retry'],
  ['rollover', 'restart cooldown remains bounded across millisecond rollover'],
  ['reconnect', 'retry on a running station preserves connection ownership and avoids duplicate attempts'],
  ['configuration', 'missing or invalid configuration never starts radio or becomes a driver failure'],
  ['cancel-scan', 'scan cancellation releases resources before a retry is admitted'],
  ['cleanup-failure', 'failed scan cleanup keeps retry blocked until explicit cleanup succeeds'],
  ['scan-rollover', 'scan timeout and cleanup work across millisecond rollover'],
  ['queued-cancel', 'cancelling a queued scan performs no backend scan and preserves its cooldown'],
  ['late-start', 'observes a station that starts asynchronously after an initial driver error'],
]) {
  test(`public Wi-Fi controller ${description}`, async () => {
    const result = await run(executable, [scenario], { timeout: 5000 });
    assert.equal(result.stdout.trim(), scenario);
    assert.equal(result.stderr, '');
  });
}

const harness = String.raw`
#include "wifi-under-test.h"
#include <cstring>
#include <iostream>
using namespace Tamagotchi::DeviceWifi;
#define CHECK(expression) do { if (!(expression)) { std::cerr << __func__ << ":" << __LINE__ << ": " << #expression << "\n"; return 1; } } while (false)

// Only the radio boundary is fake. Admission, refresh, phases, scan ownership,
// cleanup, cooldowns and rollover all execute the real public Controller.
struct Backend {
  Configuration config{true,true,true};
  Link current;
  Event event;
  bool startOkay=true;
  RetryResult connectResult=RetryResult::Accepted;
  ScanPoll scanResult;
  Cleanup cleanupResult=Cleanup::Complete;
  unsigned starts=0,connects=0,scans=0,cleanups=0;
  Configuration configuration() { return config; }
  bool start(int& error) {
    ++starts;error=startOkay?0:71;
    current.started=startOkay;
    if(startOkay) emit(EventKind::Started);
    return startOkay;
  }
  RetryResult connect(int& error) { ++connects;error=connectResult==RetryResult::DriverError?72:0;return connectResult; }
  Event latestEvent() { return event; }
  Link link() { return current; }
  Country country() { return {true,1,11,0}; }
  ScanStart startTargetScan(int& error) { ++scans;error=0;return ScanStart::Accepted; }
  ScanPoll pollTargetScan() { return scanResult; }
  Cleanup cleanupTargetScan(bool,int& error) { ++cleanups;error=cleanupResult==Cleanup::Complete?0:73;return cleanupResult; }
  void emit(EventKind kind) { event.kind=kind;++event.sequence; }
  void connected() { current.started=true;current.associated=true;current.ipReady=true;current.status=3;emit(EventKind::GotIp); }
  void disconnected() { current.started=true;current.associated=false;current.ipReady=false;current.status=6;event.reason=201;emit(EventKind::Disconnected); }
  void stopped() { current={};emit(EventKind::Stopped); }
};

int platform() {
  Backend backend;Controller<Backend> controller(backend);
  CHECK(controller.begin(0)==StartResult::NotReady);
  controller.tick(50000);CHECK(backend.starts==0);
  CHECK(!controller.snapshot().platformReady);
  CHECK(controller.platformReady(50001)==StartResult::Accepted);
  CHECK(backend.starts==1);
  CHECK(controller.platformReady(50002)==StartResult::AlreadyStarted);
  CHECK(backend.starts==1);
  return 0;
}
int recovered() {
  Backend backend;Controller<Backend> controller(backend);
  controller.platformReady(0);backend.connected();controller.tick(20);
  CHECK(controller.snapshot().phase==Phase::Connected);
  backend.stopped();controller.tick(40);
  CHECK(!controller.snapshot().started);CHECK(controller.snapshot().phase==Phase::Error);
  backend.connected();controller.tick(60);
  CHECK(controller.snapshot().ipReady);CHECK(controller.snapshot().phase==Phase::Connected);
  CHECK(backend.starts==1);CHECK(backend.connects==0);
  return 0;
}
int failedStart() {
  Backend backend;backend.startOkay=false;Controller<Backend> controller(backend);
  CHECK(controller.platformReady(0)==StartResult::DriverError);
  controller.tick(1000);CHECK(backend.starts==1);
  CHECK(controller.retry(29999)==RetryResult::Cooldown);
  backend.startOkay=true;
  CHECK(controller.retry(30000)==RetryResult::Accepted);
  CHECK(backend.starts==2);CHECK(backend.connects==0);
  CHECK(controller.snapshot().attempts==2);CHECK(controller.snapshot().phase==Phase::Connecting);
  backend.connected();controller.tick(30020);CHECK(controller.snapshot().ipReady);
  CHECK(controller.retry(30021)==RetryResult::AlreadyConnected);CHECK(backend.starts==2);
  return 0;
}
int stoppedRetry() {
  Backend backend;Controller<Backend> controller(backend);
  controller.platformReady(0);backend.connected();controller.tick(20);
  backend.stopped();controller.tick(2000);
  CHECK(controller.retry(29999)==RetryResult::Cooldown);
  CHECK(controller.retry(30000)==RetryResult::Accepted);
  CHECK(backend.starts==2);CHECK(backend.connects==0);
  backend.connected();controller.tick(30020);CHECK(controller.snapshot().ipReady);
  return 0;
}
int failedAgain() {
  Backend backend;backend.startOkay=false;Controller<Backend> controller(backend);
  controller.platformReady(0);
  CHECK(controller.retry(30000)==RetryResult::DriverError);
  CHECK(controller.snapshot().lastRetry==RetryResult::DriverError);
  CHECK(controller.snapshot().error==71);CHECK(controller.snapshot().attempts==2);
  controller.tick(59999);CHECK(backend.starts==2);
  CHECK(controller.retry(59999)==RetryResult::Cooldown);
  backend.startOkay=true;CHECK(controller.retry(60000)==RetryResult::Accepted);
  CHECK(backend.starts==3);CHECK(backend.connects==0);
  return 0;
}
int rollover() {
  Backend backend;backend.startOkay=false;Controller<Backend> controller(backend);
  const uint32_t boot=0xfffffff0u;
  controller.platformReady(boot);
  CHECK(controller.retry(uint32_t(boot+29999u))==RetryResult::Cooldown);
  backend.startOkay=true;CHECK(controller.retry(uint32_t(boot+30000u))==RetryResult::Accepted);
  CHECK(backend.starts==2);CHECK(controller.snapshot().lastAttemptAt==29984u);
  return 0;
}
int reconnect() {
  Backend backend;Controller<Backend> controller(backend);
  controller.platformReady(0);backend.disconnected();controller.tick(100);
  CHECK(controller.retry(29999)==RetryResult::Cooldown);
  CHECK(controller.retry(30000)==RetryResult::Accepted);
  CHECK(backend.starts==1);CHECK(backend.connects==1);
  CHECK(controller.retry(30001)==RetryResult::Connecting);CHECK(backend.connects==1);
  backend.connected();controller.tick(30002);
  CHECK(controller.retry(30003)==RetryResult::AlreadyConnected);CHECK(backend.connects==1);
  return 0;
}
int configuration() {
  Backend absent;absent.config={false,false,false};Controller<Backend> first(absent);
  CHECK(first.platformReady(0)==StartResult::NotConfigured);
  first.tick(50000);CHECK(first.snapshot().phase==Phase::NotConfigured);
  CHECK(first.retry(50001)==RetryResult::InvalidConfiguration);CHECK(absent.starts==0);
  Backend invalid;invalid.config={false,true,true};Controller<Backend> second(invalid);
  CHECK(second.platformReady(0)==StartResult::InvalidConfiguration);
  second.tick(50000);CHECK(second.snapshot().phase==Phase::InvalidConfiguration);
  CHECK(second.retry(50001)==RetryResult::InvalidConfiguration);CHECK(invalid.starts==0);
  return 0;
}
int cancelScan() {
  Backend backend;Controller<Backend> controller(backend);
  controller.platformReady(0);backend.disconnected();controller.tick(100);
  CHECK(controller.requestScan(30000)==ScanRequestResult::Accepted);controller.tick(30000);
  CHECK(controller.scanSnapshot().status==ScanStatus::Running);
  CHECK(!controller.scanSnapshot().cleanupComplete);
  CHECK(controller.retry(30001)==RetryResult::Busy);CHECK(backend.connects==0);
  CHECK(controller.cancelScan());controller.tick(30002);
  CHECK(controller.scanSnapshot().status==ScanStatus::Cancelled);
  CHECK(controller.scanSnapshot().cleanupComplete);
  CHECK(controller.retry(30003)==RetryResult::Accepted);CHECK(backend.connects==1);
  return 0;
}
int cleanupFailure() {
  Backend backend;Controller<Backend> controller(backend);
  controller.platformReady(0);backend.disconnected();controller.tick(100);
  controller.requestScan(30000);controller.tick(30000);
  backend.cleanupResult=Cleanup::Pending;CHECK(controller.cancelScan());controller.tick(30001);
  controller.tick(30501);CHECK(controller.scanSnapshot().status==ScanStatus::CleanupFailed);
  CHECK(!controller.scanSnapshot().cleanupComplete);
  CHECK(controller.retry(60000)==RetryResult::Busy);CHECK(backend.connects==0);
  backend.cleanupResult=Cleanup::Complete;CHECK(controller.cancelScan());controller.tick(60001);
  CHECK(controller.scanSnapshot().status==ScanStatus::Cancelled);
  CHECK(controller.scanSnapshot().cleanupComplete);
  CHECK(controller.retry(60002)==RetryResult::Accepted);
  return 0;
}
int scanRollover() {
  Backend backend;Controller<Backend> controller(backend);
  const uint32_t boot=0xffff8000u,scanAt=uint32_t(boot+30000u);
  controller.platformReady(boot);backend.disconnected();controller.tick(uint32_t(boot+100u));
  CHECK(controller.requestScan(scanAt)==ScanRequestResult::Accepted);controller.tick(scanAt);
  controller.tick(uint32_t(scanAt+7999u));CHECK(controller.scanSnapshot().status==ScanStatus::Running);
  controller.tick(uint32_t(scanAt+8000u));CHECK(controller.scanSnapshot().status==ScanStatus::TimedOut);
  CHECK(controller.scanSnapshot().cleanupComplete);CHECK(backend.cleanups==1);
  return 0;
}
int queuedCancel() {
  Backend backend;Controller<Backend> controller(backend);
  controller.platformReady(0);backend.disconnected();controller.tick(100);
  CHECK(controller.requestScan(30000)==ScanRequestResult::Accepted);
  CHECK(controller.cancelScan());controller.tick(30001);
  CHECK(controller.scanSnapshot().status==ScanStatus::Cancelled);CHECK(backend.scans==0);
  CHECK(controller.requestScan(59999)==ScanRequestResult::Cooldown);
  CHECK(controller.requestScan(60000)==ScanRequestResult::Accepted);
  return 0;
}
int lateStart() {
  Backend backend;backend.startOkay=false;Controller<Backend> controller(backend);
  controller.platformReady(0);backend.connected();controller.tick(50);
  CHECK(controller.snapshot().started);CHECK(controller.snapshot().ipReady);
  CHECK(controller.snapshot().phase==Phase::Connected);CHECK(controller.snapshot().error==0);
  CHECK(backend.starts==1);CHECK(backend.connects==0);
  return 0;
}
int main(int argc,char** argv) {
  if(argc!=2)return 2;
  struct Scenario { const char* name;int(*run)(); };
  const Scenario scenarios[]={{"platform",platform},{"recovered",recovered},{"failed-start",failedStart},{"stopped-retry",stoppedRetry},{"failed-again",failedAgain},{"rollover",rollover},{"reconnect",reconnect},{"configuration",configuration},{"cancel-scan",cancelScan},{"cleanup-failure",cleanupFailure},{"scan-rollover",scanRollover},{"queued-cancel",queuedCancel},{"late-start",lateStart}};
  for(const auto& scenario:scenarios)if(!std::strcmp(argv[1],scenario.name)){const int status=scenario.run();if(!status)std::cout<<scenario.name<<"\n";return status;}
  return 2;
}
`;
