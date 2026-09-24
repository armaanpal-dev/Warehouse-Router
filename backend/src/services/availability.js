import { badRequest, notFound, unprocessable } from '../errors.js';
import { PINCODE_RE, WAREHOUSES, routeForPincode } from '../warehouses.js';
import { toGid, numericId } from '../shopify/ids.js';
import { planAllocation, estimateFor } from './allocation.js';

const MAX_QTY = 100;

export function validateAvailabilityRequest(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return { errors: [{ field: 'body', message: 'JSON object required' }] };
  const variantGid = toGid('ProductVariant', body.variant_id);
  if (!variantGid) errors.push({ field: 'variant_id', message: 'must be a numeric variant id or a ProductVariant GID' });
  const quantity = body.quantity === undefined ? 1 : body.quantity;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) errors.push({ field: 'quantity', message: `must be an integer from 1 to ${MAX_QTY}` });
  const pincode = String(body.pincode ?? '').replace(/\s+/g, '');
  if (!PINCODE_RE.test(pincode)) errors.push({ field: 'pincode', message: 'must be a 6-digit Indian pincode' });
  return { errors, variantGid, quantity, pincode };
}

/**
 * Read-only: answers "can this pincode get this quantity, and how fast?" without reserving anything.
 * Reservation happens when the order is created (orders/create webhook), atomically.
 */
export function createAvailabilityService({ inventory }) {
  return async function checkAvailability(body) {
    const { errors, variantGid, quantity, pincode } = validateAvailabilityRequest(body);
    if (errors.length) throw badRequest('Invalid request', errors);

    const route = routeForPincode(pincode);
    if (!route) throw unprocessable('PINCODE_NOT_SERVICEABLE', `We don't deliver to ${pincode} yet.`, { pincode });

    const variant = await inventory.getVariant(variantGid);
    if (!variant) throw notFound('VARIANT_NOT_FOUND', `Variant ${numericId(variantGid)} does not exist.`);

    const ledger = variant.tracked ? inventory.ledger(variant.inventoryItemId) : null;
    const plan = planAllocation(route, ledger || {}, quantity, { tracked: variant.tracked });
    const totalAvailable = ledger ? Object.values(ledger).reduce((a, b) => a + Math.max(0, b), 0) : null;

    const base = {
      variant_id: numericId(variantGid),
      sku: variant.sku,
      quantity,
      pincode,
      region: route.region,
      primary_warehouse: WAREHOUSES[route.primary].code,
      inventory_source: variant.source, // 'live' or 'cache' (Shopify unreachable, ledger served)
      checked_at: new Date().toISOString(),
    };

    if (plan.status === 'insufficient') {
      return {
        ...base,
        available: false,
        express: false,
        reason: totalAvailable === 0 ? 'OUT_OF_STOCK' : 'INSUFFICIENT_STOCK',
        max_available_quantity: totalAvailable,
        message: totalAvailable === 0
          ? 'This item is out of stock.'
          : `Only ${totalAvailable} available for delivery to ${pincode}.`,
      };
    }

    const isPrimary = plan.status === 'single' && plan.parts[0].warehouse === route.primary;
    const eta = estimateFor(route, plan.parts);
    return {
      ...base,
      available: true,
      express: isPrimary,
      fulfillment: {
        type: plan.status, // 'single' | 'split'
        warehouse: plan.status === 'single' ? pick(plan.parts[0].warehouse) : null,
        is_primary_warehouse: isPrimary,
        fallback_used: !isPrimary,
        allocations: plan.parts.map((p) => ({ warehouse: p.warehouse, quantity: p.quantity })),
        estimated_delivery_days: eta,
      },
      message: isPrimary
        ? `Express delivery in ${eta.min === eta.max ? eta.min : `${eta.min}-${eta.max}`} day${eta.max > 1 ? 's' : ''} from ${WAREHOUSES[route.primary].name}.`
        : `Ships from ${plan.parts.map((p) => WAREHOUSES[p.warehouse].name).join(' + ')}; delivery in ${eta.min}-${eta.max} days.`,
    };
  };
}

const pick = (code) => ({ code, name: WAREHOUSES[code].name, city: WAREHOUSES[code].city });
