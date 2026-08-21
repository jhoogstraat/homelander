// Unit tests for IS24Contactor verification logic.
// Mocks page.evaluate to simulate different IS24 responses.
// Run: node --test test/is24-contactor.test.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IS24Contactor, extractExposeIdsFromText } from '../engine/is24-contactor.js';
import { isCdpFatalError } from '../engine/cdp-limits.js';

/** Create a contactor with a mocked page. */
function mockContactor() {
  const c = new IS24Contactor('http://localhost:9222', {}, 'balanced', {}, {});
  c.page = {
    evaluate: async () => ({}),  // overridden per-test
    screenshot: async () => {},
    close: async () => {},
    isClosed: () => false,
    title: async () => '',
    on: () => {},                // dialog auto-dismiss handler registration
  };
  return c;
}

/** Return a function that returns each state in sequence, repeats the last. */
function evaluateSeq(...states) {
  let i = 0;
  return async () => {
    const s = states[Math.min(i, states.length - 1)];
    i++;
    return typeof s === 'function' ? s() : s;
  };
}

// ============================================================================
// Nachrichten expose ID extraction tests
// ============================================================================
describe('extractExposeIdsFromText() — Nachrichten sync', () => {
  it('extracts expose IDs from links, query params, and embedded page data', () => {
    const ids = extractExposeIdsFromText(
      'https://www.immobilienscout24.de/expose/123456789',
      'https://www.immobilienscout24.de/somewhere?exposeId=987654321&foo=bar',
      '{"exposeId":"112233445"}',
      'duplicate https://www.immobilienscout24.de/expose/123456789',
    ).sort();
    assert.deepEqual(ids, ['112233445', '123456789', '987654321']);
  });

  it('extracts expose IDs from the IS24 messenger conversations HTML shape', () => {
    const html = `
      <div data-testid="conversations-list">
        <div data-testid="conversation">
          <p data-testid="previewMsg">Sehr geehrte Frau Neumann, vielen Dank für Ihre Anfrage bezüglich der Immobilie in 81673 München: https://www.immobilienscout24.de/expose/168891969</p>
        </div>
        <div data-testid="conversation">
          <p data-testid="previewMsg">Ihre Anfrage für https://www.immobilienscout24.de/expose/168839069 wurde empfangen.</p>
        </div>
      </div>
    `;
    const ids = extractExposeIdsFromText(html).sort();
    assert.deepEqual(ids, ['168839069', '168891969']);
  });
});

