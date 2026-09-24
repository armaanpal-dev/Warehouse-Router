/** Accept either a numeric id ("123") or a GID ("gid://shopify/ProductVariant/123"); return the GID. */
export function toGid(type, id) {
  const s = String(id ?? '').trim();
  if (s.startsWith('gid://shopify/')) {
    if (!s.startsWith(`gid://shopify/${type}/`)) return null;
    return /\/\d+$/.test(s) ? s : null;
  }
  return /^\d{1,20}$/.test(s) ? `gid://shopify/${type}/${s}` : null;
}

export const numericId = (gid) => String(gid).split('/').pop();
