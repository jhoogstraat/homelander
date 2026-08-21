// Bundled Chromium manager for Homelander.
// Owns one Puppeteer-managed Chromium profile, keeps CDP available for the daemon,
// and controls browser visibility without touching user-owned tabs.

import { existsSync, mkdirSync, appendFileSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { spawn, execSync } from 'node:child_process';
import { app } from 'electron';
import puppeteer from 'puppeteer';
import { CDP_PROTOCOL_TIMEOUT_MS } from '../engine/cdp-limits.js';

const CDP_PORT = 9222;
const DEFAULT_MAX_TABS = 5;
const DEFAULT_WINDOW_POSITION = { left: 80, top: 60, width: 1200, height: 850 };
const IS24_HOME = 'https://www.immobilienscout24.de/';
/** Logged-catch replacement — never throws, logs to console. */
function swallow(err, context) {
  try { console.error(`[chrome] ${context}: ${err?.message || err}`); } catch {}
}


function getBundledChromiumPath() {
  // Tier 1: Puppeteer's bundled Chromium (dev mode / npm install).
  // In packaged builds, puppeteer.executablePath() can return a
  // wrong-architecture binary from a stale ~/.cache/puppeteer/ left
  // by a previous install — skip it and go straight to the bundled
  // chrome-bin/ which always matches the DMG architecture.
  if (!app.isPackaged) {
    try {
      const p = puppeteer.executablePath();
      if (p && existsSync(p)) return p;
    } catch {}
  }

  // Tier 2: Our bundled extraResource (production build)
  try {
    if (process.resourcesPath) {
      const bundledDir = join(process.resourcesPath, 'chrome-bin');
      if (existsSync(bundledDir)) {
        const found = findChromeExeSync(bundledDir);
        if (found) return found;
      }
    }
  } catch {}

  // Tier 3: System-installed Chrome/Edge (trusted by AV, no download needed)
  const systemPaths = process.platform === 'win32'
    ? [
        join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
        join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
        join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
        join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
      ]
    : [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
      ];
  for (const p of systemPaths) {
    try { if (p && existsSync(p)) return p; } catch {}
  }

  return null;
}

/** Walk a directory tree and find the Chrome executable (synchronous). */
function findChromeExeSync(root) {
  try {
    const isWin = process.platform === 'win32';
    const target = isWin ? 'chrome.exe' : 'chrome';
    const walk = (dir) => {
      let entries;
      try { entries = readdirSync(dir); } catch { return null; }
      for (const name of entries) {
        const full = join(dir, name);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isFile() && name.toLowerCase() === target.toLowerCase()) return full;
        if (st.isDirectory()) {
          const found = walk(full);
          if (found) return found;
        }
      }
      return null;
    };
    return walk(root);
  } catch {
    return null;
  }
}

function getProfileDir(email) {
  const hash = createHash('sha256').update(email || 'default').digest('hex').slice(0, 12);
  return join(homedir(), '.homelander', 'chrome-profiles', `profile-${hash}`);
}

function clampMaxTabs(maxTabs) {
  const n = Number(maxTabs || DEFAULT_MAX_TABS);
  return Math.min(5, Math.max(1, Number.isFinite(n) ? Math.floor(n) : DEFAULT_MAX_TABS));
}

export class ChromeManager {
  constructor() {
    this.browser = null;
    this.cdpUrl = `http://localhost:${CDP_PORT}`;
    this.profileDir = null;
    this.manualLoginProcess = null;
    this._restartWindow = [];
    this._maxRestartsPerHour = 3;
    this._lastManualLoginCrash = null; // crash diagnostics from openManualLoginPage
  }

  _options(options = {}) {
    return {
      visibility: options.visibility || 'always_show',
      maxTabs: clampMaxTabs(options.maxTabs),
    };
  }

