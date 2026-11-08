// Optional local extension example. Import and invoke explicitly from your own
// module; it performs no network request and is not enabled automatically.
export function summarizeEvent(event) {
  return { title: event.title, message: event.message, deviceId: event.deviceId };
}
