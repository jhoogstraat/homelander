// AI providers — vendor-agnostic seam behind MessageComposer.
//
// A provider is anything that can turn one prompt string into one message
// string. Two ship in-box:
//
//   acp                 Spawns an agent harness (claude-code-acp, gemini
//                       --experimental-acp, …) and talks Agent Client Protocol
//                       over stdio. Reuses whatever the user already has
//                       installed and logged in — no API key in our config.
//
//   openai-compatible   POSTs to any /chat/completions endpoint. Covers
//                       OpenAI, OpenRouter, Groq, Together, Mistral, Ollama,
//                       LM Studio, vLLM, and Anthropic's compatibility
//                       endpoint — one code path, vendor chosen by base_url.
//
// Adding a third provider means adding one entry to PROVIDERS; nothing in the
// composer, daemon, or UI needs to know about it beyond the dropdown.

import { AcpClient } from './acp-client.js';

const DEFAULT_TIMEOUT_MS = 90000;

function timeoutMsFor(ai) {
  const seconds = Number(ai?.timeout_seconds);
  return seconds > 0 ? seconds * 1000 : DEFAULT_TIMEOUT_MS;
}

// ── ACP provider ────────────────────────────────────────────────

class AcpProvider {
  constructor({ ai, model, log, spawn }) {
    this.ai = ai;
    this.model = model;
    this.log = log;
    this._spawn = spawn;
    this.client = null;
    this._sessionUsed = false;
  }

  async _connect() {
    if (this.client) return this.client;
    if (!this.ai.command) throw new Error('no ACP harness command configured');
    this.client = new AcpClient({
      command: this.ai.command,
      args: Array.isArray(this.ai.args) ? this.ai.args : [],
      cwd: this.ai.cwd || process.cwd(),
      env: this.ai.env || {},
      model: this.model,
      authMethodId: this.ai.auth_method_id || '',
      timeoutMs: timeoutMsFor(this.ai),
      log: this.log,
      spawn: this._spawn,
    });
    await this.client.connect();
    this._sessionUsed = false;
    return this.client;
  }

  async draft(prompt) {
    const client = await this._connect();
    // Each listing gets a fresh session so earlier drafts can't bias the next
    // one — without paying the process-spawn cost again.
    if (this._sessionUsed) await client.newSession();
    this._sessionUsed = true;
    const { text } = await client.prompt(prompt);
    return text;
  }

  /**
   * Models the harness advertises for a session. Empty array = the agent
   * offers no model selector, so the model is chosen at spawn time instead.
   */
  async listModels() {
    const client = await this._connect();
    return client.availableModels();
  }

  dispose() {
    try { this.client?.dispose(); } catch { /* already gone */ }
    this.client = null;
    this._sessionUsed = false;
  }
}

// ── OpenAI-compatible provider ──────────────────────────────────

class OpenAiCompatibleProvider {
  constructor({ ai, model, log, fetchImpl }) {
    this.ai = ai;
    this.model = model;
    this.log = log;
    this._fetch = fetchImpl || globalThis.fetch;
  }

  async draft(prompt) {
    if (!this.ai.base_url) throw new Error('no base_url configured');
    if (!this.model) throw new Error('no model configured');
    if (typeof this._fetch !== 'function') throw new Error('fetch is unavailable in this runtime');

    const url = `${String(this.ai.base_url).replace(/\/+$/, '')}/chat/completions`;
    const headers = { 'content-type': 'application/json', ...(this.ai.headers || {}) };
    // Local runtimes (Ollama, LM Studio) need no key — only send one if set.
    if (this.ai.api_key) headers.authorization = `Bearer ${this.ai.api_key}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMsFor(this.ai));
    let response;
    try {
      response = await this._fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: Number(this.ai.max_tokens) > 0 ? Number(this.ai.max_tokens) : 1024,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(err.name === 'AbortError' ? 'request timed out' : `request failed: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
    }

    const payload = await response.json();
    const choice = payload?.choices?.[0];
    if (choice?.finish_reason === 'content_filter') throw new Error('response blocked by content filter');
    return String(choice?.message?.content || '').trim();
  }

  dispose() {
    // Stateless — nothing to tear down.
  }
}

// ── Registry ────────────────────────────────────────────────────

const PROVIDERS = {
  acp: AcpProvider,
  'openai-compatible': OpenAiCompatibleProvider,
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

export const DEFAULT_PROVIDER = 'acp';

/**
 * @param {object} opts
 * @param {object} opts.ai       The config.ai block
 * @param {string} opts.model    Model id for this attempt ('' = provider default)
 * @param {Function} [opts.log]
 * @param {Function} [opts.spawn]      Injectable spawn (tests, acp only)
 * @param {Function} [opts.fetchImpl]  Injectable fetch (tests, http only)
 */
export function createProvider({ ai = {}, model = '', log = () => {}, spawn, fetchImpl } = {}) {
  const id = ai.provider || DEFAULT_PROVIDER;
  const Provider = PROVIDERS[id];
  if (!Provider) throw new Error(`unknown AI provider '${id}'`);
  return new Provider({ ai, model, log, spawn, fetchImpl });
}
