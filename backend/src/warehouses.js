/**
 * Warehouses and pincode routing.
 *
 * Indian pincodes encode geography in their leading digits (1 = Delhi/North, 4 = Maharashtra/West,
 * 5-6 = South, ...), so routing is a prefix table rather than a 19,000-row pincode list. Each region
 * has a primary warehouse plus a fallback order, ranked by road distance from that region.
 *
 * `metro` prefixes are the warehouse's own city: same-day/next-day. The rest of the primary region is
 * standard express; any fallback warehouse is a cross-region shipment.
 */

export const WAREHOUSES = {
  DEL: { code: 'DEL', name: 'Delhi Warehouse', city: 'New Delhi' },
  BLR: { code: 'BLR', name: 'Bengaluru Warehouse', city: 'Bengaluru' },
  BOM: { code: 'BOM', name: 'Mumbai Warehouse', city: 'Mumbai' },
};

/** Delivery estimates in days, by relationship between the shipping warehouse and the destination. */
export const LEAD_TIMES = {
  metro: { min: 1, max: 1 },
  primary: { min: 2, max: 3 },
  fallback: { min: 4, max: 6 },
};

// [first 2 digits from, to, region, primary + fallbacks in order]
const REGIONS = [
  [11, 11, 'Delhi NCR', ['DEL', 'BOM', 'BLR']],
  [12, 19, 'North', ['DEL', 'BOM', 'BLR']],          // Haryana, Punjab, Chandigarh, HP, J&K
  [20, 28, 'North', ['DEL', 'BOM', 'BLR']],          // Uttar Pradesh, Uttarakhand
  [30, 34, 'North-West', ['DEL', 'BOM', 'BLR']],     // Rajasthan
  [36, 39, 'West', ['BOM', 'DEL', 'BLR']],           // Gujarat
  [40, 44, 'West', ['BOM', 'BLR', 'DEL']],           // Maharashtra, Goa
  [45, 49, 'Central', ['BOM', 'DEL', 'BLR']],        // Madhya Pradesh, Chhattisgarh
  [50, 53, 'South', ['BLR', 'BOM', 'DEL']],          // Telangana, Andhra Pradesh
  [56, 59, 'South', ['BLR', 'BOM', 'DEL']],          // Karnataka
  [60, 64, 'South', ['BLR', 'BOM', 'DEL']],          // Tamil Nadu, Puducherry
  [67, 69, 'South', ['BLR', 'BOM', 'DEL']],          // Kerala, Lakshadweep
  [70, 74, 'East', ['DEL', 'BLR', 'BOM']],           // West Bengal, Andaman, Sikkim
  [75, 77, 'East', ['BLR', 'DEL', 'BOM']],           // Odisha
  [78, 79, 'North-East', ['DEL', 'BLR', 'BOM']],     // Assam and the North-East
  [80, 85, 'East', ['DEL', 'BLR', 'BOM']],           // Bihar, Jharkhand
];

// First 3 digits served same/next day by the warehouse in that city.
const METRO = { DEL: [[110, 110]], BLR: [[560, 562]], BOM: [[400, 401]] };

export const PINCODE_RE = /^[1-9]\d{5}$/;

/**
 * @returns {{ pincode, region, primary: string, order: string[], metro: boolean } | null}
 *   null when the pincode is well-formed but outside every delivery region (e.g. 9xxxxx Army Post Office).
 */
export function routeForPincode(pincode) {
  if (!PINCODE_RE.test(pincode)) return null;
  const p2 = Number(pincode.slice(0, 2));
  const p3 = Number(pincode.slice(0, 3));
  const hit = REGIONS.find(([from, to]) => p2 >= from && p2 <= to);
  if (!hit) return null;
  const [, , region, order] = hit;
  const primary = order[0];
  const metro = (METRO[primary] || []).some(([from, to]) => p3 >= from && p3 <= to);
  return { pincode, region, primary, order: [...order], metro };
}

/** Lead time for shipping to this route from `warehouseCode`. */
export function leadTimeFor(route, warehouseCode) {
  if (warehouseCode !== route.primary) return LEAD_TIMES.fallback;
  return route.metro ? LEAD_TIMES.metro : LEAD_TIMES.primary;
}
