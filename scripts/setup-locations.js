// Creates the three warehouse locations (idempotent: skips any that already exist by name).
const fs = require('fs');
const path = require('path');
const { gql } = require('./gql');

const WAREHOUSES = [
  { code: 'DEL', name: 'Delhi Warehouse', address1: 'Plot 14, Okhla Industrial Area Phase II', city: 'New Delhi', zip: '110020', provinceCode: 'DL' },
  { code: 'BLR', name: 'Bengaluru Warehouse', address1: '22, Peenya Industrial Area Phase I', city: 'Bengaluru', zip: '560058', provinceCode: 'KA' },
  { code: 'BOM', name: 'Mumbai Warehouse', address1: 'Unit 7, Andheri Kurla Road, MIDC', city: 'Mumbai', zip: '400093', provinceCode: 'MH' },
];

const tmp = (name, body) => { const p = path.join(__dirname, '.tmp-' + name); fs.writeFileSync(p, body); return p; };

const existing = gql(tmp('q.graphql', '{ locations(first: 50) { nodes { id name } } }')).locations.nodes;
const out = {};
for (const w of WAREHOUSES) {
  const found = existing.find(l => l.name === w.name);
  if (found) { out[w.code] = found.id; console.log('exists', w.name, found.id); continue; }
  const q = tmp('m.graphql', `mutation($input: LocationAddInput!) { locationAdd(input: $input) { location { id name } userErrors { field message code } } }`);
  const v = tmp('v.json', JSON.stringify({ input: {
    name: w.name, fulfillsOnlineOrders: true,
    address: { address1: w.address1, city: w.city, zip: w.zip, provinceCode: w.provinceCode, countryCode: 'IN' },
  } }));
  const r = gql(q, v, true).locationAdd;
  if (r.userErrors.length) throw new Error(w.name + ': ' + JSON.stringify(r.userErrors));
  out[w.code] = r.location.id;
  console.log('created', w.name, r.location.id);
}
fs.writeFileSync(path.join(__dirname, 'locations.json'), JSON.stringify(out, null, 2));