  async launch(email, options = {}) {
    const opts = this._options(options);
    this.profileDir = getProfileDir(email);

    // If setup browser is still running, connect to it — keep the session alive.
    if (this.isManualLoginRunning()) {
      await this._waitForCdp(15000);
      await this._connectExisting().catch((err) => { swallow(err, 'connect-existing'); });
      if (opts.visibility === 'always_show') await this.showBrowser();
      else await this.hideBrowser().catch((err) => { swallow(err, 'hide-browser'); });
      return this._versionInfo();
    }

    if (await this.isHealthy()) {
      await this._connectExisting().catch((err) => { swallow(err, 'connect-existing'); });
      if (opts.visibility === 'always_show') await this.showBrowser();
      else await this.hideBrowser().catch((err) => { swallow(err, 'hide-browser'); });
      return this._versionInfo();
    }

    let executablePath = getBundledChromiumPath();
    if (!executablePath) {
      throw new Error(
        'Chromium not found. ' +
        (process.platform === 'win32'
          ? 'Please install Google Chrome or Microsoft Edge.'
          : 'Please install Google Chrome or Chromium.')
      );
    }
    mkdirSync(this.profileDir, { recursive: true });

    const now = Date.now();
    this._restartWindow = this._restartWindow.filter(t => now - t < 3600000);
    if (this._restartWindow.length >= this._maxRestartsPerHour) {
      throw new Error('Too many Chromium restarts. Please wait and try again.');
    }
    this._restartWindow.push(now);

    // Prevent macOS App Nap on the Chromium child process.
    // powerSaveBlocker only covers the Electron main process; the
    // spawned Chromium gets App Napped independently when its
    // window is occluded or minimised.  NSAppSleepDisabled in
    // UserDefaults tells Chromium's base::mac::IsAppNapEnabled()
    // to skip App Nap at the kernel level.  Must run BEFORE
    // puppeteer.launch() — Chromium reads NSUserDefaults at
    // process start.
    try {
      execSync(
        // Cover both system Chrome and Chrome for Testing — the production
        // machine may use either.  The first write that succeeds is enough;
        // the second is harmless if the domain doesn't exist.
        'defaults write com.google.Chrome NSAppSleepDisabled -bool YES; defaults write com.google.chrome.for.testing NSAppSleepDisabled -bool YES',
        { timeout: 2000 },
      );
    } catch (err) { swallow(err, 'chrome/app-nap-defaults'); }

    this.browser = await puppeteer.launch({
      executablePath,
      headless: false,
      defaultViewport: null,
      userDataDir: this.profileDir,
      protocolTimeout: CDP_PROTOCOL_TIMEOUT_MS,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        `--remote-debugging-port=${CDP_PORT}`,
        ...(opts.visibility === 'always_show'
          ? ['--window-size=1200,850']
          : [`--window-position=${DEFAULT_WINDOW_POSITION.left},${DEFAULT_WINDOW_POSITION.top}`, '--inactive']),
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-hang-monitor',
        '--disable-translate',
        '--no-pings',

        // Anti-throttling: prevent Chromium from de-prioritising JS timers,
        // requestAnimationFrame, and IPC for occluded/backgrounded windows.
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-ipc-flooding-protection',

        // macOS + Windows: tell Chromium to ignore native occlusion signals
        // (WindowServer "hidden" flag / DWM inactive-desktop suspension)
        // and intensive wake-up throttling.
        '--disable-features=NetworkServiceSandbox,CalculateNativeWinOcclusion,NativeWindowOcclusion,IntensiveWakeUpThrottling,MacWindowOcclusion',

        // Force CPU software rendering (SwiftShader) on all platforms.
        // The GPU compositor is the root cause of the macOS screen-lock
        // zombie deadlock (LatencyInfo vector overflow).  SwiftShader
        // has no GPU context to lose when WindowServer detaches surfaces,
        // so the renderer stays responsive across lock/unlock cycles.
        '--disable-gpu',

        // Windows virtual-desktop resilience: decouple the renderer from
        // DWM's swap-buffer queue.  When DWM stops compositing the window
        // (inactive virtual desktop), these flags prevent the Blink main
        // thread from deadlocking on a full swap-buffer queue — frames are
        // generated and immediately discarded instead of blocking on DWM.
        // These flags hurt macOS occlusion handling; Windows-only.
        ...(process.platform === 'win32' ? [
          '--disable-gpu-compositing',
          '--disable-gpu-vsync',
          '--disable-frame-rate-limit',
        ] : []),
      ],
    });

