// Run an Admin GraphQL operation through `shopify store execute`.
// Usage: node gql.js <query-file> [variables-file] [--mutate]
const { execFileSync } = require('child_process');
const path = require('path');

const RUN = 'C:\\Users\\MY PC\\AppData\\Roaming\\npm\\node_modules\\@shopify\\cli\\bin\\run.js';
const STORE = 'another-shpyfy-store.myshopify.com';

function gql(queryFile, varsFile, mutate) {
  const args = [RUN, 'store', 'execute', '--store', STORE, '--query-file', path.resolve(queryFile)];
  if (varsFile) args.push('--variable-file', path.resolve(varsFile));
  if (mutate) args.push('--allow-mutations');
  const out = execFileSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  // The CLI prints a banner first and may print upgrade noise after; walk the JSON object by brace depth.
  const lines = out.split(/\r?\n/);
  const start = lines.findIndex(l => l === '{');
  if (start < 0) throw new Error('No JSON in CLI output:\n' + out);
  const text = lines.slice(start).join('\n');
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(text.slice(0, i + 1));
  }
  throw new Error('Unterminated JSON in CLI output');
}

module.exports = { gql };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const mutate = argv.includes('--mutate');
  const [q, v] = argv.filter(a => a !== '--mutate');
  console.log(JSON.stringify(gql(q, v, mutate), null, 2));
}
