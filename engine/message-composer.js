// MessageComposer — turns a listing + persona + template into the text that
// goes into the IS24 contact form.
//
// Two paths:
//   AI path       — hand the listing context, persona context and the template
//                   (as the desired layout) to an AI provider (see
//                   ai-providers.js), get one message back, use it verbatim.
//   Template path — the original {{title}}/{{address}}/{{name}} substitution.
//
// The template path is always the floor: if AI is disabled, misconfigured,
// times out, refuses, or returns something that doesn't look like a message,
// the composer falls back to it rather than skipping the application.

import { createProvider } from './ai-providers.js';

const MIN_DRAFT_CHARS = 40;
const MAX_DRAFT_CHARS = 4000;

export const DEFAULT_AI_PROMPT = [
  'Du schreibst Anschreiben für Wohnungsbewerbungen auf ImmobilienScout24.',
  '',
  'Schreibe EINE Nachricht an den Vermieter:',
  '- Nutze die Vorlage als Vorbild für Aufbau, Ton und Länge.',
  '- Formuliere flüssig und natürlich statt Platzhalter einzusetzen.',
  '- Beziehe dich konkret auf das Inserat und die Person.',
  '- Erfinde keine Angaben, die nicht in den Daten stehen.',
  '- Deutsch, höflich, sachlich, max. 200 Wörter.',
  '',
  'Antworte ausschließlich mit dem fertigen Nachrichtentext — keine Anrede an mich,',
  'keine Erklärungen, keine Optionen, kein Markdown.',
].join('\n');

/** The original template substitution — unchanged behaviour, now shared. */
export function renderTemplate(template, listing) {
  return String(template || '')
    .replace(/\{\{title\}\}/g, listing.title || '')
    .replace(/\{\{address\}\}/g, listing.address || '')
    .replace(/\{\{name\}\}/g, [listing._contact?.vorname, listing._contact?.nachname].filter(Boolean).join(' ').trim());
}

const PERSONA_LABELS = {
  anrede: 'Anrede',
  vorname: 'Vorname',
  nachname: 'Nachname',
  email: 'E-Mail',
  telefon: 'Telefon',
  strasse: 'Straße',
  hausnummer: 'Hausnummer',
  plz: 'PLZ',
  ort: 'Ort',
  einzug: 'Einzug',
  einzug_datum: 'Einzugsdatum',
  personen: 'Personen im Haushalt',
  haustiere: 'Haustiere',
  haustiere_zusatz: 'Haustiere (Details)',
  beschaeftigung: 'Beschäftigung',
  einkommen: 'Nettoeinkommen',
  unterlagen: 'Unterlagen',
};

const LISTING_LABELS = {
  title: 'Titel',
  address: 'Adresse',
  price: 'Preis',
  size: 'Größe',
  rooms: 'Zimmer',
  url: 'Link',
};

function labelledLines(source, labels) {
  return Object.entries(labels)
    .map(([key, label]) => [label, source?.[key]])
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
    .map(([label, value]) => `- ${label}: ${String(value).trim()}`);
}

/**
 * Build the single prompt sent to the harness: listing context, persona
 * context, and the template as the requested layout.
 */
export function buildPrompt({ listing = {}, persona = {}, template = '', instructions = '' }) {
  const sections = [instructions || DEFAULT_AI_PROMPT, ''];

  const listingLines = labelledLines(listing, LISTING_LABELS);
  sections.push('## Inserat', listingLines.length ? listingLines.join('\n') : '- (keine Angaben)', '');

  const personaLines = labelledLines(persona, PERSONA_LABELS);
  sections.push('## Bewerber', personaLines.length ? personaLines.join('\n') : '- (keine Angaben)', '');

  sections.push('## Vorlage (Aufbau und Ton)', String(template || '').trim() || '(keine Vorlage hinterlegt)');

  return sections.join('\n');
}

/**
 * Clean up a harness reply and decide whether it is usable as a message.
 * @returns {{ok: true, text: string} | {ok: false, reason: string}}
 */
