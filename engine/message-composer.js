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
  '- Höflich, sachlich, max. 200 Wörter.',
  '',
  'Antworte ausschließlich mit dem fertigen Nachrichtentext — keine Anrede an mich,',
  'keine Erklärungen, keine Optionen, kein Markdown.',
].join('\n');

// ── Listing language ────────────────────────────────────────────
//
// IS24 is a German site but plenty of listings are written in English (and a
// landlord who advertises in English generally wants to be answered in
// English). We detect from the listing text and tell the agent which language
// to write in — the AI would otherwise default to whatever its prompt is in.

const LANGUAGE_HINTS = {
  de: /\b(wohnung|zimmer|miete|kaltmiete|warmmiete|balkon|wohnfläche|stellplatz|küche|bad|altbau|neubau|etage|erdgeschoss|provisionsfrei|nebenkosten|geeignet|gelegen|befindet)\b/gi,
  en: /\b(apartment|flat|room|rent|rental|kitchen|bathroom|balcony|furnished|floor|available|located|deposit|utilities|spacious|bedroom)\b/gi,
};

export const LANGUAGE_NAMES = { de: 'Deutsch', en: 'English' };

/**
 * Guess the language a listing is written in.
 * German is the default: on a German portal an ambiguous listing (or one with
 * nothing but a street name) is far more likely German than English.
 * @returns {'de'|'en'}
 */
export function detectListingLanguage(listing = {}) {
  const text = [listing.title, listing.address, listing.description, listing.subtitle]
    .filter(Boolean).join(' ');
  if (!text.trim()) return 'de';

  const score = (rx) => (text.match(rx) || []).length;
  const de = score(LANGUAGE_HINTS.de);
  const en = score(LANGUAGE_HINTS.en);
  // Umlauts and ß are a strong German signal that survives short titles.
  const umlauts = (text.match(/[äöüßÄÖÜ]/g) || []).length;

  if (en > de + umlauts) return 'en';
  return 'de';
}

/** The instruction that pins the reply language. */
export function languageInstruction(language) {
  return language === 'en'
    ? 'The listing is written in English. Write the message in English.'
    : 'Das Inserat ist auf Deutsch. Schreibe die Nachricht auf Deutsch.';
}

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
export function buildPrompt({ listing = {}, persona = {}, template = '', instructions = '', language }) {
  const lang = language || detectListingLanguage(listing);
  const sections = [instructions || DEFAULT_AI_PROMPT, '', languageInstruction(lang), ''];

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

/** One attempt slot, normalised. */
function normaliseAttempt(slot, raw) {
  if (!raw) return null;
  return {
    slot,
    harness_id: String(raw.harness_id || '').trim(),
    command: String(raw.command || '').trim(),
    args: Array.isArray(raw.args) ? raw.args : String(raw.args || '').trim().split(/\s+/).filter(Boolean),
    model: String(raw.model || '').trim(),
    thought_level: String(raw.thought_level || '').trim(),
  };
}

/** Does this attempt have enough configured to be worth trying? */
function attemptIsUsable(attempt, provider) {
  if (!attempt) return false;
  // ACP needs a harness to spawn; an HTTP endpoint needs a model to request.
  return provider === 'acp' ? Boolean(attempt.command) : Boolean(attempt.model);
}

/**
 * Attempts to try, in order: primary, then fallback.
 *
 * Each slot carries its own harness, model, and reasoning level, so the
 * fallback can be a completely different agent — e.g. Claude Code at high
 * reasoning first, Codex second.
 */
export function attemptChain(ai = {}) {
  const provider = ai.provider || 'acp';
  const chain = [normaliseAttempt('primary', ai.primary), normaliseAttempt('fallback', ai.fallback)]
    .filter((a) => attemptIsUsable(a, provider));

  // A fallback identical to the primary would just repeat the same failure.
  const seen = new Set();
  return chain.filter((a) => {
    const key = JSON.stringify([a.command, a.args, a.model, a.thought_level]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Human-readable label for logs and the UI. */
export function attemptLabel(attempt) {
  const parts = [attempt.harness_id || attempt.command || 'harness'];
  if (attempt.model) parts.push(attempt.model);
  if (attempt.thought_level) parts.push(attempt.thought_level);
  return parts.join(' / ');
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

  _providerFor(attempt) {
    const key = JSON.stringify([attempt.command, attempt.args, attempt.model, attempt.thought_level]);
    const cached = this._providers.get(key);
    if (cached) return { key, provider: cached };
    const provider = this._makeProvider({
      ai: this.ai,
      attempt,
      log: this.log,
      spawn: this._spawn,
      fetchImpl: this._fetch,
    });
    this._providers.set(key, provider);
    return { key, provider };
  }

  async _draftWith(attempt, prompt) {
    const { provider } = this._providerFor(attempt);
    const text = await provider.draft(prompt);
    const clean = sanitizeDraft(text);
    if (!clean.ok) throw new Error(clean.reason);
    return clean.text;
  }

  /**
   * Compose the message for one listing.
   * @param {object} listing  Listing row; `_contact` carries the persona
   * @returns {Promise<{text, source: 'ai'|'template', attempt?, language, errors: string[]}>}
   */
  async compose(listing) {
    const template = this.config.message_template || '';
    const persona = listing?._contact || this.config.persona || {};
    const language = detectListingLanguage(listing);
    const fallback = () => renderTemplate(template, listing);

    if (!this.ai.enabled) return { text: fallback(), source: 'template', language, errors: [] };

    const chain = attemptChain(this.ai);
    if (chain.length === 0) {
      this.log('AI enabled but no harness/model configured — using the message template');
      return { text: fallback(), source: 'template', language, errors: ['no attempt configured'] };
    }

    const prompt = buildPrompt({
      listing,
      persona,
      template,
      instructions: this.ai.prompt,
      language,
    });

    const errors = [];
    for (const attempt of chain) {
      const label = attemptLabel(attempt);
      try {
        const text = await this._draftWith(attempt, prompt);
        this.log(`AI message composed (${attempt.slot}: ${label}, language: ${language})`);
        return { text, source: 'ai', attempt: label, slot: attempt.slot, language, errors };
      } catch (err) {
        errors.push(`${label}: ${err.message}`);
        this.log(`AI compose failed (${attempt.slot}: ${label}): ${err.message}`);
        // A broken provider (e.g. a dead harness process) must not be reused
        // for the next attempt.
        const key = JSON.stringify([attempt.command, attempt.args, attempt.model, attempt.thought_level]);
        const provider = this._providers.get(key);
        if (provider) {
          try { provider.dispose?.(); } catch { /* already gone */ }
          this._providers.delete(key);
        }
      }
    }

    this.log('AI compose exhausted every attempt — falling back to the message template');
    return { text: fallback(), source: 'template', language, errors };
  }
}
