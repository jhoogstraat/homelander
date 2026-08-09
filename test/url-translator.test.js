// Unit tests for url-translator.js (engine/url-translator.js).
// Run: node --test test/url-translator.test.js
//
// Tests translateUrl, getTotalResults, and fetchListings.
// Mocks global fetch to avoid real network calls.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  translateUrl,
  getTotalResults,
  fetchListings,
  parseSearchUrl,
  validateSearchUrl,
  buildMobileApiUrl,
} from '../engine/url-translator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Original global fetch reference for restore. */
let originalFetch;

before(() => {
  originalFetch = globalThis.fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

/** Install a mock fetch that returns a given response. */
function mockFetch(responseFactory) {
  globalThis.fetch = async (url, init) => {
    if (typeof responseFactory === 'function') {
      return responseFactory(url, init);
    }
    return responseFactory;
  };
}

/** Create a mock Response object. */
function mockResponse(body, status = 200, ok = true) {
  return {
    ok,
    status,
    headers: new Map(Object.entries({ 'content-type': 'application/json' })),
    json: async () => body,
  };
}

// ---------------------------------------------------------------------------
// Canonical parser / validation — conservative search import behavior
// ---------------------------------------------------------------------------

describe('parseSearchUrl — canonical IS24 filter model', () => {
  it('parses the Osnabrück new-build URL with ranges, multi-enums and safe ignored params', () => {
    const input = 'https://www.immobilienscout24.de/Suche/de/niedersachsen/osnabrueck/neubauwohnung-mieten?heatingtypes=central,selfcontainedcentral&numberofrooms=-5.0&price=500.0-&livingspace=30.0-&equipment=handicappedaccessible&pricetype=rentpermonth&enteredFrom=result_list';
    const parsed = parseSearchUrl(input);

    assert.equal(parsed.error, null);
    assert.equal(parsed.canonical.realEstateType, 'apartmentrent');
    assert.equal(parsed.canonical.construction.newBuildingOnly, true);
    assert.deepEqual(parsed.canonical.location.path, ['de', 'niedersachsen', 'osnabrueck']);
    assert.deepEqual(parsed.canonical.price, { min: 500, max: null, type: 'rentpermonth' });
    assert.deepEqual(parsed.canonical.rooms, { min: null, max: 5 });
    assert.deepEqual(parsed.canonical.livingSpace, { min: 30, max: null });
    assert.deepEqual(parsed.canonical.heatingTypes, ['CENTRAL_HEATING', 'SELF_CONTAINED_CENTRAL_HEATING']);
    assert.deepEqual(parsed.canonical.equipment, ['HANDICAPPED_ACCESSIBLE']);
    assert.deepEqual(parsed.safeIgnoredParams, [{ key: 'enteredFrom', value: 'result_list' }]);
    assert.deepEqual(parsed.unsupportedParams, []);
  });

  it('flags dangerous unknown params instead of silently dropping them', () => {
    const parsed = parseSearchUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?petsallowedtypes=yes&unknown=foo&enteredFrom=result_list'
    );

    assert.equal(parsed.error, null);
    assert.deepEqual(parsed.safeIgnoredParams, [{ key: 'enteredFrom', value: 'result_list' }]);
    assert.deepEqual(parsed.unsupportedParams, [
      { key: 'unknown', value: 'foo', risk: 'dangerous' },
    ]);
    assert.deepEqual(parsed.canonical.directParams, [{ key: 'petsallowedtypes', value: 'yes' }]);
  });

  it('rejects malformed ranges instead of ignoring them', () => {
    const parsed = parseSearchUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?price=abc'
    );

    assert.equal(parsed.error, 'Invalid price range: abc');
  });

  it('builds mobile API params without duplicating explicit pricetype', () => {
    const parsed = parseSearchUrl(
      'https://www.immobilienscout24.de/Suche/de/niedersachsen/osnabrueck/neubauwohnung-mieten?price=500.0-&pricetype=rentpermonth'
    );
    const fullUrl = buildMobileApiUrl(parsed.canonical);
    const params = new URL(fullUrl).searchParams;

    assert.deepEqual(params.getAll('pricetype'), ['rentpermonth']);
    assert.equal(params.get('price'), '500-');
    assert.equal(params.get('realestatetype'), 'apartmentrent');
    assert.equal(params.get('newbuilding'), 'true');
  });
});

