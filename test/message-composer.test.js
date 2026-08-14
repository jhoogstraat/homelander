// Unit tests for message composition: prompt assembly, draft sanitising,
// the model → fallback-model → template chain, and the HTTP provider.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  MessageComposer,
  buildPrompt,
  sanitizeDraft,
  modelChain,
  renderTemplate,
  DEFAULT_AI_PROMPT,
} from '../engine/message-composer.js';
import { createProvider, PROVIDER_IDS } from '../engine/ai-providers.js';

const LISTING = {
  title: 'Schöne 3-Zimmer-Wohnung',
  address: 'Musterstraße 42, 10115 Berlin',
  price: '1.250 €',
  _contact: { vorname: 'Max', nachname: 'Mustermann', email: 'max@example.com', einkommen: '3.500 €' },
};

const TEMPLATE = 'Hallo,\nich interessiere mich für {{title}} in {{address}}.\n{{name}}';

/** Provider stub: returns queued replies, throws queued errors. */
function stubProvider(replies) {
  const calls = [];
  let disposed = 0;
  const makeProvider = ({ model }) => ({
    async draft(prompt) {
      calls.push({ model, prompt });
      const next = replies.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error('no reply queued');
      return next;
    },
    dispose() { disposed += 1; },
  });
  return { makeProvider, calls, disposedCount: () => disposed };
}

