// Unit tests for searchUrlUi.js (src/shared/searchUrlUi.js).
// Run: node --test test/search-url-ui.test.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSearchName } from '../src/shared/searchUrlUi.js';

describe('deriveSearchName', () => {
  it('names a region search after its district', () => {
    assert.equal(
      deriveSearchName('https://www.immobilienscout24.de/Suche/de/hamburg/hamburg/altona/wohnung-mieten'),
      'Altona · wohnung zur Miete'
    );
  });

  it('names a radius search after its centre, not the word "radius"', () => {
    assert.equal(
      deriveSearchName(
        'https://www.immobilienscout24.de/Suche/radius/wohnung-mieten'
        + '?centerofsearchaddress=Hamburg;Altona&geocoordinates=53.55073;9.93549;1.0'
      ),
      'Hamburg, Altona · wohnung zur Miete'
    );
  });

  it('falls back to the type alone when a radius URL has no centre address', () => {
    assert.equal(
      deriveSearchName(
        'https://www.immobilienscout24.de/Suche/radius/wohnung-mieten?geocoordinates=53.55073;9.93549;1.0'
      ),
      'wohnung zur Miete'
    );
  });

  it('returns an empty string for non-IS24 URLs', () => {
    assert.equal(deriveSearchName('https://example.com/Suche/de/berlin/wohnung-mieten'), '');
  });

  it('returns an empty string for unparseable input', () => {
    assert.equal(deriveSearchName('not a url'), '');
  });
});
