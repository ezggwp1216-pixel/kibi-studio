import { createPluginBrokerServer } from './broker.mjs';
import { createDockerPluginRuntime } from './docker-runtime.mjs';
import { createYouTubeFrameService } from './youtube.mjs';

/** Separate process entrypoint: only this service receives Docker access. It
 * needs neither the cabinet data directory nor provider/account credentials. */
export async function startPluginBroker({ env = process.env } = {}) {
  let runtime, media, broker;
  try {
    const dockerPath = env.KIBI_PLUGIN_DOCKER_PATH || 'docker';
    runtime = createDockerPluginRuntime({ enabled: env.KIBI_PLUGIN_RUNTIME_ENABLED === '1', dockerPath, image: env.KIBI_PLUGIN_RUNTIME_IMAGE || 'kibi-plugin-js:local' });
    media = createYouTubeFrameService({ enabled: env.KIBI_PLUGIN_MEDIA_ENABLED === '1', dockerPath, image: env.KIBI_PLUGIN_MEDIA_IMAGE || 'kibi-youtube-media:local' });
    broker = createPluginBrokerServer({ socketPath: env.KIBI_PLUGIN_BROKER_SOCKET, runtime, media });
    await broker.listen(); return broker;
  } catch {
    await Promise.allSettled([broker?.close?.(), runtime?.close?.(), media?.close?.()]);
    throw Object.assign(new Error('plugin_broker_unavailable'), { code: 'plugin_broker_unavailable' });
  }
}

if (import.meta.main) {
  try {
    const broker = await startPluginBroker();
    const stop = async () => { await broker.close(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    process.stdout.write('plugin_broker_listening\n');
  } catch { process.stderr.write('plugin_broker_unavailable\n'); process.exitCode = 1; }
}