describe('validateSearchUrl — user friendly import gate', () => {
  it('returns preview lines and blocks dangerous unsupported params', () => {
    const result = validateSearchUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?foo=bar'
    );

    assert.equal(result.ok, false);
    assert.equal(result.error, 'Unsupported IS24 search filters: foo=bar');
    assert.ok(result.preview.filters.includes('Apartment rent'));
    assert.deepEqual(result.unsupportedParams, [{ key: 'foo', value: 'bar', risk: 'dangerous' }]);
  });

  it('accepts WG links, trims the WG slug from geocode, and keeps mobile-supported filters', () => {
    const result = validateSearchUrl(
      'https://www.immobilienscout24.de/Suche/de/bayern/muenchen/4er-wg?gender=male&livingspace=-100.0&energyefficiencyclasses=a,b,a_plus&equipment=fridge,cooker,petsallowed,internet&smokingallowed=allowed&petsallowedtypes=no,yes,negotiable&startrentaldate=2027-05-22&furniture=true&price=1.0-&rentalduration=3&enteredFrom=result_list'
    );
    const params = new URL(result.mobileUrl).searchParams;

    assert.equal(result.ok, true);
    assert.equal(result.error, null);
    assert.deepEqual(result.unsupportedParams, []);
    assert.deepEqual(result.canonical.location.path, ['de', 'bayern', 'muenchen']);
    assert.equal(result.canonical.fullText, '4er wg');
    assert.deepEqual(result.canonical.equipment, ['FRIDGE', 'COOKER', 'PETS_ALLOWED', 'INTERNET']);
    assert.ok(result.preview.filters.includes('4er WG'));
    assert.equal(params.get('geocodes'), '/de/bayern/muenchen');
    assert.equal(params.get('fulltext'), '4er wg');
    assert.equal(params.get('livingspace'), '-100');
    assert.equal(params.get('price'), '1-');
    assert.equal(params.get('energyefficiencyclasses'), 'a,b,a_plus');
    assert.equal(params.get('petsallowedtypes'), 'no,yes,negotiable');
    assert.equal(params.get('equipment'), null);  // filtered: mobile-ignored equipment
    assert.equal(params.has('numberofrooms'), false);
    assert.ok(result.safeIgnoredParams.some(p => p.key === 'gender'));
    assert.ok(result.safeIgnoredParams.some(p => p.key === 'startrentaldate'));
  });

  it('accepts the golden Osnabrück URL and describes the parsed filters', () => {
    const result = validateSearchUrl(
      'https://www.immobilienscout24.de/Suche/de/niedersachsen/osnabrueck/neubauwohnung-mieten?heatingtypes=central,selfcontainedcentral&numberofrooms=-5.0&price=500.0-&livingspace=30.0-&equipment=handicappedaccessible&pricetype=rentpermonth&enteredFrom=result_list'
    );

    assert.equal(result.ok, true);
    assert.equal(result.error, null);
    assert.ok(result.preview.location.includes('Osnabrueck'));
    assert.ok(result.preview.filters.includes('New-build apartment rent'));
    assert.ok(result.preview.filters.includes('Price ≥ 500'));
    assert.ok(result.preview.filters.includes('Rooms ≤ 5'));
    assert.ok(result.preview.filters.includes('Living space ≥ 30 m²'));
    assert.ok(result.preview.filters.includes('Heating: central heating, self-contained central heating'));
    assert.ok(result.preview.filters.includes('Equipment: barrier-free'));
    assert.deepEqual(result.safeIgnoredParams, [{ key: 'enteredFrom', value: 'result_list' }]);
  });

  it('localizes parsed search preview to German when requested by UI locale', () => {
    const result = validateSearchUrl(
      'https://www.immobilienscout24.de/Suche/de/bayern/muenchen/thalkirchen-obersendling-forstenried-fuerstenried-solln/solln/wohnung-mieten?enteredFrom=result_list',
      { locale: 'de' }
    );

    assert.equal(result.ok, true);
    assert.ok(result.preview.location.includes('Muenchen'));
    assert.deepEqual(result.preview.filters, ['Wohnung zur Miete']);
    assert.equal(result.preview.filters.includes('Apartment rent'), false);
  });
});

// ---------------------------------------------------------------------------
// translateUrl — successful translations
// ---------------------------------------------------------------------------

describe('translateUrl — Hamburg', () => {
  it('basic Hamburg apartment rent URL', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/hamburg/hamburg/wohnung-mieten'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.startsWith('https://api.mobile.immobilienscout24.de/search/list?'));
    assert.ok(fullUrl.includes('geocodes=%2Fde%2Fhamburg%2Fhamburg'));
    assert.ok(fullUrl.includes('searchType=region'));
    assert.ok(fullUrl.includes('realestatetype=apartmentrent'));
    assert.ok(fullUrl.includes('pricetype=calculatedtotalrent'));
    assert.ok(fullUrl.includes('exclusioncriteria=swap_flat'));
    assert.ok(fullUrl.includes('sorting=-firstactivation'));
    assert.ok(fullUrl.includes('pagenumber=1'));
    assert.ok(fullUrl.includes('pagesize=20'));
  });

  it('Hamburg with price and rooms params', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/hamburg/hamburg/wohnung-mieten?price=-1000&numberofrooms=2'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('price=-1000'));
    assert.ok(fullUrl.includes('numberofrooms=2'));
  });

  it('Hamburg house rent', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/hamburg/hamburg/haus-mieten'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('realestatetype=houserent'));
    assert.ok(fullUrl.includes('pricetype=calculatedtotalrent'));
  });
});

describe('translateUrl — Berlin', () => {
  it('basic Berlin apartment rent URL', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('geocodes=%2Fde%2Fberlin%2Fberlin'));
    assert.ok(fullUrl.includes('realestatetype=apartmentrent'));
  });

  it('Berlin apartment buy', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-kaufen'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('realestatetype=apartmentbuy'));
    assert.ok(fullUrl.includes('pricetype=purchaseprice'));
  });

  it('Berlin house buy', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/haus-kaufen'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('realestatetype=housebuy'));
    assert.ok(fullUrl.includes('pricetype=purchaseprice'));
  });

  it('Berlin with multiple query params', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?price=-1500&livingspace=60&has-pictures=1&balcony=1'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('price=-1500'));
    assert.ok(fullUrl.includes('livingspace=60'));
    assert.ok(!fullUrl.includes('hasPictures'));   // mobile-unsupported, filtered out
    assert.ok(fullUrl.includes('equipment=balcony'));
  });
});