describe('renderTemplate', () => {
  it('substitutes listing fields and the applicant name', () => {
    const out = renderTemplate(TEMPLATE, LISTING);
    assert.match(out, /Schöne 3-Zimmer-Wohnung/);
    assert.match(out, /Musterstraße 42, 10115 Berlin/);
    assert.match(out, /Max Mustermann/);
    assert.doesNotMatch(out, /\{\{/);
  });

  it('replaces missing fields with empty strings rather than crashing', () => {
    assert.equal(renderTemplate('{{title}}|{{address}}|{{name}}', {}), '||');
  });
});

describe('buildPrompt', () => {
  it('includes instructions, listing, persona, and the template', () => {
    const prompt = buildPrompt({
      listing: LISTING,
      persona: LISTING._contact,
      template: TEMPLATE,
      instructions: 'INSTRUCTIONS-HERE',
    });
    assert.match(prompt, /INSTRUCTIONS-HERE/);
    assert.match(prompt, /## Inserat/);
    assert.match(prompt, /Titel: Schöne 3-Zimmer-Wohnung/);
    assert.match(prompt, /## Bewerber/);
    assert.match(prompt, /Vorname: Max/);
    assert.match(prompt, /## Vorlage/);
    assert.match(prompt, /\{\{title\}\}/); // template passed through verbatim
  });

  it('uses the built-in instructions when none are configured', () => {
    const prompt = buildPrompt({ listing: LISTING, persona: {}, template: '' });
    assert.ok(prompt.startsWith(DEFAULT_AI_PROMPT));
  });

  it('omits blank fields instead of emitting empty labels', () => {
    const prompt = buildPrompt({ listing: { title: 'A', address: '' }, persona: {}, template: '' });
    assert.doesNotMatch(prompt, /Adresse:/);
    assert.match(prompt, /\(keine Angaben\)/); // empty persona section
  });
});

describe('sanitizeDraft', () => {
  const long = 'Sehr geehrte Damen und Herren, ich interessiere mich sehr für Ihre Wohnung.';

  it('accepts a normal message', () => {
    assert.deepEqual(sanitizeDraft(`  ${long}  `), { ok: true, text: long });
  });

  it('unwraps fenced code blocks', () => {
    assert.deepEqual(sanitizeDraft('```\n' + long + '\n```'), { ok: true, text: long });
    assert.deepEqual(sanitizeDraft('```text\n' + long + '\n```'), { ok: true, text: long });
  });

  it('rejects empty, too-short, and too-long responses', () => {
    assert.equal(sanitizeDraft('').ok, false);
    assert.equal(sanitizeDraft('   ').ok, false);
    assert.equal(sanitizeDraft('too short').ok, false);
    assert.equal(sanitizeDraft('x'.repeat(4001)).ok, false);
  });

  it('rejects a response that still has template placeholders', () => {
    const echoed = sanitizeDraft(`${long} {{title}}`);
    assert.equal(echoed.ok, false);
    assert.match(echoed.reason, /placeholder/);
  });
});

describe('modelChain', () => {
  it('tries the primary then the fallback', () => {
    assert.deepEqual(modelChain({ model: 'a', fallback_model: 'b' }), ['a', 'b']);
  });

  it('de-duplicates and drops blanks', () => {
    assert.deepEqual(modelChain({ model: 'a', fallback_model: 'a' }), ['a']);
    assert.deepEqual(modelChain({ model: 'a', fallback_model: '' }), ['a']);
  });

  it('falls back to the provider default when no model is set', () => {
    assert.deepEqual(modelChain({}), ['']);
  });
});

describe('MessageComposer', () => {
  const baseConfig = (ai) => ({
    message_template: TEMPLATE,
    persona: LISTING._contact,
    ai: { provider: 'acp', command: 'fake', ...ai },
  });

  it('uses the template when AI is disabled and never spawns a provider', async () => {
    const stub = stubProvider([]);
    const composer = new MessageComposer({ config: baseConfig({ enabled: false }), makeProvider: stub.makeProvider });

    const result = await composer.compose(LISTING);
    assert.equal(result.source, 'template');
    assert.equal(result.text, renderTemplate(TEMPLATE, LISTING));
    assert.equal(stub.calls.length, 0);
  });

  it('uses the AI draft when the primary model succeeds', async () => {
    const draft = 'Sehr geehrte Damen und Herren, die Wohnung in Berlin passt perfekt zu uns.';
    const stub = stubProvider([draft]);
    const composer = new MessageComposer({
      config: baseConfig({ enabled: true, model: 'opus', fallback_model: 'sonnet' }),
      makeProvider: stub.makeProvider,
    });

    const result = await composer.compose(LISTING);
    assert.equal(result.source, 'ai');
    assert.equal(result.text, draft);
    assert.equal(result.model, 'opus');
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].model, 'opus');
  });

  it('falls back to the fallback model, then reports which model served', async () => {
    const draft = 'Sehr geehrte Damen und Herren, wir bewerben uns hiermit auf Ihre Wohnung.';
    const stub = stubProvider([new Error('harness exited'), draft]);
    const composer = new MessageComposer({
      config: baseConfig({ enabled: true, model: 'opus', fallback_model: 'sonnet' }),
      makeProvider: stub.makeProvider,
    });

    const result = await composer.compose(LISTING);
    assert.equal(result.source, 'ai');
    assert.equal(result.model, 'sonnet');
    assert.deepEqual(stub.calls.map((c) => c.model), ['opus', 'sonnet']);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /opus: harness exited/);
  });

  it('falls back to the template when every model fails', async () => {
    const stub = stubProvider([new Error('boom'), new Error('also boom')]);
    const composer = new MessageComposer({
      config: baseConfig({ enabled: true, model: 'opus', fallback_model: 'sonnet' }),
      makeProvider: stub.makeProvider,
    });

    const result = await composer.compose(LISTING);
    assert.equal(result.source, 'template');
    assert.equal(result.text, renderTemplate(TEMPLATE, LISTING));
    assert.equal(result.errors.length, 2);
  });

  it('falls back to the template when the AI returns an unusable draft', async () => {
    const stub = stubProvider(['ok', 'ok']); // too short to be a message
    const composer = new MessageComposer({
      config: baseConfig({ enabled: true, model: 'opus', fallback_model: 'sonnet' }),
      makeProvider: stub.makeProvider,
    });

    const result = await composer.compose(LISTING);
    assert.equal(result.source, 'template');
    assert.match(result.errors[0], /too short/);
  });

  it('discards a provider that failed so the next attempt starts clean', async () => {
    const stub = stubProvider([new Error('boom'), new Error('boom')]);
    const composer = new MessageComposer({
      config: baseConfig({ enabled: true, model: 'opus' }),
      makeProvider: stub.makeProvider,
    });

    await composer.compose(LISTING);
    await composer.compose(LISTING);
    assert.equal(stub.calls.length, 2);
    assert.ok(stub.disposedCount() >= 2);
  });

  it('reuses a healthy provider across listings', async () => {
    const draft = 'Sehr geehrte Damen und Herren, ich möchte mich auf Ihre Wohnung bewerben.';
    const stub = stubProvider([draft, draft]);
    const composer = new MessageComposer({
      config: baseConfig({ enabled: true, model: 'opus' }),
      makeProvider: stub.makeProvider,
    });

    await composer.compose(LISTING);
    await composer.compose(LISTING);
    assert.equal(stub.disposedCount(), 0);
  });

  it('drops live providers on config hot-reload', async () => {
    const draft = 'Sehr geehrte Damen und Herren, ich möchte mich auf Ihre Wohnung bewerben.';
    const stub = stubProvider([draft]);
    const composer = new MessageComposer({
      config: baseConfig({ enabled: true, model: 'opus' }),
      makeProvider: stub.makeProvider,
    });

    await composer.compose(LISTING);
    composer.updateConfig(baseConfig({ enabled: true, model: 'sonnet' }));
    assert.equal(stub.disposedCount(), 1);
  });

  it('passes the current template and persona into the prompt', async () => {
    const draft = 'Sehr geehrte Damen und Herren, ich möchte mich auf Ihre Wohnung bewerben.';
    const stub = stubProvider([draft]);
    const composer = new MessageComposer({
      config: baseConfig({ enabled: true, model: 'opus', prompt: 'CUSTOM' }),
      makeProvider: stub.makeProvider,
    });

    await composer.compose(LISTING);
    const { prompt } = stub.calls[0];
    assert.match(prompt, /^CUSTOM/);
    assert.match(prompt, /Vorname: Max/);
    assert.match(prompt, /Schöne 3-Zimmer-Wohnung/);
  });
});

describe('ai-providers', () => {
  it('ships acp and an openai-compatible provider', () => {
    assert.deepEqual(PROVIDER_IDS.sort(), ['acp', 'openai-compatible']);
  });

  it('rejects an unknown provider id', () => {
    assert.throws(() => createProvider({ ai: { provider: 'nope' } }), /unknown AI provider/);
  });

  it('defaults to acp', () => {
    const provider = createProvider({ ai: {}, model: 'x' });
    assert.equal(provider.constructor.name, 'AcpProvider');
  });

  describe('openai-compatible', () => {
    const ai = { provider: 'openai-compatible', base_url: 'https://api.example.com/v1', api_key: 'sk-test' };

    it('posts to /chat/completions and returns the message content', async () => {
      let seen = null;
      const fetchImpl = async (url, init) => {
        seen = { url, init };
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: '  Guten Tag  ' }, finish_reason: 'stop' }] }),
        };
      };
      const provider = createProvider({ ai, model: 'gpt-x', fetchImpl });
      const text = await provider.draft('PROMPT');

      assert.equal(text, 'Guten Tag');
      assert.equal(seen.url, 'https://api.example.com/v1/chat/completions');
      assert.equal(seen.init.headers.authorization, 'Bearer sk-test');
      const body = JSON.parse(seen.init.body);
      assert.equal(body.model, 'gpt-x');
      assert.deepEqual(body.messages, [{ role: 'user', content: 'PROMPT' }]);
    });

    it('omits the auth header when no key is set (local models)', async () => {
      let seen = null;
      const fetchImpl = async (url, init) => {
        seen = init;
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'hallo' } }] }) };
      };
      const provider = createProvider({ ai: { ...ai, api_key: '' }, model: 'llama', fetchImpl });
      await provider.draft('x');
      assert.equal(seen.headers.authorization, undefined);
    });

    it('surfaces HTTP errors', async () => {
      const fetchImpl = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
      const provider = createProvider({ ai, model: 'gpt-x', fetchImpl });
      await assert.rejects(() => provider.draft('x'), /HTTP 429.*rate limited/);
    });

    it('surfaces a content-filter block', async () => {
      const fetchImpl = async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }),
      });
      const provider = createProvider({ ai, model: 'gpt-x', fetchImpl });
      await assert.rejects(() => provider.draft('x'), /content filter/);
    });

    it('requires a base_url and a model', async () => {
      await assert.rejects(
        () => createProvider({ ai: { provider: 'openai-compatible' }, model: 'm', fetchImpl: async () => {} }).draft('x'),
        /base_url/
      );
      await assert.rejects(
        () => createProvider({ ai, model: '', fetchImpl: async () => {} }).draft('x'),
        /no model/
      );
    });
  });
});