export function sanitizeDraft(raw) {
  let text = String(raw || '').trim();
  if (!text) return { ok: false, reason: 'empty response' };

  // Harnesses habitually wrap prose in a fenced block.
  const fenced = text.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
  if (fenced) text = fenced[1].trim();

  if (text.length < MIN_DRAFT_CHARS) return { ok: false, reason: `response too short (${text.length} chars)` };
  if (text.length > MAX_DRAFT_CHARS) return { ok: false, reason: `response too long (${text.length} chars)` };
  // Unsubstituted placeholders mean the agent echoed the template instead of
  // writing a message.
  if (/\{\{\w+\}\}/.test(text)) return { ok: false, reason: 'response still contains template placeholders' };

  return { ok: true, text };
}

/** Models to try, in order: primary, then fallback. Blank = harness default. */
export function modelChain(ai = {}) {
  const chain = [ai.model, ai.fallback_model]
    .map((m) => String(m || '').trim())
    .filter((m, i, arr) => m && arr.indexOf(m) === i);
  return chain.length ? chain : [''];
}

export class MessageComposer {
  /**
   * @param {object} opts
   * @param {object} opts.config  Full daemon config (reads .ai, .persona, .message_template)
   * @param {Function} [opts.log]
   * @param {Function} [opts.spawn]        Injectable spawn (tests, ACP provider)
   * @param {Function} [opts.fetchImpl]    Injectable fetch (tests, HTTP providers)
   * @param {Function} [opts.makeProvider] Injectable provider factory (tests)
   */
  constructor({ config, log = () => {}, spawn, fetchImpl, makeProvider } = {}) {
    this.config = config || {};
    this.log = log;
    this._spawn = spawn;
    this._fetch = fetchImpl;
    this._makeProvider = makeProvider || createProvider;
    /** @type {Map<string, object>} model → live provider */
    this._providers = new Map();
  }

  get ai() {
    return this.config.ai || {};
  }

  /** Called on config hot-reload — drops live providers (and their processes). */
  updateConfig(config) {
    this.config = config || {};
    this.disposeProviders();
  }

  disposeProviders() {
    for (const provider of this._providers.values()) {
      try { provider.dispose?.(); } catch { /* already gone */ }
    }
    this._providers.clear();
  }

  dispose() {
    this.disposeProviders();
  }

  _providerFor(model) {
    const cached = this._providers.get(model);
    if (cached) return cached;
    const provider = this._makeProvider({
      ai: this.ai,
      model,
      log: this.log,
      spawn: this._spawn,
      fetchImpl: this._fetch,
    });
    this._providers.set(model, provider);
    return provider;
  }

  async _draftWith(model, prompt) {
    const text = await this._providerFor(model).draft(prompt);
    const clean = sanitizeDraft(text);
    if (!clean.ok) throw new Error(clean.reason);
    return clean.text;
  }

  /**
   * Compose the message for one listing.
   * @param {object} listing  Listing row; `_contact` carries the persona
   * @returns {Promise<{text: string, source: 'ai'|'template', model?: string, errors: string[]}>}
   */
  async compose(listing) {
    const template = this.config.message_template || '';
    const persona = listing?._contact || this.config.persona || {};
    const fallback = () => renderTemplate(template, listing);

    if (!this.ai.enabled) return { text: fallback(), source: 'template', errors: [] };

    const prompt = buildPrompt({
      listing,
      persona,
      template,
      instructions: this.ai.prompt,
    });

    const errors = [];
    for (const model of modelChain(this.ai)) {
      const label = model || 'harness default';
      try {
        const text = await this._draftWith(model, prompt);
        this.log(`AI message composed via ACP (model: ${label})`);
        return { text, source: 'ai', model: label, errors };
      } catch (err) {
        errors.push(`${label}: ${err.message}`);
        this.log(`AI compose failed (model: ${label}): ${err.message}`);
        // A broken provider (e.g. a dead harness process) must not be reused
        // for the next attempt.
        const provider = this._providers.get(model);
        if (provider) {
          try { provider.dispose?.(); } catch { /* already gone */ }
          this._providers.delete(model);
        }
      }
    }

    this.log('AI compose exhausted all models — falling back to the message template');
    return { text: fallback(), source: 'template', errors };
  }
}