describe('translateUrl — Munich', () => {
  it('basic Munich apartment rent URL', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/bayern/muenchen/wohnung-mieten'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('geocodes=%2Fde%2Fbayern%2Fmuenchen'));
    assert.ok(fullUrl.includes('realestatetype=apartmentrent'));
  });

  it('Munich with many amenities', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/bayern/muenchen/wohnung-mieten?balcony=1&elevator=1&parking=1&cellar=1'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('equipment=balcony%2Clift%2Cparking%2Ccellar'));  // elevator→lift
  });

  it('Munich with unmapped query params are excluded', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/bayern/muenchen/wohnung-mieten?unknown=foo&other=bar'
    );
    assert.equal(error, null);
    assert.ok(!fullUrl.includes('unknown='));
    assert.ok(!fullUrl.includes('other='));
  });
});

describe('translateUrl — additional realestate types', () => {
  it('grundstueck-kaufen (plot buy)', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/brandenburg/potsdam/grundstueck-kaufen'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('realestatetype=plotbuy'));
  });

  it('wohnung-mieten-tausch (swap apartments)', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten-tausch'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('realestatetype=apartmentrent'));
  });

  it('swap apartment URL does NOT add exclusioncriteria=swapFlat', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten-tausch'
    );
    assert.equal(error, null);
    assert.ok(!fullUrl.includes('exclusioncriteria=swapFlat'));
  });
});

describe('translateUrl — parameter mappings', () => {
  it('flags has-pictures as mobile-unsupported (removed from DIRECT_PARAM_MAP)', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?has-pictures=1'
    );
    assert.ok(!fullUrl.includes('hasPictures'));  // mobile API rejects, filtered
    assert.ok(!fullUrl.includes('has-pictures'));
  });

  it('flags ageofconstruction as mobile-unsupported (removed from DIRECT_PARAM_MAP)', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?ageofconstruction=3'
    );
    assert.ok(!fullUrl.includes('ageOfConstruction=3'));  // mobile API rejects, filtered
  });

  it('translates barrier-free=1 → equipment=handicappedaccessible', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?barrier-free=1'
    );
    assert.ok(fullUrl.includes('equipment=handicappedaccessible'));  // auto-translated
  });

  it('maps parking via equipment param', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?parking=1'
    );
    assert.ok(fullUrl.includes('equipment=parking'));
  });

  it('translates pets-allowed=1 → petsallowedtypes=yes', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?pets-allowed=1'
    );
    assert.ok(fullUrl.includes('petsallowedtypes=yes'));  // auto-translated: 1→yes
  });

  it('translates energy-efficiency=A+ → energyefficiencyclasses=a_plus', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?energy-efficiency=A%2B'
    );
    assert.ok(fullUrl.includes('energyefficiencyclasses=a_plus'));  // auto-translated A+→a_plus
  });

  it('maps guest-toilet and built-in-kitchen → equipment', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?built-in-kitchen=1&guest-toilet=1'
    );
    assert.ok(fullUrl.includes('equipment=1'));
  });

  // ── Remaining DIRECT_PARAM_MAP entries ──────────────────────────────────

  it('maps floor → floor', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?floor=1-'
    );
    assert.ok(fullUrl.includes('floor=1-'));
  });

  it('maps apartmenttypes → apartmenttypes', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?apartmenttypes=groundfloor'
    );
    assert.ok(fullUrl.includes('apartmenttypes=groundfloor'));
  });

  it('maps haspromotion → haspromotion', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?haspromotion=true'
    );
    assert.ok(fullUrl.includes('haspromotion=true'));
  });

  it('maps newbuilding → newbuilding=true (also sets canonical flag)', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?newbuilding=true'
    );
    assert.ok(fullUrl.includes('newbuilding=true'));
  });

  it('maps fulltext → fulltext', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?fulltext=Altbau'
    );
    assert.ok(fullUrl.includes('fulltext=Altbau'));
  });

  it('maps constructionyear → constructionyear', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?constructionyear=2000-'
    );
    assert.ok(fullUrl.includes('constructionyear=2000-'));
  });

  it('maps osmtags → osmtags', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?osmtags=park'
    );
    assert.ok(fullUrl.includes('osmtags=park'));
  });

  it('maps minimuminternetspeed → minimuminternetspeed', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?minimuminternetspeed=100000'
    );
    assert.ok(fullUrl.includes('minimuminternetspeed=100000'));
  });

  it('maps exclusiveonis24 → exclusiveonis24', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?exclusiveonis24=true'
    );
    assert.ok(fullUrl.includes('exclusiveonis24=true'));
  });

  it('maps comingsoon → comingsoon', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?comingsoon=true'
    );
    assert.ok(fullUrl.includes('comingsoon=true'));
  });

  it('maps paywall → paywall', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?paywall=true'
    );
    assert.ok(fullUrl.includes('paywall=true'));
  });

  it('maps buildingtypes → buildingtypes (houserent)', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/haus-mieten?buildingtypes=singlefamilyhouse'
    );
    assert.ok(fullUrl.includes('buildingtypes=singlefamilyhouse'));
  });

  it('maps ground → ground (houserent)', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/haus-mieten?ground=100-'
    );
    assert.ok(fullUrl.includes('ground=100-'));
  });
});

// ── Equipment checkboxes (every single one) ─────────────────────────────

