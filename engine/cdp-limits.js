// Shared CDP limits and error classification.
//
// Lives on its own so the Electron main process (electron/chrome.js), the
// daemon (engine/daemon.js) and the contactor (engine/is24-contactor.js) all
// agree on how long a CDP command may take and on what "the browser broke"
// looks like — without any of them importing the others.

/**
 * Ceiling for a single CDP round-trip.
 *
 * Puppeteer's default is 180s, which turns one unanswered command into a
 * three-minute freeze of the whole apply loop.  30s is well above any
 * legitimate command (the slowest is the Messenger scrape, which carries its
 * own in-page budget) and low enough that a lost response costs one cooldown
 * instead of an afternoon.
 */
export const CDP_PROTOCOL_TIMEOUT_MS = 30_000;

const CDP_FATAL_RE = /Target closed|Session closed|Protocol error|WebSocket is not open|Connection closed|Detached from target|Browser has been disconnected|timed out|protocolTimeout|Execution context was destroyed|Requesting main frame too early/i;

/**
 * True when an error means the CDP transport or the renderer is unusable,
 * rather than the listing being unapplicable.
 *
 * Callers must treat these as transient: re-queue the listing, drop the
 * contactor, reconnect.  Folding one into a result string would mark the
 * listing terminally failed and leave the broken browser in place for every
 * listing after it.
 */
export function isCdpFatalError(err) {
  return CDP_FATAL_RE.test(err?.message || String(err || ''));
}
