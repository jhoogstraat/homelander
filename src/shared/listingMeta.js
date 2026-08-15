// Formats price/size for listing cards. IS24 does not guarantee either
// field is present on every listing, so each piece renders independently.

function formatPrice(price) {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${n.toLocaleString('de-DE', { maximumFractionDigits: 0 })} €`;
}

function formatSize(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${n.toLocaleString('de-DE', { maximumFractionDigits: 1 })} m²`;
}

/** Returns a "650 € · 65 m²" style string, a single part, or null if both are missing. */
export function formatListingMeta(price, size) {
  const parts = [formatPrice(price), formatSize(size)].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}