describe('translateUrl — equipment checkboxes (all 17)', () => {
  // Direct equipment checkboxes (route into equipment= param)
  it('routes balcony=1 → equipment=balcony', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?balcony=1'
    );
    assert.ok(fullUrl.includes('equipment=balcony'));
  });

  it('routes garden=1 → equipment=garden', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?garden=1'
    );
    assert.ok(fullUrl.includes('equipment=garden'));
  });

  it('routes parking=1 → equipment=parking', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?parking=1'
    );
    assert.ok(fullUrl.includes('equipment=parking'));
  });

  it('routes cellar=1 → equipment=cellar', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?cellar=1'
    );
    assert.ok(fullUrl.includes('equipment=cellar'));
  });

  it('routes elevator=1 → equipment=lift', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?elevator=1'
    );
    assert.ok(fullUrl.includes('equipment=lift'));
  });

  // "onlywith" prefixed checkboxes
  it('routes onlywithbalcony=1 → equipment=balcony', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?onlywithbalcony=1'
    );
    assert.ok(fullUrl.includes('equipment=balcony'));
  });

  it('routes onlywithgarden=1 → equipment=garden', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?onlywithgarden=1'
    );
    assert.ok(fullUrl.includes('equipment=garden'));
  });

  it('routes onlywithparking=1 → equipment=parking', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?onlywithparking=1'
    );
    assert.ok(fullUrl.includes('equipment=parking'));
  });

  it('routes onlywithkitchen=1 → equipment=builtinKitchen', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?onlywithkitchen=1'
    );
    assert.ok(fullUrl.includes('equipment=builtinKitchen'));
  });

  it('routes onlywithelevator=1 → equipment=lift', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?onlywithelevator=1'
    );
    assert.ok(fullUrl.includes('equipment=lift'));
  });

  it('routes onlywithguesttoilet=1 → equipment=guesttoilet', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?onlywithguesttoilet=1'
    );
    assert.ok(fullUrl.includes('equipment=guesttoilet'));
  });

  it('routes onlywithbasement=1 → equipment=cellar', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?onlywithbasement=1'
    );
    assert.ok(fullUrl.includes('equipment=cellar'));
  });

  it('routes onlywithbarrierfree=1 → equipment=handicappedaccessible', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?onlywithbarrierfree=1'
    );
    assert.ok(fullUrl.includes('equipment=handicappedaccessible'));
  });

  it('routes onlywithinternet=1 → equipment=internet (filtered: mobile-ignored)', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?onlywithinternet=1'
    );
    assert.ok(!fullUrl.includes('equipment=internet'));  // filtered: mobile-ignored
  });

  it('routes onlywithfridge=1 → equipment=fridge (filtered: mobile-ignored)', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?onlywithfridge=1'
    );
    assert.ok(!fullUrl.includes('equipment=fridge'));  // filtered: mobile-ignored
  });

  it('routes onlywithcooker=1 → equipment=cooker (filtered: mobile-ignored)', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?onlywithcooker=1'
    );
    assert.ok(!fullUrl.includes('equipment=cooker'));  // filtered: mobile-ignored
  });

  it('combines multiple equipment checkboxes into single equipment param', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?balcony=1&parking=1&cellar=1'
    );
    const params = new URL(fullUrl).searchParams;
    const eq = params.get('equipment') || '';
    const vals = eq.split(',');
    assert.ok(vals.includes('balcony'));
    assert.ok(vals.includes('parking'));
    assert.ok(vals.includes('cellar'));
    // Single equipment param, not multiple
    assert.equal(params.getAll('equipment').length, 1);
  });
});

// ── Mobile-unsupported web filters (all flagged, none in mobile URL) ─────

describe('translateUrl — mobile-unsupported web filters', () => {
  const UNSUPPORTED = [
    ['gender', 'male'],
    ['smokingallowed', 'allowed'],
    ['startrentaldate', '2027-01-01'],
    ['furniture', 'true'],
    ['rentalduration', '3'],
    ['wohnberechtigungsscheinneeded', 'true'],
    ['onlyshorttermbuildable', 'true'],
    ['onlywithplanningpermission', 'true'],
    ['onlywithoutcourtage', 'true'],
    ['sitedevelopmenttypes', 'fullydeveloped'],
    ['siteconstructibletypes', 'residential'],
    ['rentalperiodvalue', '12'],
    ['rentalperiodtype', 'months'],
    ['beginrent', '2027-01-01'],
    ['shorttermaccommodationtype', 'apartment'],
    ['numberofpersons', '2'],
    ['withfurniture', 'true'],
    ['smokingpermitted', 'true'],
    ['flatsharesize', '3'],
    ['rentdurationinmonths', '6'],
    ['furnishing', 'full'],
    ['flatmategender', 'any'],
    ['garagetypes', 'singlegarage'],
    ['onlywithcookingpossibility', 'true'],
    ['onlywithambulantnursingservice', 'true'],
    ['assistedlivingcommercializationtype', 'rent'],
    ['onlywithcareofdementiapatients', 'true'],
    ['onlywithcareofartificalrespirationpatients', 'true'],
    ['onlywithcareofvegetativestatepatients', 'true'],
    ['caretypes', 'fulltime'],
    ['seniorcarelevels', '1'],
    ['roomtypes', 'single'],
  ];

  for (const [key, value] of UNSUPPORTED) {
    it(`flags ${key} as mobile-rejected (safeIgnored, not in mobile URL)`, () => {
      const { fullUrl, error } = translateUrl(
        `https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?${key}=${encodeURIComponent(value)}`
      );
      assert.equal(error, null);
      assert.ok(!fullUrl.includes(`${key}=`) && !fullUrl.includes(`${encodeURIComponent(key)}=`),
        `mobile URL should not contain ${key}`);
    });
  }

  // Removed DIRECT_PARAM_MAP entries — also mobile-unsupported
  it('flags has-pictures as mobile-unsupported', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?has-pictures=1'
    );
    assert.ok(!fullUrl.includes('hasPictures'));
  });

  it('flags ageofconstruction as mobile-unsupported', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?ageofconstruction=3'
    );
    assert.ok(!fullUrl.includes('ageOfConstruction'));
  });
});