describe('Messenger API expose ID extraction — Nachrichten sync', () => {
  function withBrowserFetch(c, fetchImpl) {
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    c.page.evaluate = async (fn, arg) => {
      globalThis.window = { location: { origin: 'https://www.immobilienscout24.de' } };
      globalThis.fetch = fetchImpl;
      return await fn(arg);
    };
    return () => {
      globalThis.window = originalWindow;
      globalThis.fetch = originalFetch;
    };
  }

  function jsonResponse(body, status = 200, headers = { 'content-type': 'application/json' }) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (key) => headers[key.toLowerCase()] || headers[key] || '' },
      text: async () => JSON.stringify(body),
    };
  }

  it('paginates with timestampOfLastConversationPaginated and deduplicates IDs', async () => {
    const c = mockContactor();
    const calls = [];
    const restore = withBrowserFetch(c, async (url) => {
      const parsed = new URL(url);
      calls.push(parsed.pathname + parsed.search);
      const page2 = parsed.searchParams.get('timestampOfLastConversationPaginated') === '2026-06-28T12:00:00Z';
      const conversations = page2
        ? [{ referenceId: '333333333', lastUpdateDateTime: '2026-06-28T11:00:00Z' }]
        : Array.from({ length: 20 }, (_, i) => ({
            referenceId: i === 19 ? '222222222' : '111111111',
            lastUpdateDateTime: i === 19 ? '2026-06-28T12:00:00Z' : `2026-06-28T12:${String(59 - i).padStart(2, '0')}:00Z`,
          }));
      return jsonResponse({ conversations });
    });

    try {
      const result = await c._fetchMessengerApiExposeIds();
      assert.equal(result.ok, true);
      assert.equal(result.source, 'api');
      assert.equal(result.pagesScanned, 2);
      assert.deepEqual(result.exposeIds.sort(), ['111111111', '222222222', '333333333']);
      assert.deepEqual(calls, [
        '/nachrichten-manager/api/seeker/conversations',
        '/nachrichten-manager/api/seeker/conversations?timestampOfLastConversationPaginated=2026-06-28T12%3A00%3A00Z',
      ]);
    } finally {
      restore();
    }
  });

  it('marks API 401/403 as fail-closed session expiry', async () => {
    const c = mockContactor();
    const restore = withBrowserFetch(c, async () => jsonResponse({ error: 'unauthorized' }, 401));

    try {
      const result = await c._fetchMessengerApiExposeIds();
      assert.equal(result.ok, false);
      assert.equal(result.failClosed, true);
      assert.match(result.reason, /SESSION_EXPIRED/);
    } finally {
      restore();
    }
  });

  it('fails closed on non-JSON challenge pages instead of falling back to DOM', async () => {
    const c = mockContactor();
    const restore = withBrowserFetch(c, async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html' },
      text: async () => '<html><title>Sicherheitsprüfung</title><body>AWSWAF challenge</body></html>',
    }));

    try {
      const result = await c._fetchMessengerApiExposeIds();
      assert.equal(result.ok, false);
      assert.equal(result.failClosed, true);
      assert.match(result.reason, /PERIMETER_CAPTCHA|non-JSON|invalid response/);
      assert.deepEqual(result.exposeIds, []);
    } finally {
      restore();
    }
  });

  it('scrapeNachrichtenExposeIds reuses an existing same-origin IS24 page without navigating to Messenger', async () => {
    const c = mockContactor();
    let navigated = false;
    c.page.url = () => 'https://www.immobilienscout24.de/expose/168894172#/basicContact/email';
    c.page.title = async () => 'IS24';
    c.page.evaluate = async (fn, arg) => {
      if (typeof arg === 'string') {
        navigated = true;
        return undefined;
      }
      globalThis.window = { location: { origin: 'https://www.immobilienscout24.de' } };
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => jsonResponse({ conversations: [{ referenceId: '168894172', lastUpdateDateTime: '2026-06-28T12:00:00Z' }] });
      try { return await fn(arg); }
      finally { globalThis.fetch = originalFetch; delete globalThis.window; }
    };

    const result = await c.scrapeNachrichtenExposeIds();
    assert.equal(result.ok, true);
    assert.equal(navigated, false);
    assert.deepEqual(result.exposeIds, ['168894172']);
  });
});

// ============================================================================
// _waitForCaptchaSubmitResult() tests
// ============================================================================
describe('_waitForCaptchaSubmitResult() — captcha submit waits', () => {
  it('waits through loading and returns accepted on success', async () => {
    const c = mockContactor();
    let calls = 0;
    c.page.evaluate = async () => {
      calls++;
      if (calls === 1) {
        return {
          hasCaptchaInput: true,
          hasCaptchaText: true,
          success: false,
          serverError: false,
          validationText: false,
          loading: true,
          imgSrc: 'captcha-a',
          imgLoaded: true,
        };
      }
      return {
        hasCaptchaInput: false,
        hasCaptchaText: false,
        success: true,
        serverError: false,
        validationText: false,
        loading: false,
        imgSrc: '',
        imgLoaded: false,
      };
    };

    const result = await c._waitForCaptchaSubmitResult({ src: 'captcha-a' }, 2_000);
    assert.equal(result, 'accepted');
    assert.ok(calls >= 2);
  });

  it('does not immediately retry the same still-visible captcha after submit', async () => {
    const c = mockContactor();
    c.page.evaluate = async () => ({
      hasCaptchaInput: true,
      hasCaptchaText: true,
      success: false,
      serverError: false,
      validationText: false,
      loading: false,
      imgSrc: 'captcha-a',
      imgLoaded: true,
    });

    const result = await c._waitForCaptchaSubmitResult({ src: 'captcha-a' }, 5);
    assert.equal(result, 'same_challenge_timeout');
  });
});

