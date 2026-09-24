import { leadTimeFor } from '../warehouses.js';

/**
 * Pure allocation planning — no I/O, so it is trivially unit-testable and safe to call inside a
 * database transaction.
 *
 * Order of preference:
 *   1. The primary warehouse for the pincode, if it can ship the whole quantity  -> express.
 *   2. The first fallback warehouse (by distance) that can ship the whole quantity.
 *   3. A split shipment across warehouses in the same distance order.
 *   4. Otherwise insufficient: allocate nothing (for availability) / the partial amount (for orders).
 *
 * One parcel from one warehouse beats a split even if the split includes the primary: customers
 * receive one delivery and we pay one shipping label.
 */
export function planAllocation(route, ledger, quantity, { tracked = true } = {}) {
  if (!tracked) {
    return { status: 'single', parts: [{ warehouse: route.primary, quantity }], shortfall: 0 };
  }
  const single = route.order.find((code) => (ledger[code] ?? 0) >= quantity);
  if (single) return { status: 'single', parts: [{ warehouse: single, quantity }], shortfall: 0 };

  const parts = [];
  let left = quantity;
  for (const code of route.order) {
    const take = Math.min(left, Math.max(0, ledger[code] ?? 0));
    if (take > 0) { parts.push({ warehouse: code, quantity: take }); left -= take; }
    if (left === 0) break;
  }
  if (left === 0) return { status: 'split', parts, shortfall: 0 };
  return { status: 'insufficient', parts, shortfall: left };
}

/** Delivery estimate for a plan: the slowest parcel decides. */
export function estimateFor(route, parts) {
  const times = parts.map((p) => leadTimeFor(route, p.warehouse));
  return { min: Math.max(...times.map((t) => t.min)), max: Math.max(...times.map((t) => t.max)) };
}