// ── Safe-ignored tracking/sorting params ────────────────────────────────

describe('translateUrl — safe-ignored tracking params', () => {
  it('strips enteredFrom', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?enteredFrom=result_list'
    );
    assert.ok(!fullUrl.includes('enteredFrom'));
  });

  it('strips utm_source', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?utm_source=google'
    );
    assert.ok(!fullUrl.includes('utm_source'));
  });

  it('strips utm_medium', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?utm_medium=cpc'
    );
    assert.ok(!fullUrl.includes('utm_medium'));
  });

  it('strips sorting param', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?sorting=price_asc'
    );
    assert.ok(!fullUrl.includes('sorting=price_asc'));
  });

  it('strips pagenumber param', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?pagenumber=5'
    );
    assert.ok(!fullUrl.includes('pagenumber=5'));
  });

  it('strips pagesize param', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?pagesize=50'
    );
    assert.ok(!fullUrl.includes('pagesize=50'));
  });

  it('strips viewmode param', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?viewmode=list'
    );
    assert.ok(!fullUrl.includes('viewmode'));
  });

  it('strips from param (tracking referrer)', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?from=homepage'
    );
    assert.ok(!fullUrl.includes('from=homepage'));
  });
});

// ---------------------------------------------------------------------------
// translateUrl — edge cases
// ---------------------------------------------------------------------------

describe('translateUrl — edge cases', () => {
  it('handles case-insensitive Suche', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('geocodes=%2Fde%2Fberlin%2Fberlin'));
  });

  it('handles mixed-case Suche', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/SuChE/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('geocodes=%2Fde%2Fberlin%2Fberlin'));
  });

  it('handles radius search type', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/radius/berlin/wohnung-mieten?geocoordinates=52.52;13.405;5.0'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('searchType=radius'));
    assert.ok(fullUrl.includes('geocoordinates='));
  });

  it('rejects shape search type — the mobile API cannot run map-drawn polygons', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/shape/berlin/wohnung-mieten'
    );
    assert.match(error, /shape/i);
    assert.equal(fullUrl, '');
  });

  it('encodes special characters in path segments', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin-mitte/wohnung-mieten'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('berlin-mitte'));
  });
});

// ---------------------------------------------------------------------------
// Radius searches — IS24 puts the circle in the query string, not the path
// ---------------------------------------------------------------------------

const RADIUS_URL = 'https://www.immobilienscout24.de/Suche/radius/wohnung-mieten'
  + '?centerofsearchaddress=Hamburg;Altona&geocoordinates=53.55073;9.93549;1.0&enteredFrom=result_list';

describe('parseSearchUrl — radius searches', () => {
  it('parses the circle out of the query string', () => {
    const { canonical, unsupportedParams, error } = parseSearchUrl(RADIUS_URL);
    assert.equal(error, null);
    assert.deepEqual(unsupportedParams, []);
    assert.equal(canonical.searchType, 'radius');
    assert.deepEqual(canonical.location.center, { lat: 53.55073, lon: 9.93549, radiusKm: 1 });
  });

  it('labels the search by its centre instead of All Germany', () => {
    const { canonical } = parseSearchUrl(RADIUS_URL);
    assert.equal(canonical.location.label, 'Hamburg, Altona');
  });

  it('falls back to coordinates when centerofsearchaddress is absent', () => {
    const { canonical } = parseSearchUrl(
      'https://www.immobilienscout24.de/Suche/radius/wohnung-mieten?geocoordinates=53.55073;9.93549;1.0'
    );
    assert.equal(canonical.location.label, '53.551, 9.935');
  });

  it('treats coordinates without a /radius/ path segment as a radius search', () => {
    const { canonical } = parseSearchUrl(
      'https://www.immobilienscout24.de/Suche/wohnung-mieten?geocoordinates=53.55073;9.93549;2.5'
    );
    assert.equal(canonical.searchType, 'radius');
    assert.equal(canonical.location.center.radiusKm, 2.5);
  });

  it('keeps location.center null for ordinary region searches', () => {
    const { canonical } = parseSearchUrl(
      'https://www.immobilienscout24.de/Suche/de/hamburg/hamburg/altona/wohnung-mieten'
    );
    assert.equal(canonical.location.center, null);
    assert.equal(canonical.searchType, 'region');
  });

  it('blocks malformed coordinates instead of guessing a location', () => {
    const malformed = [
      '53.55073;9.93549',      // radius missing
      '53.55073;9.93549;0',    // zero radius
      '53.55073;9.93549;-1',   // negative radius
      'a;b;c',                 // non-numeric
      '95.0;9.93549;1.0',      // latitude out of range
      '53.55073;200.0;1.0',    // longitude out of range
      '53.55073;;1.0',         // empty component
    ];
    for (const bad of malformed) {
      const result = validateSearchUrl(
        `https://www.immobilienscout24.de/Suche/radius/wohnung-mieten?geocoordinates=${bad}`
      );
      assert.equal(result.ok, false, `expected "${bad}" to be rejected`);
    }
  });
});