// ============================================================================
// _isBlocked() tests
// ============================================================================
describe('_isBlocked() — captcha detection', () => {
  it('title "Roboter"', async () => {
    const c = mockContactor();
    c.page.title = async () => 'Roboter-Check';
    assert.equal(await c._isBlocked(), true);
  });
  it('title "Sicherheitsprüfung"', async () => {
    const c = mockContactor();
    c.page.title = async () => 'Sicherheitsprüfung';
    assert.equal(await c._isBlocked(), true);
  });
  it('title "Sicherheitsabfrage"', async () => {
    const c = mockContactor();
    c.page.title = async () => 'Sicherheitsabfrage';
    assert.equal(await c._isBlocked(), true);
  });
  it('body "Ich bin kein Roboter"', async () => {
    const c = mockContactor();
    c.page.title = async () => 'IS24';
    c.page.evaluate = async () => 'Ich bin kein Roboter';
    assert.equal(await c._isBlocked(), true);
  });
  it('body "Sicherheitsabfrage" + "Zeichen aus dem Bild"', async () => {
    const c = mockContactor();
    c.page.title = async () => 'IS24';
    c.page.evaluate = async () => 'Sicherheitsabfrage: hy5bp — Zeichen aus dem Bild eingeben';
    assert.equal(await c._isBlocked(), true);
  });
  it('normal page → false', async () => {
    const c = mockContactor();
    c.page.title = async () => 'IS24';
    c.page.evaluate = async () => 'Wohnung mieten Hamburg 3 Zimmer';
    assert.equal(await c._isBlocked(), false);
  });
});

// ============================================================================
// _waitForForm() tests
// ============================================================================
describe('_waitForForm() — form variants', () => {
  it('accepts contact form without message textarea', async () => {
    const c = mockContactor();
    c.page.evaluate = async () => true;
    assert.equal(await c._waitForForm(1), true);
  });

  it('clicks visible Nachricht CTA when form is not open yet', async () => {
    const c = mockContactor();
    let checks = 0;
    let opened = false;
    c._isContactFormOpen = async () => {
      checks++;
      return opened;
    };
    c._openContactFormIfNeeded = async () => {
      opened = true;
      return true;
    };
    assert.equal(await c._waitForForm(100), true);
    assert.ok(checks >= 2);
  });
});

// ============================================================================
// _verifySubmission() tests
// ============================================================================
describe('_verifySubmission() — failure branches', () => {
  const failState = (overrides) => ({
    confirmed: false, formGone: false, captcha: false,
    serverError: false, premium: false, hasErrors: false, validationText: false,
    ...overrides,
  });

  it('captcha (state.captcha)', async () => {
    const c = mockContactor();
    c.page.evaluate = evaluateSeq(failState({ captcha: true }));
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /captcha/);
  });

  it('premium upsell after submit is not classified as premium', async () => {
    const c = mockContactor();
    // Premium classification is only trusted before submit: click Nachricht → upsell/no form.
    // After a real form opened, a disappearing form with generic Plus text is unconfirmed, not premium.
    c.page.evaluate = evaluateSeq(failState({ formGone: true, premium: true }));
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /SUBMIT_UNCONFIRMED/);
  });

  it('server error ("Es ist ein Fehler aufgetreten.") → PREMIUM', async () => {
    const c = mockContactor();
    c.page.evaluate = evaluateSeq(failState({ serverError: true }));
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /PREMIUM_ONLY/);
  });

  it('validation errors (hasErrors)', async () => {
    const c = mockContactor();
    c.page.evaluate = evaluateSeq(failState({ hasErrors: true }));
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /validation/);
  });

  it('validation text (Pflichtfeld)', async () => {
    const c = mockContactor();
    c.page.evaluate = evaluateSeq(failState({ validationText: true }));
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /validation/);
  });
});

