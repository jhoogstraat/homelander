// Bundled Chromium manager for Homelander.
// Uses Electron's own Chromium (via CDP on port 9222) — no separate
// Chrome download or process spawn required.

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer';

const CDP_PORT = 9222;
const IS24_HOME = 'https://www.immobilienscout24.de/';
/** Logged-catch replacement — never throws, logs to console. */
function swallow(err, context) {
  try { console.error(`[chrome] ${context}: ${err?.message || err}`); } catch {}
}

export class ChromeManager {
  constructor() {
    this.browser = null;
    this.cdpUrl = `http://localhost:${CDP_PORT}`;
    this.manualLoginWindow = null;
    this.manualLoginProcess = null; // compat stub for status checks
  }

  async launch(_email, _options = {}) {
    // Electron already has CDP running on port 9222 — just connect.
    await this._waitForCdp(15000);
    await this._connectExisting().catch((err) => { swallow(err, 'connect-existing'); });
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

  async openUrl(url, _email, _options = {}) {
    const browser = await this._connectExisting();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch((err) => { swallow(err, 'open-url-goto'); });
    return this._versionInfo();
  }

  async openLoginPage(email, options = {}) {
    return this.openManualLoginPage(email, options);
  }

  isManualLoginRunning() {
    return !!(this.manualLoginWindow && !this.manualLoginWindow.isDestroyed());
  }

  async stopManualLoginProcess(_timeoutMs = 20000) {
    if (this.manualLoginWindow && !this.manualLoginWindow.isDestroyed()) {
      this.manualLoginWindow.close();
    }
    this.manualLoginWindow = null;
    this.manualLoginProcess = null;
  }

  /**
   * Open a login window using Electron's own Chromium — no separate Chrome
   * process to download or spawn. The daemon connects to the same CDP port.
   */
  async openManualLoginPage(_email, _options = {}) {
    this._logToFile(`openManualLoginPage called: usingElectronChrome`);

    if (await this.isHealthy()) {
      try {
        const browser = await this._connectExisting();
        await browser.newPage();
        const pages = await browser.pages();
        const lastPage = pages[pages.length - 1];
        await lastPage.goto(IS24_HOME, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await lastPage.bringToFront();
        return { cdpConnected: true, manualLogin: false };
      } catch (e) {
        this._logToFile(`CDP navigate failed: ${e?.message || e}`);
      }
    }

    if (this.manualLoginWindow && !this.manualLoginWindow.isDestroyed()) {
      this.manualLoginWindow.focus();
      this.manualLoginWindow.loadURL(IS24_HOME);
      return { manualLogin: true, usingElectron: true };
    }

    const { BrowserWindow } = await import('electron');
    this.manualLoginWindow = new BrowserWindow({
      width: 1200,
      height: 850,
      title: 'Homelander — IS24 Login',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    this.manualLoginWindow.loadURL(IS24_HOME);
    this.manualLoginWindow.on('closed', () => {
      this.manualLoginWindow = null;
    });

    this._logToFile(`Login BrowserWindow created`);

    // Compat stub so existing status checks (exitCode, killed) don't crash
    this.manualLoginProcess = { exitCode: null, killed: false, pid: 0 };

    return { manualLogin: true, usingElectron: true };
  }

  /** Append a line to chrome.log (if path configured by main.js). */
  _logToFile(line) {
    try {
      if (!this._chromeLogPath) return;
      appendFileSync(this._chromeLogPath, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
    } catch { /* best-effort */ }
  }

  async finalizeManualLogin(_email, _options = {}) {
    if (!(await this.isHealthy())) {
      await this._waitForCdp(10000);
    }
    return { manualLogin: false, cdpHealthy: await this.isHealthy() };
  }

  async openListing(exposeIdOrUrl, _email, _options = {}) {
    const url = String(exposeIdOrUrl || '').startsWith('http')
      ? String(exposeIdOrUrl)
      : `https://www.immobilienscout24.de/expose/${encodeURIComponent(String(exposeIdOrUrl))}`;
    return this.openUrl(url);
  }

  async checkIs24Login() {
    let browser = null;
    let checkPage = null;
    try {
      if (!(await this.isHealthy())) return { loggedIn: false, cookies: [] };
      browser = await this._connectExisting();
      checkPage = await browser.newPage();
      await checkPage.goto(IS24_HOME, { waitUntil: 'domcontentloaded', timeout: 10000 });
      await new Promise(r => setTimeout(r, 1000));

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
