// Runtime event tracking — emits inline JS that wires every LoggedEvent
// in the archetype to a POST against `${api_base}/apps/${app_id}/events`.
// Brief D wires the ingestion endpoint; this brief only emits the
// outbound side.

export interface EventTrackingEmitOptions {
  api_base: string;
  app_id: string;
}

export function emitEventTrackingScript(opts: EventTrackingEmitOptions): string {
  const apiBase = JSON.stringify(opts.api_base);
  const appId = JSON.stringify(opts.app_id);
  return `
// ── Event tracking (emitted by assembler) ──────────────────────────
(function () {
  var API = ${apiBase};
  var APP = ${appId};
  var VT_KEY = 'tx_vt_' + APP;
  function getVisitorToken() {
    try {
      var existing = localStorage.getItem(VT_KEY);
      if (existing) return existing;
      var buf = new Uint8Array(16);
      (crypto.getRandomValues || function (b) {
        for (var i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
        return b;
      })(buf);
      var hex = Array.from(buf).map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
      localStorage.setItem(VT_KEY, hex);
      return hex;
    } catch (e) {
      return null;
    }
  }
  function emit(event_type, phase_id, payload) {
    try {
      var body = {
        app_id: APP,
        visitor_token: getVisitorToken(),
        event_type: event_type,
        timestamp: new Date().toISOString(),
        phase_id: phase_id || null,
        payload: payload || {}
      };
      fetch(API + '/apps/' + APP + '/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true
      }).catch(function (e) {
        console.warn('[tx-events] delivery failed', e);
      });
    } catch (e) {
      console.warn('[tx-events] emit error', e);
    }
  }
  window.__txAssembler = window.__txAssembler || {};
  window.__txAssembler.events = { emit: emit, visitor_token: getVisitorToken };
  // Fire app_loaded on script execution. The DOMContentLoaded handler
  // below covers any code that initializes after this script runs.
  emit('app_loaded', null, {});
})();
`.trim();
}
