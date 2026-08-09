/** Derive a human-readable name from an IS24 search URL. */
export function deriveSearchName(url) {
  try {
    // Add https:// if missing — new URL() requires absolute URL
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const u = new URL(url);
    if (!u.hostname.includes('immobilienscout24')) return '';
    const parts = u.pathname.split('/').filter(Boolean);
    // Path: /Suche/de/{state?}/{city}/{type}
    const sucheIdx = parts.findIndex(p => p.toLowerCase() === 'suche');
    if (sucheIdx < 0) return '';
    // The type is the last segment (ends with -mieten, -kaufen, etc.)
    const rawType = parts[parts.length - 1] || '';
    // City is the segment before the type. /Suche/radius/… and /Suche/shape/…
    // put a search-mode keyword there instead, so fall back to the
    // human-readable centre from the query.
    let city = parts[parts.length - 2] || '';
    if (city.toLowerCase() === 'radius' || city.toLowerCase() === 'shape') {
      city = (u.searchParams.get('centerofsearchaddress') || '')
        .split(/[;,]/)
        .map(s => s.trim())
        .filter(Boolean)
        .join(', ');
    }
    const cityName = city.charAt(0).toUpperCase() + city.slice(1).replace(/-/g, ' ');
    const typeName = rawType.replace(/-/g, ' ').replace(/mieten/, 'zur Miete').replace(/kaufen/, 'zum Kauf');
    if (!cityName && !typeName) return '';
    if (!typeName) return cityName;
    if (!cityName) return typeName;
    return `${cityName} · ${typeName}`;
  } catch {
    return '';
  }
}

/** Compact validation error for the visible dialog; raw details stay in preview metadata. */
export function compactValidationError(validation, fallback, t) {
  const unsupported = validation?.unsupportedParams || [];
  if (unsupported.length) {
    const names = [...new Set(unsupported.map(p => p.key))];
    const shown = names.slice(0, 4).join(', ');
    const more = names.length > 4 ? ` +${names.length - 4}` : '';
    return `${t('search.unsupportedFilters', 'Unsupported filters')}: ${shown}${more}`;
  }
  return fallback;
}

export function visibleIgnoredParams(validation) {
  return (validation?.safeIgnoredParams || []).filter(p => p.reason);
}
