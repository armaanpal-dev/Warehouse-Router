import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeForPincode, leadTimeFor } from '../src/warehouses.js';
import { planAllocation } from '../src/services/allocation.js';

test('pincodes map to the nearest warehouse with a distance-ordered fallback', () => {
  const cases = {
    '110001': ['DEL', true], '122001': ['DEL', false], '560001': ['BLR', true], '600001': ['BLR', false],
    '400001': ['BOM', true], '411001': ['BOM', false], '380001': ['BOM', false], '700001': ['DEL', false],
    '751001': ['BLR', false], '500001': ['BLR', false],
  };
  for (const [pin, [primary, metro]] of Object.entries(cases)) {
    const r = routeForPincode(pin);
    assert.equal(r.primary, primary, pin);
    assert.equal(r.metro, metro, pin);
    assert.equal(r.order.length, 3);
    assert.equal(new Set(r.order).size, 3);
  }
  assert.deepEqual(routeForPincode('560001').order, ['BLR', 'BOM', 'DEL']);
});

test('invalid or unserviceable pincodes return null', () => {
  for (const p of ['012345', '56000', '5600011', 'abcdef', '999999', '900001', '']) assert.equal(routeForPincode(p), null, p);
});

test('lead times: metro < primary region < fallback', () => {
  const r = routeForPincode('560001');
  assert.deepEqual(leadTimeFor(r, 'BLR'), { min: 1, max: 1 });
  assert.deepEqual(leadTimeFor(routeForPincode('600001'), 'BLR'), { min: 2, max: 3 });
  assert.deepEqual(leadTimeFor(r, 'BOM'), { min: 4, max: 6 });
});

test('planAllocation: primary, then single fallback, then split, then insufficient', () => {
  const route = routeForPincode('560001'); // BLR, BOM, DEL
  assert.deepEqual(planAllocation(route, { BLR: 3, BOM: 4, DEL: 5 }, 2).parts, [{ warehouse: 'BLR', quantity: 2 }]);
  assert.deepEqual(planAllocation(route, { BLR: 3, BOM: 4, DEL: 5 }, 4).parts, [{ warehouse: 'BOM', quantity: 4 }]);
  // A single fallback parcel is preferred over a split that includes the primary.
  assert.deepEqual(planAllocation(route, { BLR: 1, BOM: 0, DEL: 5 }, 3).parts, [{ warehouse: 'DEL', quantity: 3 }]);
  const split = planAllocation(route, { BLR: 2, BOM: 2, DEL: 2 }, 5);
  assert.equal(split.status, 'split');
  assert.deepEqual(split.parts, [{ warehouse: 'BLR', quantity: 2 }, { warehouse: 'BOM', quantity: 2 }, { warehouse: 'DEL', quantity: 1 }]);
  const none = planAllocation(route, { BLR: 1, BOM: 0, DEL: 1 }, 3);
  assert.equal(none.status, 'insufficient');
  assert.equal(none.shortfall, 1);
  // Negative ledger values (never expected) are treated as zero, not as negative capacity.
  assert.equal(planAllocation(route, { BLR: -2, BOM: 0, DEL: 0 }, 1).status, 'insufficient');
  // Untracked inventory always ships from the primary.
  assert.deepEqual(planAllocation(route, {}, 50, { tracked: false }).parts, [{ warehouse: 'BLR', quantity: 50 }]);
});