describe('_verifySubmission() — success branches', () => {
  const okState = (overrides) => ({
    confirmed: false, formGone: false, captcha: false,
    serverError: false, premium: false, hasErrors: false, validationText: false,
    ...overrides,
  });

  it('confirmation modal → SUCCESS (fast path)', async () => {
    const c = mockContactor();
    c.page.evaluate = evaluateSeq(okState({ confirmed: true }));
    const r = await c._verifySubmission();
    assert.equal(r.verified, true);
    assert.match(r.detail, /modal/);
  });

  it('explicit success text → SUCCESS', async () => {
    const c = mockContactor();
    c.page.evaluate = evaluateSeq(okState({ successText: true }));
    const r = await c._verifySubmission();
    assert.equal(r.verified, true);
    assert.match(r.detail, /success text/);
  });

  it('form disappears without confirmation → FAILURE', async () => {
    const c = mockContactor();
    c.page.evaluate = evaluateSeq(okState({ formGone: true }));
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /SUBMIT_UNCONFIRMED/);
  });

  it('form disappears while logged out → SESSION_EXPIRED', async () => {
    const c = mockContactor();
    c.page.evaluate = evaluateSeq(okState({ formGone: true, loggedOut: true }));
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /SESSION_EXPIRED/);
  });
});

describe('_verifySubmission() — deadline timeout', () => {
  // The poll loop runs until deadline. To test deadline behavior without waiting,
  // set verifyDeadlineMs=0 and return the final structural fallback state.

  it('formGone + explicit success text at deadline → SUCCESS', async () => {
    const c = mockContactor();
    c.verifyDeadlineMs = 0;
    c.page.evaluate = evaluateSeq(
      () => ({ formGone: true, premium: false, loggedOut: false, successText: true, serverError: false }),
    );
    const r = await c._verifySubmission();
    assert.equal(r.verified, true);
    assert.match(r.detail, /success text/);
  });

  it('formGone + generic Suchen+ marketing text at deadline → FAILURE, not premium', async () => {
    const c = mockContactor();
    c.verifyDeadlineMs = 0;
    c.page.evaluate = evaluateSeq(
      () => ({ formGone: true, premium: false, loggedOut: false, successText: false, serverError: false }),
    );
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /SUBMIT_UNCONFIRMED/);
  });

  it('formGone + structural premium gate at deadline → unconfirmed, not premium', async () => {
    const c = mockContactor();
    c.verifyDeadlineMs = 0;
    c.page.evaluate = evaluateSeq(
      () => ({ formGone: true, premium: true, serverError: false }),
    );
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /SUBMIT_UNCONFIRMED/);
    assert.doesNotMatch(r.detail, /premium/i);
  });

  it('formGone but no confirmation at deadline → FAILURE', async () => {
    const c = mockContactor();
    c.verifyDeadlineMs = 0;
    c.page.evaluate = evaluateSeq(
      () => ({ formGone: true, premium: false, loggedOut: false, successText: false, serverError: false }),
    );
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /SUBMIT_UNCONFIRMED/);
  });

  it('no signal at all at deadline → FAILURE', async () => {
    const c = mockContactor();
    c.verifyDeadlineMs = 0;
    c.page.evaluate = evaluateSeq(
      () => ({ formGone: false, premium: false, serverError: false }),
    );
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /no confirmation/);
  });
});

// ============================================================================
// CDP failure handling
//
// Regression cover for the "Runtime.callFunctionOn timed out" class of bug:
// a hung CDP command used to be swallowed into an `ERROR:` reason string,
// which the daemon treats as terminal — burning the listing and leaving the
// broken contactor in place for every listing after it.
// ============================================================================

