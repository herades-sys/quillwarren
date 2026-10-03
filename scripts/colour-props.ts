// Imports the finished colour prop batches into the repo and rebuilds their
// catalog (see colour-props-lib.ts). Run: npm run colour-props -- ~/colour-props
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { importColourProps } from './colour-props-lib.ts';

const source = resolve(process.argv[2] ?? join(homedir(), 'colour-props'));
const r = importColourProps({ source, repo: resolve(import.meta.dirname, '..') });
console.log(`colour props: ${r.props - r.textures} props and ${r.textures} terrain textures from ${r.batches.length} finished batches (${r.batches.join(', ') || 'none'})`);
console.log(`  ${r.categories.map((c) => `${c.id} ${c.count}`).join(', ')}`);
if (r.unfinished.length) console.log(`not finished yet, skipped: ${r.unfinished.join(', ')}`);
if (r.problems.length) {
  console.log(`left out (${r.problems.length}):\n  ${r.problems.join('\n  ')}`);
  process.exitCode = 1;
}
