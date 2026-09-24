import { ShopifyError } from '../errors.js';

/**
 * Domain-level Shopify operations the app needs, over any GraphQL `request` function.
 * The mock (shopify/mock.js) implements this same interface.
 */
export function createShopifyService(request) {
  const available = (level) => level.quantities.find((q) => q.name === 'available')?.quantity ?? 0;

  return {
    async listLocations() {
      const data = await request(`query { locations(first: 50) { nodes { id name isActive fulfillsOnlineOrders } } }`);
      return data.locations.nodes;
    },

    /** Variant + its inventory item + available quantity at every location. null if the variant doesn't exist. */
    async getVariantInventory(variantGid) {
      const data = await request(
        `query VariantInventory($id: ID!) {
          productVariant(id: $id) {
            id sku title inventoryPolicy
            product { title status }
            inventoryItem {
              id tracked
              inventoryLevels(first: 50) { nodes { location { id } quantities(names: ["available"]) { name quantity } } }
            }
          }
        }`,
        { id: variantGid },
      );
      const v = data.productVariant;
      if (!v) return null;
      return {
        variantId: v.id,
        sku: v.sku,
        title: v.title,
        productTitle: v.product.title,
        tracked: v.inventoryItem.tracked,
        inventoryPolicy: v.inventoryPolicy,
        inventoryItemId: v.inventoryItem.id,
        levels: v.inventoryItem.inventoryLevels.nodes.map((l) => ({ locationId: l.location.id, available: available(l) })),
      };
    },

    /** Available quantity per location for many inventory items at once (used by reconciliation). */
    async getInventoryLevels(itemIds) {
      const out = new Map();
      for (let i = 0; i < itemIds.length; i += 50) {
        const data = await request(
          `query Levels($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on InventoryItem { id inventoryLevels(first: 50) { nodes { location { id } quantities(names: ["available"]) { name quantity } } } }
            }
          }`,
          { ids: itemIds.slice(i, i + 50) },
        );
        for (const n of data.nodes) {
          if (n) out.set(n.id, n.inventoryLevels.nodes.map((l) => ({ locationId: l.location.id, available: available(l) })));
        }
      }
      return out;
    },

    async getFulfillmentOrders(orderGid) {
      const data = await request(
        `query FOs($id: ID!) {
          order(id: $id) {
            fulfillmentOrders(first: 20) {
              nodes {
                id status
                assignedLocation { location { id } }
                lineItems(first: 100) { nodes { id remainingQuantity lineItem { id } } }
              }
            }
          }
        }`,
        { id: orderGid },
      );
      if (!data.order) return null;
      return data.order.fulfillmentOrders.nodes.map((fo) => ({
        id: fo.id,
        status: fo.status,
        locationId: fo.assignedLocation?.location?.id,
        lineItems: fo.lineItems.nodes.map((li) => ({ id: li.id, lineItemId: li.lineItem.id, remainingQuantity: li.remainingQuantity })),
      }));
    },

    /** Move some (or all) of a fulfillment order's lines to another location. */
    async moveFulfillmentOrder(foId, newLocationId, lineItems) {
      const data = await request(
        `mutation Move($id: ID!, $loc: ID!, $lines: [FulfillmentOrderLineItemInput!]) {
          fulfillmentOrderMove(id: $id, newLocationId: $loc, fulfillmentOrderLineItems: $lines) {
            movedFulfillmentOrder { id assignedLocation { location { id } } }
            userErrors { field message }
          }
        }`,
        { id: foId, loc: newLocationId, lines: lineItems },
      );
      const r = data.fulfillmentOrderMove;
      if (r.userErrors.length) throw new ShopifyError(`fulfillmentOrderMove: ${r.userErrors.map((e) => e.message).join('; ')}`);
      return r.movedFulfillmentOrder;
    },

    /**
     * Orders created since `sinceIso`, oldest first, in the same shape as the orders/create webhook
     * payload, so a missed order can go through exactly the same allocation path.
     */
    async listOrdersSince(sinceIso) {
      const out = [];
      let after = null;
      do {
        const data = await request(
          `query Recent($q: String!, $after: String) {
            orders(first: 50, after: $after, query: $q, sortKey: CREATED_AT) {
              nodes {
                id legacyResourceId name createdAt cancelledAt
                shippingAddress { zip } billingAddress { zip }
                customAttributes { key value }
                lineItems(first: 100) { nodes { id quantity unfulfilledQuantity requiresShipping variant { legacyResourceId } } }
              }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { q: `created_at:>='${sinceIso}'`, after },
        );
        for (const o of data.orders.nodes) out.push(toWebhookShape(o));
        after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
      } while (after);
      return out;
    },

    async addOrderTags(orderGid, tags) {
      const data = await request(
        `mutation Tag($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`,
        { id: orderGid, tags },
      );
      const errs = data.tagsAdd.userErrors;
      if (errs.length) throw new ShopifyError(`tagsAdd: ${errs.map((e) => e.message).join('; ')}`);
    },
  };
}

const numeric = (gid) => Number(String(gid).split('/').pop());

/** GraphQL Order -> the REST/webhook fields orders.js reads. */
function toWebhookShape(o) {
  return {
    id: Number(o.legacyResourceId),
    admin_graphql_api_id: o.id,
    name: o.name,
    created_at: o.createdAt,
    cancelled_at: o.cancelledAt,
    shipping_address: o.shippingAddress ? { zip: o.shippingAddress.zip } : null,
    billing_address: o.billingAddress ? { zip: o.billingAddress.zip } : null,
    note_attributes: o.customAttributes.map((a) => ({ name: a.key, value: a.value })),
    line_items: o.lineItems.nodes.map((li) => ({
      id: numeric(li.id),
      variant_id: li.variant ? Number(li.variant.legacyResourceId) : null,
      quantity: li.quantity,
      fulfillable_quantity: li.unfulfilledQuantity,
      requires_shipping: li.requiresShipping,
      fulfillment_status: li.unfulfilledQuantity === 0 ? 'fulfilled' : null,
    })),
  };
}