describe('buildMobileApiUrl — radius searches', () => {
  it('sends geocoordinates and searchType=radius', () => {
    const { fullUrl, error } = translateUrl(RADIUS_URL);
    assert.equal(error, null);
    const params = new URL(fullUrl).searchParams;
    assert.equal(params.get('searchType'), 'radius');
    assert.equal(params.get('geocoordinates'), '53.55073;9.93549;1');
  });

  it('omits geocodes so the requested circle is unambiguous', () => {
    const { fullUrl } = translateUrl(RADIUS_URL);
    assert.equal(new URL(fullUrl).searchParams.has('geocodes'), false);
  });

  it('never forwards centerofsearchaddress to the mobile API', () => {
    const { fullUrl } = translateUrl(RADIUS_URL);
    assert.equal(new URL(fullUrl).searchParams.has('centerofsearchaddress'), false);
  });

  it('leaves region searches untouched', () => {
    const { fullUrl } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/hamburg/hamburg/altona/wohnung-mieten'
    );
    const params = new URL(fullUrl).searchParams;
    assert.equal(params.get('geocodes'), '/de/hamburg/hamburg/altona');
    assert.equal(params.get('searchType'), 'region');
    assert.equal(params.has('geocoordinates'), false);
  });
});

describe('validateSearchUrl — links the mobile API cannot run', () => {
  it('blocks a radius link that carries no coordinates', () => {
    const result = validateSearchUrl(
      'https://www.immobilienscout24.de/Suche/radius/berlin/wohnung-mieten'
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /coordinates/i);
  });

  it('does not quietly downgrade a coordinate-less radius link to a city search', () => {
    const result = validateSearchUrl(
      'https://www.immobilienscout24.de/Suche/radius/berlin/wohnung-mieten'
    );
    assert.equal(result.mobileUrl, '');
  });

  it('blocks map-drawn shape links', () => {
    const result = validateSearchUrl(
      'https://www.immobilienscout24.de/Suche/shape/berlin/wohnung-mieten'
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /shape/i);
  });
});

describe('validateSearchUrl — radius preview', () => {
  it('shows centre and radius in English', () => {
    const result = validateSearchUrl(RADIUS_URL);
    assert.equal(result.ok, true);
    assert.equal(result.preview.location, 'Hamburg, Altona · 1 km radius');
  });

  it('shows centre and radius in German', () => {
    const result = validateSearchUrl(RADIUS_URL, { locale: 'de' });
    assert.equal(result.preview.location, 'Hamburg, Altona · 1 km Umkreis');
  });

  it('never reports a radius search as nationwide', () => {
    const en = validateSearchUrl(RADIUS_URL);
    const de = validateSearchUrl(RADIUS_URL, { locale: 'de' });
    assert.equal(en.preview.location.includes('All Germany'), false);
    assert.equal(de.preview.location.includes('Deutschlandweit'), false);
  });

  it('renders a fractional radius without trailing zeroes', () => {
    const result = validateSearchUrl(
      'https://www.immobilienscout24.de/Suche/radius/wohnung-mieten?geocoordinates=53.55073;9.93549;2.50'
    );
    assert.equal(result.preview.location, '53.551, 9.935 · 2.5 km radius');
  });
});

// ---------------------------------------------------------------------------
// translateUrl — error cases
// ---------------------------------------------------------------------------

describe('translateUrl — error cases', () => {
  it('returns error for non-IS24 URL', () => {
    const { fullUrl, error } = translateUrl('https://example.com/page');
    assert.equal(fullUrl, '');
    assert.ok(error.includes('does not contain /Suche/'));
  });

  it('returns error for URL without Suche path', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/expose/12345'
    );
    assert.equal(fullUrl, '');
    assert.ok(error.includes('does not contain /Suche/'));
  });

  it('returns error for completely malformed URL', () => {
    const { fullUrl, error } = translateUrl('not-a-url');
    assert.equal(fullUrl, '');
    assert.ok(error.length > 0); // URL constructor throws
  });

  it('returns error for empty string', () => {
    const { fullUrl, error } = translateUrl('');
    assert.equal(fullUrl, '');
    assert.ok(error.length > 0);
  });

  it('handles URL with Suche but no realestate type (uses defaults)', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin'
    );
    assert.equal(error, null);
    assert.ok(fullUrl.includes('realestatetype=apartmentrent')); // default
  });

  it('handles Suche-only URL (empty afterSuche)', () => {
    const { fullUrl, error } = translateUrl(
      'https://www.immobilienscout24.de/Suche'
    );
    assert.equal(error, null);
    // Still produces a URL with defaults
    assert.ok(fullUrl.startsWith('https://api.mobile.immobilienscout24.de/search/list?'));
  });
});

// ---------------------------------------------------------------------------
// getTotalResults
// ---------------------------------------------------------------------------

