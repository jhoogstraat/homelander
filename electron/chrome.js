// Bundled Chromium manager for Homelander.
// Owns one Puppeteer-managed Chromium profile, keeps CDP available for the daemon,
// and controls browser visibility without touching user-owned tabs.

import { existsSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
import { install, computeExecutablePath, detectBrowserPlatform, Browser } from '@puppeteer/browsers';

const CDP_PORT = 9222;
const DEFAULT_MAX_TABS = 5;
const DEFAULT_WINDOW_POSITION = { left: 80, top: 60, width: 1200, height: 850 };
const IS24_HOME = 'https://www.immobilienscout24.de/';
/** Logged-catch replacement — never throws, logs to console. */
function swallow(err, context) {
  try { console.error(`[chrome] ${context}: ${err?.message || err}`); } catch {}
}


/** Puppeteer v24 ships Chrome for Testing 148.0.7778.97 */
const CHROME_BUILD_ID = '148.0.7778.97';

function getBundledChromiumPath() {
  try {
    const executablePath = puppeteer.executablePath();
    if (executablePath && existsSync(executablePath)) return executablePath;
  } catch (err) { swallow(err, 'get-bundled-chromium'); }
  return null;
}

/**
 * Install Chromium for Testing into the Puppeteer cache when it's not
 * already present.  The full `puppeteer` package normally downloads the
 * browser on first `launch()`, but that auto-download fails inside an
 * Electron ASAR bundle — so we call the install API explicitly.
 */
async function ensureChromiumInstalled() {
  const buildId = CHROME_BUILD_ID;
  const cacheDir = join(homedir(), '.cache', 'puppeteer');

  // Fast path: already installed?
  let exePath;
  try {
    exePath = computeExecutablePath({ browser: Browser.CHROME, buildId, cacheDir });
    if (existsSync(exePath)) return exePath;
  } catch { /* not found */ }

  // Try install.  If a previous download left a stale directory (folder
  // exists but chrome.exe is missing), @puppeteer/browsers will refuse to
  // overwrite it.  Clean it up and retry once.
  const doInstall = () => install({
    browser: Browser.CHROME,
    buildId,
    cacheDir,
    platform: detectBrowserPlatform(),
    unpack: true,
  });

  try {
    console.log('[chrome] Chromium not found — downloading (this may take a minute)...');
    await doInstall();
  } catch (err) {
    const msg = err?.message || '';
    if (msg.includes('exists but the executable') && exePath) {
      const installRoot = dirname(dirname(exePath));
      console.log('[chrome] Stale partial download found, cleaning up...');
      try {
        await rm(installRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      } catch (cleanErr) {
        throw new Error(
          `Cannot clean corrupted Chromium download at:\n${installRoot}\n\n` +
          `Please delete this folder manually and restart Homelander.\n(${cleanErr.message})`
        );
      }
      console.log('[chrome] Retrying download...');
      await doInstall();
    } else {
      throw new Error(`Failed to download Chromium: ${msg}. Check your internet connection.`);
    }
  }

  exePath = computeExecutablePath({ browser: Browser.CHROME, buildId, cacheDir });
  console.log(`[chrome] Chromium installed at ${exePath}`);
  return exePath;
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
  }

  _options(options = {}) {
    return {
      visibility: options.visibility || 'hidden_unless_needed',
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

    const executablePath = getBundledChromiumPath();
    let resolvedPath = executablePath;
    if (!resolvedPath) {
      console.log('[chrome] Bundled Chromium not found, installing...');
      resolvedPath = await ensureChromiumInstalled();
    }
    mkdirSync(this.profileDir, { recursive: true });

    const now = Date.now();
    this._restartWindow = this._restartWindow.filter(t => now - t < 3600000);
    if (this._restartWindow.length >= this._maxRestartsPerHour) {
      throw new Error('Too many Chromium restarts. Please wait and try again.');
    }
    this._restartWindow.push(now);

    this.browser = await puppeteer.launch({
      executablePath: resolvedPath,
      headless: false,
      defaultViewport: null,
      userDataDir: this.profileDir,
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
        '--disable-features=NetworkServiceSandbox',
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
    this.browser = await puppeteer.connect({ browserURL: this.cdpUrl, defaultViewport: null });
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

    const executablePath = getBundledChromiumPath();
    if (!executablePath) {
      console.log('[chrome] Chromium not found for manual login, falling back to Puppeteer launch...');
      const info = await this.launch(email, { ...options, visibility: 'always_show' });
      return { cdpConnected: true, manualLogin: false, ...info };
    }

    // Start Chromium WITH CDP so the daemon can connect to the SAME browser
    // process — no kill + relaunch, no session loss.
    // Also disable AutomationControlled so IS24 doesn't flag the login page.
    this.manualLoginProcess = spawn(executablePath, [
      `--user-data-dir=${this.profileDir}`,
      `--remote-debugging-port=${CDP_PORT}`,
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1200,850',
      IS24_HOME,
    ], {
      detached: false,
      stdio: 'ignore',
    });
    this.manualLoginProcess.once('exit', () => { this.manualLoginProcess = null; });
    this.manualLoginProcess.unref();
    return { manualLogin: true, profileDir: this.profileDir };
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
    try {
      if (!(await this.isHealthy())) return { loggedIn: false, cookies: [] };
      browser = await this._connectExisting();
      let pages = await browser.pages();
      const is24Pages = pages.filter(p => {
        const url = p.url();
        return url.includes('immobilienscout24.de') && !url.includes('sso.immobilienscout24.de');
      });
      const is24Page = is24Pages[0] || pages.find(p => p.url().includes('immobilienscout24'));

      const domLoggedIn = (await Promise.all(is24Pages.map(page => page.evaluate(() => {
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
        const isLoginPage = /(\/login|\/anmelden|sso\.)/i.test(`${window.location.href} ${window.location.pathname}`);

        if (/angemeldet\s+als/i.test(text) && emailRe.test(text) && !isLoginPage) return true;
        return hasLoggedInText && !hasLoginUi && !isLoginPage;
      }).catch(() => false)))).some(Boolean);

      return { loggedIn: domLoggedIn, cookies: domLoggedIn ? ['session_present'] : [] };
    } catch (err) {
      return { loggedIn: false, cookies: [], error: err.message };
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
        const browser = await puppeteer.connect({ browserURL: this.cdpUrl, defaultViewport: null });
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