    // --remote-debugging-port forces navigator.webdriver=true in Chrome 148+.
    // IS24 detects this and rejects sessions. Override on all pages.
    const injectWebdriverOverride = async (page) => {
      try {
        await page.evaluateOnNewDocument(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });
      } catch { /* page might close before injection */ }
    };
    for (const p of await this.browser.pages()) {
      await injectWebdriverOverride(p).catch(() => {});
    }
    this.browser.on('targetcreated', async (target) => {
      if (target.type() === 'page') {
        try { const p = await target.page(); if (p) await injectWebdriverOverride(p); } catch {}
      }
    });

    this.browser.on('disconnected', () => { this.browser = null; });

    await this._waitForCdp(30000);
    const pages = await this.browser.pages();
    if (pages.length === 0) await this.browser.newPage();
    const page = (await this.browser.pages())[0];
    if (page && page.url() === 'about:blank') {
      await page.goto(IS24_HOME, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch((err) => { swallow(err, 'navigate-is24-home'); });
    }
    return this._versionInfo();
  }

  async _connectExisting() {
    if (this.browser?.isConnected?.()) return this.browser;
    this.browser = await puppeteer.connect({ browserURL: this.cdpUrl, defaultViewport: null, protocolTimeout: CDP_PROTOCOL_TIMEOUT_MS });
    this.browser.on('disconnected', () => { this.browser = null; });

    // Spoof navigator.webdriver on all existing + future pages.
    const spoofWebdriver = async (page) => {
      try {
        await page.evaluateOnNewDocument(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });
        await page.evaluate(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });
      } catch { /* page may close before injection */ }
    };
    const pages = await this.browser.pages();
    for (const page of pages) {
      await spoofWebdriver(page).catch(() => {});
    }
    this.browser.on('targetcreated', async (target) => {
      if (target.type() === 'page') {
        const page = await target.page().catch(() => null);
        if (page) await spoofWebdriver(page).catch(() => {});
      }
    });

    return this.browser;
  }

  async _versionInfo() {
    const data = await this._waitForCdp(5000);
    return { cdpUrl: this.cdpUrl, webSocketDebuggerUrl: data.webSocketDebuggerUrl };
  }

  async _waitForCdp(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const resp = await fetch(`${this.cdpUrl}/json/version`);
        if (resp.ok) return await resp.json();
      } catch (err) { swallow(err, 'cdp-version-check'); }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`Chromium CDP not available after ${timeoutMs}ms`);
  }

  async isHealthy() {
    try {
      const resp = await fetch(`${this.cdpUrl}/json/version`, { signal: AbortSignal.timeout(3000) });
      return resp.ok;
    } catch {
      return false;
    }
  }

  async getTabCount() {
    try {
      const browser = await this._connectExisting();
      return (await browser.pages()).length;
    } catch {
      return -1;
    }
  }

  async _setWindowBounds(page, bounds) {
    if (!page) return;
    const session = await page.target().createCDPSession();
    try {
      const { windowId } = await session.send('Browser.getWindowForTarget');
      await session.send('Browser.setWindowBounds', { windowId, bounds });
    } finally {
      await session.detach().catch((err) => { swallow(err, 'session-detach'); });
    }
  }
  async showBrowser() {
    const browser = await this._connectExisting();
    const page = (await browser.pages())[0];
    if (!page) return;
    await this._setWindowBounds(page, DEFAULT_WINDOW_POSITION);
    await page.bringToFront().catch((err) => { swallow(err, 'bring-to-front'); });
  }

  async bringToFront() {
    // Lightweight version of showBrowser — just bring the existing
    // Chromium window to front without repositioning or reconnecting.
    const browser = await this._connectExisting();
    const pages = await browser.pages();
    const page = pages[pages.length - 1]; // most recently active tab
    if (!page) return { pageCount: 0 };
    await page.bringToFront().catch((err) => { swallow(err, 'bring-to-front'); });
    return { pageCount: pages.length };
  }

  async hideBrowser() {
    // Intentional no-op — macOS handles background windows fine without
    // forced off-screen positioning (which causes window-management issues).
  }

  async openUrl(url, email, options = {}) {
    const opts = this._options(options);
    await this.launch(email, { ...opts, visibility: 'always_show' });
    const browser = await this._connectExisting();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch((err) => { swallow(err, 'open-url-goto'); });
    await this.showBrowser();
    return this._versionInfo();
  }

  async openLoginPage(email, options = {}) {
    return this.openManualLoginPage(email, options);
  }

  isManualLoginRunning() {
    return !!this.manualLoginProcess && this.manualLoginProcess.exitCode === null && !this.manualLoginProcess.killed;
  }

  async stopManualLoginProcess(timeoutMs = 20000) {
    const proc = this.manualLoginProcess;
    if (!proc) return;
    if (proc.exitCode !== null || proc.killed) {
      this.manualLoginProcess = null;
      return;
    }

    const isWin = process.platform === 'win32';
    // Windows: POSIX signals don't exist; proc.kill() always calls TerminateProcess.
    // Skip the graceful SIGTERM step and just force-kill.
    if (isWin) {
      try { proc.kill(); } catch { this.manualLoginProcess = null; return; }
      this.manualLoginProcess = null;
      return;
    }

    try { proc.kill('SIGTERM'); } catch { this.manualLoginProcess = null; return; }

    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        if (this.manualLoginProcess === proc) this.manualLoginProcess = null;
        resolve();
      };
      const killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (err) { swallow(err, 'sigkill-manual-login'); }
        done();
      }, timeoutMs);
      proc.once('exit', done);
    });
  }

  async openManualLoginPage(email, options = {}) {
    this._logToFile(`openManualLoginPage called: email=${email ? 'set' : 'empty'} profileDir=${this.profileDir || 'unset'}`);

    // When CDP is already running (e.g. session-expired re-login), don't
    // restart the browser — just open a fresh IS24 tab via CDP and show it.
    if (await this.isHealthy()) {
      try {
        const browser = await this._connectExisting();
        await browser.newPage();
        const pages = await browser.pages();
        const lastPage = pages[pages.length - 1];
        await lastPage.goto(IS24_HOME, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await lastPage.bringToFront();
        await this.showBrowser();
        return { cdpConnected: true, manualLogin: false };
      } catch {
        // CDP navigation failed — fall through to manual-browser path
      }
    }

    this.profileDir = getProfileDir(email);
    mkdirSync(this.profileDir, { recursive: true });

    if (await this.isHealthy()) await this.shutdown();
    if (this.isManualLoginRunning()) return { manualLogin: true, profileDir: this.profileDir };

    let executablePath = getBundledChromiumPath();
    this._logToFile(`getBundledChromiumPath returned: ${executablePath || 'null'}`);
    if (!executablePath) {
      throw new Error(
        'Chromium not found. ' +
        (process.platform === 'win32'
          ? 'Please install Google Chrome or Microsoft Edge.'
          : 'Please install Google Chrome or Chromium.')
      );
    }

    this._logToFile(`Executable resolved: ${executablePath}`);

    // Start Chromium WITH CDP so the daemon can connect to the SAME browser
    // process — no kill + relaunch, no session loss.
    // Also disable AutomationControlled so IS24 doesn't flag the login page.
    //
    // --enable-logging writes Chrome's own startup diagnostics to a file.
    // No pipe needed — Chrome writes directly, avoiding Windows pipe deadlocks.
    const chromeLogFile = join(this.profileDir, 'chrome_debug.log');

    // Log spawn diagnostics to chrome.log so support bundles capture them.
    this._logToFile(`Spawning Chrome: exe=${executablePath} profile=${this.profileDir} log=${chromeLogFile}`);
    try {
      const st = statSync(executablePath);
      this._logToFile(`Chrome exe exists: size=${st.size} mode=${st.mode.toString(8)}`);
    } catch (e) {
      this._logToFile(`Chrome exe stat FAILED: ${e.message}`);
    }

    const chromeArgs = [
      `--user-data-dir=${this.profileDir}`,
      `--remote-debugging-port=${CDP_PORT}`,
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1200,850',
      '--enable-logging',
      `--log-file=${chromeLogFile}`,
      IS24_HOME,
    ];

    // Spawn Chrome with process tracking (all platforms).
    this.manualLoginProcess = spawn(executablePath, chromeArgs, {
      detached: false,
      stdio: 'ignore',
    });

    this._logToFile(`Chrome spawned: pid=${this.manualLoginProcess.pid}`);

    // Catch spawn errors (ENOENT / permission denied)
    this.manualLoginProcess.on('error', (err) => {
      swallow(err, `manual-login-spawn: ${err.message}`);
      this._logToFile(`Spawn error: ${err.message}`);
    });

    // Detect immediate crash. Fire-and-forget — does NOT block return.
    // Renderer picks up the failure via chrome:status IPC.
    let _startupClosed = false;
    const _startupTimer = setTimeout(() => { _startupClosed = true; }, 3000);
    this.manualLoginProcess.once('exit', (code) => {
      clearTimeout(_startupTimer);
      this.manualLoginProcess = null;
      this._lastManualLoginCrash = null;
      if (!_startupClosed && code !== null && code !== 0) {
        const msg = `Chromium crashed on startup (exit ${code})`;
        console.error(`[chrome] ${msg}`);
        this._lastManualLoginCrash = { message: msg, code, at: new Date().toISOString() };
        this._logToFile(msg);
      }
    });

    this.manualLoginProcess.unref();
    return { manualLogin: true, profileDir: this.profileDir };
  }

  /** Append a line to chrome.log (if path configured by main.js). */
  _logToFile(line) {
    try {
      if (!this._chromeLogPath) return;
      appendFileSync(this._chromeLogPath, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
    } catch { /* best-effort */ }
  }

  async finalizeManualLogin(email, options = {}) {
    // DO NOT kill the browser. The daemon connects to the same CDP-enabled
    // Chromium — no process restart, no session loss.
    if (!(await this.isHealthy())) {
      await this._waitForCdp(10000);
    }
    return { manualLogin: false, cdpHealthy: await this.isHealthy() };
  }

  async openListing(exposeIdOrUrl, email, options = {}) {
    const url = String(exposeIdOrUrl || '').startsWith('http')
      ? String(exposeIdOrUrl)
      : `https://www.immobilienscout24.de/expose/${encodeURIComponent(String(exposeIdOrUrl))}`;
    return this.openUrl(url, email, { ...options, visibility: 'always_show' });
  }

  async checkIs24Login() {
    let browser = null;
    let checkPage = null;
    try {
      if (!(await this.isHealthy())) return { loggedIn: false, cookies: [] };
      browser = await this._connectExisting();

      // Always open a fresh tab to IS24 home — never rely on leftover tabs
      // from a previous session, which may be stale expose pages whose
      // execution context was destroyed (producing false logout negatives).
      checkPage = await browser.newPage();
      await checkPage.goto(IS24_HOME, { waitUntil: 'domcontentloaded', timeout: 10000 });
      await new Promise(r => setTimeout(r, 1000)); // let React render the header

      const domLoggedIn = await checkPage.evaluate(() => {
        const visible = (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const text = document.body?.innerText || '';
        const loggedInTextRe = /angemeldet\s+als|zu\s+meinem\s+Bereich|Mein\s*Konto|Meine\s*Immobilien|Postfach|Abmelden/i;
        const loggedOutTextRe = /\bAnmelden\b|Einloggen|Jetzt\s+einloggen|Anmelden\s+oder\s+registrieren/i;
        const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
        const interactive = Array.from(document.querySelectorAll('a, button, [role="link"], [role="button"]')).filter(visible);
        const hasLoggedInText = loggedInTextRe.test(text) || interactive.some(el => loggedInTextRe.test(el.textContent || ''));
        const hasLoginUi = interactive.some(el => loggedOutTextRe.test(el.textContent || ''));
        const isLoginPage = /(\/login|\/anmelden|sso\.)/i.test(window.location.href + ' ' + window.location.pathname);

        if (/angemeldet\s+als/i.test(text) && emailRe.test(text) && !isLoginPage) return true;
        return hasLoggedInText && !hasLoginUi && !isLoginPage;
      }).catch(() => false);

      return { loggedIn: domLoggedIn, cookies: domLoggedIn ? ['session_present'] : [] };
    } catch (err) {
      return { loggedIn: false, cookies: [], error: err.message };
    } finally {
      if (checkPage) await checkPage.close().catch(() => {});
    }
  }

  async getIs24Email() {
    try {
      if (!(await this.isHealthy())) return { email: null, error: 'Chromium not reachable' };
      const browser = await this._connectExisting();
      let page = (await browser.pages()).find(p => p.url().includes('immobilienscout24'));
      if (!page) {
        page = await browser.newPage();
        const url = IS24_HOME;
        await page.evaluate(u => { window.location.href = u; }, url);
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 });
        await new Promise(r => setTimeout(r, 2000));
      }
      const email = await page.evaluate(() => {
        const selectors = ['[data-testid="user-email"]', '.user-email', '[data-email]', 'a[href^="mailto:"]'];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (!el) continue;
          const text = el.textContent?.trim() || el.getAttribute('data-email') || el.getAttribute('href') || '';
          const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
          if (match) return match[0];
        }
        return null;
      });
      return { email, error: null };
    } catch (err) {
      return { email: null, error: err.message };
    }
  }

  async shutdown() {
    try {
      if (this.browser?.isConnected?.()) {
        await this.browser.close();
      } else if (await this.isHealthy()) {
        const browser = await puppeteer.connect({ browserURL: this.cdpUrl, defaultViewport: null, protocolTimeout: CDP_PROTOCOL_TIMEOUT_MS });
        await browser.close();
      }
    } catch (err) { swallow(err, 'shutdown'); }
    this.browser = null;
  }

  async restart(email, options = {}) {
    await this.shutdown();
    await new Promise(r => setTimeout(r, 1000));
    return this.launch(email, options);
  }
}
