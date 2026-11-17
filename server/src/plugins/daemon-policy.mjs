// Query only the fields needed to enforce worker isolation. Never forward raw
// daemon metadata or diagnostics through the broker protocol.
export const DAEMON_POLICY_ARGS = Object.freeze(['info', '--format', '{"securityOptions":{{json .SecurityOptions}},"cgroupVersion":{{json .CgroupVersion}},"cgroupDriver":{{json .CgroupDriver}}}']);

export function hasRequiredDaemonIsolation(output) {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      && Array.isArray(value.securityOptions) && value.securityOptions.includes('name=rootless')
      && value.cgroupVersion === '2' && value.cgroupDriver === 'systemd';
  } catch { return false; }
}