describe('getTotalResults', () => {
  beforeEach(() => {
    // Reset fetch
    globalThis.fetch = originalFetch;
  });

  it('returns error for invalid URL (non-IS24)', async () => {
    const result = await getTotalResults('https://example.com');
    assert.equal(result.total, 0);
    assert.ok(result.error.includes('does not contain /Suche/'));
  });

  it('constructs the correct total URL from a search URL', async () => {
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return mockResponse({ totalResults: 42 });
    };

    const result = await getTotalResults(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(result.total, 42);
    assert.equal(result.error, null);
    // Verify it hits /search/total (not /search/list)
    assert.ok(capturedUrl.includes('/search/total?'));
    // Verify pagination/sorting params are stripped
    assert.ok(!capturedUrl.includes('pagenumber='));
    assert.ok(!capturedUrl.includes('pagesize='));
    assert.ok(!capturedUrl.includes('sorting='));
  });

  it('returns total from numberOfHits when totalResults missing', async () => {
    globalThis.fetch = async () => mockResponse({ numberOfHits: 99 });
    const result = await getTotalResults(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(result.total, 99);
  });

  it('returns total from "total" field when others missing', async () => {
    globalThis.fetch = async () => mockResponse({ total: 7 });
    const result = await getTotalResults(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(result.total, 7);
  });

  it('returns 0 when response has no count fields', async () => {
    globalThis.fetch = async () => mockResponse({ foo: 'bar' });
    const result = await getTotalResults(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(result.total, 0);
  });

  it('returns error on HTTP failure', async () => {
    globalThis.fetch = async () => mockResponse({}, 500, false);
    const result = await getTotalResults(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(result.total, 0);
    assert.equal(result.error, 'HTTP 500');
  });

  it('returns error on network failure', async () => {
    globalThis.fetch = async () => { throw new Error('Network error'); };
    const result = await getTotalResults(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(result.total, 0);
    assert.equal(result.error, 'Network error');
  });
});

// ---------------------------------------------------------------------------
// fetchListings
// ---------------------------------------------------------------------------

describe('fetchListings', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns error for invalid URL', async () => {
    const result = await fetchListings('https://example.com');
    assert.deepEqual(result.listings, []);
    assert.ok(result.error.includes('does not contain /Suche/'));
  });

  it('fetches and transforms listings from the mobile API', async () => {
    globalThis.fetch = async (url) => {
      return mockResponse({
        resultListItems: [
          {
            item: {
              id: '142345678',
              title: 'Schöne 3-Zimmer Wohnung',
              attributes: [
                { attribute: 'totalRent', value: '950' },
                { attribute: 'livingSpace', value: '78.5' },
                { attribute: 'numberOfRooms', value: '3' },
              ],
              address: { line: 'Musterstraße 1, 10115 Berlin' },
              titlePicture: {
                full: 'https://pictures.is24.de/abc123_full.jpg',
                preview: 'https://pictures.is24.de/abc123_preview.jpg',
              },
            },
          },
        ],
      });
    };

    const { listings, error } = await fetchListings(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(error, null);
    assert.equal(listings.length, 1);

    const l = listings[0];
    assert.equal(l.expose_id, '142345678');
    assert.equal(l.title, 'Schöne 3-Zimmer Wohnung');
    assert.equal(l.price, 950);
    assert.equal(l.size, 78.5);
    assert.equal(l.rooms, 3);
    assert.equal(l.address, 'Musterstraße 1, 10115 Berlin');
    assert.equal(l.image_url, 'https://pictures.is24.de/abc123_full.jpg');
  });

  it('falls back to exposeId when id is missing', async () => {
    globalThis.fetch = async () => mockResponse({
      resultListItems: [
        {
          item: {
            exposeId: '98765',
            title: 'Fallback ID',
            attributes: [],
            address: '',
            titlePicture: null,
          },
        },
      ],
    });

    const { listings, error } = await fetchListings(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(error, null);
    assert.equal(listings[0].expose_id, '98765');
  });

  it('handles missing optional fields gracefully', async () => {
    globalThis.fetch = async () => mockResponse({
      resultListItems: [
        {
          item: {
            id: '1',
            title: '',
            attributes: [],
            address: '',
          },
        },
      ],
    });

    const { listings, error } = await fetchListings(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(error, null);
    assert.equal(listings[0].expose_id, '1');
    assert.equal(listings[0].title, '');
    assert.equal(listings[0].price, 0);
    assert.equal(listings[0].size, 0);
    assert.equal(listings[0].rooms, 0);
    assert.equal(listings[0].address, '');
    assert.equal(listings[0].image_url, '');
  });

  it('uses preview image when full is missing', async () => {
    globalThis.fetch = async () => mockResponse({
      resultListItems: [
        {
          item: {
            id: '1',
            title: 'Preview image',
            attributes: [],
            address: '',
            titlePicture: { preview: 'https://pictures.is24.de/preview.jpg' },
          },
        },
      ],
    });

    const { listings, error } = await fetchListings(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(error, null);
    assert.equal(listings[0].image_url, 'https://pictures.is24.de/preview.jpg');
  });

  it('handles flat item structure (no nested item)', async () => {
    globalThis.fetch = async () => mockResponse({
      resultListItems: [
        {
          id: 'flat123',
          title: 'Flat Structure',
          attributes: [
            { attribute: 'purchasePrice', value: '250000' },
            { attribute: 'livingSpace', value: '100' },
            { attribute: 'numberOfRooms', value: '4' },
          ],
          address: 'Flat Address',
        },
      ],
    });

    const { listings, error } = await fetchListings(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-kaufen'
    );
    assert.equal(error, null);
    assert.equal(listings[0].expose_id, 'flat123');
    assert.equal(listings[0].price, 250000);
    assert.equal(listings[0].size, 100);
    assert.equal(listings[0].rooms, 4);
  });

  it('returns empty listings for empty resultListItems', async () => {
    globalThis.fetch = async () => mockResponse({ resultListItems: [] });
    const { listings, error } = await fetchListings(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.deepEqual(listings, []);
    assert.equal(error, null);
  });

  it('returns empty listings when resultListItems is missing', async () => {
    globalThis.fetch = async () => mockResponse({ otherField: true });
    const { listings, error } = await fetchListings(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.deepEqual(listings, []);
    assert.equal(error, null);
  });

  it('respects page parameter', async () => {
    let capturedUrl;
    globalThis.fetch = async (url, init) => {
      capturedUrl = url;
      return mockResponse({ resultListItems: [] });
    };

    await fetchListings(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten',
      3
    );
    assert.ok(capturedUrl.includes('pagenumber=3'));
  });

  it('returns error on HTTP failure', async () => {
    globalThis.fetch = async () => mockResponse({}, 429, false);
    const result = await fetchListings(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.deepEqual(result.listings, []);
    assert.equal(result.error, 'HTTP 429');
  });

  it('returns error on network failure', async () => {
    globalThis.fetch = async () => { throw new Error('Connection refused'); };
    const result = await fetchListings(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.deepEqual(result.listings, []);
    assert.equal(result.error, 'Connection refused');
  });

  it('skips attributes with missing attribute/value keys', async () => {
    globalThis.fetch = async () => mockResponse({
      resultListItems: [
        {
          item: {
            id: '1',
            title: 'Broken attrs',
            attributes: [
              { attribute: 'totalRent', value: '500' },
              {},                                                    // missing both
              { attribute: 'rooms' },                                 // missing value
              { value: '2' },                                         // missing attribute
              { attribute: 'livingSpace', value: '60' },
            ],
            address: '',
          },
        },
      ],
    });

    const { listings, error } = await fetchListings(
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten'
    );
    assert.equal(error, null);
    assert.equal(listings[0].price, 500);   // from totalRent
    assert.equal(listings[0].size, 60);     // from livingSpace
    assert.equal(listings[0].rooms, 0);     // 'rooms' attr had no value key
  });
});

// ---------------------------------------------------------------------------
// Optional live conformance checks (manual: IS24_LIVE_TESTS=1 node --test ...)
// ---------------------------------------------------------------------------

describe('IS24 live conformance (opt-in)', { skip: process.env.IS24_LIVE_TESTS !== '1' }, () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('golden Osnabrück URL returns a valid mobile API total with parsed filters intact', async () => {
    const url = 'https://www.immobilienscout24.de/Suche/de/niedersachsen/osnabrueck/neubauwohnung-mieten?heatingtypes=central,selfcontainedcentral&numberofrooms=-5.0&price=500.0-&livingspace=30.0-&equipment=handicappedaccessible&pricetype=rentpermonth&enteredFrom=result_list';
    const result = await getTotalResults(url);
    assert.equal(result.error, null);
    assert.equal(typeof result.total, 'number');
    assert.ok(result.validation.ok);
    assert.equal(result.validation.unsupportedParams.length, 0);
  });

  it('WG Munich URL reaches live mobile API after dropping only rejected web-only filters', async () => {
    const url = 'https://www.immobilienscout24.de/Suche/de/bayern/muenchen/4er-wg?gender=male&livingspace=-100.0&energyefficiencyclasses=a,b,a_plus&equipment=fridge,cooker,petsallowed,internet&smokingallowed=allowed&petsallowedtypes=no,yes,negotiable&startrentaldate=2027-05-22&furniture=true&price=1.0-&rentalduration=3&enteredFrom=result_list';
    const result = await getTotalResults(url);
    assert.equal(result.error, null);
    assert.equal(typeof result.total, 'number');
    assert.ok(result.validation.ok);
    assert.equal(result.validation.unsupportedParams.length, 0);
    assert.equal(result.validation.canonical.fullText, '4er wg');
  });

  it('stricter max price does not increase total in the same geo/type', async () => {
    const loose = await getTotalResults('https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?price=-1500.0');
    const strict = await getTotalResults('https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?price=-900.0');
    assert.equal(loose.error, null);
    assert.equal(strict.error, null);
    assert.ok(strict.total <= loose.total, `expected ${strict.total} <= ${loose.total}`);
  });

  it('returned listings obey numeric max-room constraint when attributes are available', async () => {
    const result = await fetchListings('https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten?numberofrooms=-2.0', 1);
    assert.equal(result.error, null);
    for (const listing of result.listings.filter(l => Number.isFinite(l.rooms) && l.rooms > 0).slice(0, 10)) {
      assert.ok(listing.rooms <= 2, `${listing.expose_id} has ${listing.rooms} rooms`);
    }
  });
});

// ---------------------------------------------------------------------------
// MOBILE_API_BASE constant (implicitly tested via all translations)
// ---------------------------------------------------------------------------

describe('mobile API base URL', () => {
  it('all successful translations point to the mobile API', () => {
    const urls = [
      'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten',
      'https://www.immobilienscout24.de/Suche/de/hamburg/hamburg/wohnung-mieten',
      'https://www.immobilienscout24.de/Suche/de/bayern/muenchen/wohnung-mieten',
    ];
    for (const url of urls) {
      const { fullUrl, error } = translateUrl(url);
      assert.equal(error, null);
      assert.ok(
        fullUrl.startsWith('https://api.mobile.immobilienscout24.de/search/list?'),
        `Expected mobile API base for: ${url}`
      );
    }
  });
});