const PROTOCOL_TIMEOUT_MSG =
  "Runtime.callFunctionOn timed out. Increase the 'protocolTimeout' setting in "
  + 'launch/connect calls for a higher timeout if needed.';

describe('isCdpFatalError() — transient vs terminal', () => {
  it('classifies protocol timeouts and dead transports as fatal', () => {
    for (const msg of [
      PROTOCOL_TIMEOUT_MSG,
      'Page.captureScreenshot timed out.',
      'Protocol error (Runtime.callFunctionOn): Target closed.',
      'Session closed. Most likely the page has been closed.',
      'Execution context was destroyed, most likely because of a navigation.',
      'Navigation failed because browser has been disconnected!',
    ]) {
      assert.equal(isCdpFatalError(new Error(msg)), true, msg);
    }
  });

  it('leaves ordinary page-level failures alone', () => {
    for (const msg of [
      'No node found for selector: input[name="firstName"]',
      'Navigation timeout of 20000 ms exceeded',
      'net::ERR_NAME_NOT_RESOLVED',
    ]) {
      assert.equal(isCdpFatalError(new Error(msg)), false, msg);
    }
  });
});

describe('pingRenderer() — zombie renderer detection', () => {
  it('reports the renderer dead when it stops answering, within its budget', async () => {
    const c = mockContactor();
    c.page.evaluate = () => new Promise(() => {});  // never resolves

    const started = Date.now();
    const alive = await c.pingRenderer(50);
    const elapsed = Date.now() - started;

    assert.equal(alive, false);
    assert.ok(elapsed < 2000, `pingRenderer() took ${elapsed}ms — its timeout is not being applied`);
  });

  it('reports the renderer alive when it answers', async () => {
    const c = mockContactor();
    c.page.evaluate = async () => 1;
    assert.equal(await c.pingRenderer(50), true);
  });
});

describe('apply() — CDP failures are transient, not terminal', () => {
  function contactorThatFailsWith(message) {
    const c = mockContactor();
    c.browser = { isConnected: () => true };
    c.page.url = () => 'about:blank';
    c.page.waitForNavigation = async () => {};
    c.page.evaluate = async () => { throw new Error(message); };
    return c;
  }

  it('rethrows a protocol timeout so the daemon can re-queue and reconnect', async () => {
    const c = contactorThatFailsWith(PROTOCOL_TIMEOUT_MSG);
    await assert.rejects(
      () => c.apply('170125081', 'hallo', '', 5, {}),
      (err) => isCdpFatalError(err),
    );
  });

  it('names the step that hung, so the log points at a call site', async () => {
    const c = contactorThatFailsWith(PROTOCOL_TIMEOUT_MSG);
    await assert.rejects(
      () => c.apply('170125081', 'hallo', '', 5, {}),
      /\[step: apply\(170125081\) › navigate\/assign-location, \d+ms\]/,
    );
  });

  it('still returns a terminal ERROR result for ordinary page failures', async () => {
    const c = contactorThatFailsWith('No node found for selector: #nope');
    const result = await c.apply('170125081', 'hallo', '', 5, {});
    assert.equal(result.success, false);
    assert.match(result.reason, /^ERROR: No node found/);
  });
});

describe('_installDialogHandler() — unhandled dialogs block the renderer', () => {
  it('registers a dismisser and dismisses what arrives', async () => {
    const c = mockContactor();
    const handlers = {};
    let dismissed = false;
    c.page.on = (event, fn) => { handlers[event] = fn; };

    c._installDialogHandler(c.page);
    assert.equal(typeof handlers.dialog, 'function', 'no dialog handler registered');

    handlers.dialog({
      type: () => 'beforeunload',
      message: () => 'Änderungen gehen verloren',
      dismiss: async () => { dismissed = true; },
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(dismissed, true);
  });

  it('registers only once per page', () => {
    const c = mockContactor();
    let registrations = 0;
    c.page.on = () => { registrations++; };
    c._installDialogHandler(c.page);
    c._installDialogHandler(c.page);
    assert.equal(registrations, 1);
  });
});
