// THIRD-PARTY-NOTICES.txt for the desktop app: every npm package that ends up
// in what the app ships (found from esbuild's metafiles of the server bundle,
// the browser bundles and the Electron main process, plus the packages copied
// as they are), with its licence text; then Node.js, Electron and Chromium.
//   node scripts/notices.mjs <out file> <node LICENSE file>   (from apps/desktop)
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '..');
const root = join(desktop, '..', '..');
const esbuild = createRequire(join(root, 'package.json'))('esbuild');
const [out, nodeLicense] = process.argv.slice(2);
if (!out) throw new Error('usage: node scripts/notices.mjs <out file> [node LICENSE]');

const metas = [];
const build = async (entry, o) => {
  const r = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, metafile: true, outdir: '/tmp/delve-notices', logLevel: 'silent', ...o });
  metas.push(r.metafile);
};
await build(join(root, 'apps/server/src/desktop/main.ts'), { platform: 'node', format: 'esm', external: ['@resvg/resvg-js', 'bufferutil', 'utf-8-validate'] });
for (const e of ['viewer', 'stack', 'screen', 'trace', 'trace-worker', 'table', 'table-dice', 'table3d', 'handout']) await build(join(root, `apps/web/src/${e}.ts`), { platform: 'browser', format: 'esm' });
await build(join(desktop, 'src/main.ts'), { platform: 'node', format: 'cjs', external: ['electron'], nodePaths: [join(desktop, 'node_modules')] });

/** The package folder an input file belongs to. */
function packageOf(file) {
  const parts = file.split(/[\\/]/);
  const i = parts.lastIndexOf('node_modules');
  if (i < 0) return null;
  const name = parts[i + 1]?.startsWith('@') ? `${parts[i + 1]}/${parts[i + 2]}` : parts[i + 1];
  return parts.slice(0, i + 1).join(sep) + sep + name;
}

const dirs = new Set();
for (const m of metas) for (const input of Object.keys(m.inputs)) {
  const p = packageOf(input);
  if (p && !p.includes(`${sep}@delve${sep}`)) dirs.add(p.startsWith(sep) ? p : join(process.cwd(), p));
}
// shipped as they are, not bundled
for (const p of ['@resvg/resvg-js', '@expo-google-fonts/im-fell-english', '@expo-google-fonts/marcellus-sc']) dirs.add(join(root, 'node_modules', p));
dirs.add('RESVG_WIN32'); // the Windows binary, from its npm package (same licence as @resvg/resvg-js)

const LICENCE_FILE = /^(licen[cs]e|copying|notice|ofl)/i;
const entries = [];
for (const d of [...dirs].sort()) {
  if (d === 'RESVG_WIN32') {
    entries.push({ name: '@resvg/resvg-js-win32-x64-msvc', version: JSON.parse(readFileSync(join(root, 'node_modules/@resvg/resvg-js/package.json'), 'utf8')).version, license: 'MPL-2.0', texts: ['Same licence as @resvg/resvg-js (above).'] });
    continue;
  }
  if (!existsSync(join(d, 'package.json'))) continue;
  const pkg = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'));
  const texts = readdirSync(d)
    .filter((f) => LICENCE_FILE.test(f))
    .sort()
    .map((f) => `--- ${f}\n${readFileSync(join(d, f), 'utf8').trim()}`);
  entries.push({ name: pkg.name, version: pkg.version, license: typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? pkg.licenses ?? 'see text'), texts, where: relative(root, d) });
}

const lines = [
  'Delve for Windows: third-party software',
  '========================================',
  '',
  'Delve itself: no licence has been chosen yet; until one is, all rights are reserved by its authors.',
  'Delve sends nothing about you anywhere: no telemetry, no crash reports, no update checks (until updates are switched on).',
  '',
  'Delve ships these programs and libraries, each under its own licence:',
  '',
  '- Electron (MIT) and Chromium (BSD-3-Clause and others): see LICENSE.electron.txt and LICENSES.chromium.html next to Delve.exe.',
  `- Node.js (MIT and others), run as resources\\node\\node.exe${nodeLicense ? ': its licence is at the end of this file' : ''}.`,
  ...entries.map((e) => `- ${e.name} ${e.version} (${e.license})`),
  '',
  'Fonts: IM FELL English (Igino Marini) and Marcellus SC (Astigmatic), SIL Open Font License 1.1, from the @expo-google-fonts packages above.',
  '',
];
for (const e of entries) {
  lines.push('', '='.repeat(72), `${e.name} ${e.version} — ${e.license}`, '='.repeat(72), e.texts.length ? e.texts.join('\n\n') : `(no licence file in the package; its package.json says ${e.license})`);
}
if (nodeLicense && existsSync(nodeLicense)) lines.push('', '='.repeat(72), 'Node.js', '='.repeat(72), readFileSync(nodeLicense, 'utf8').trim());
writeFileSync(out, `${lines.join('\n')}\n`);
console.log(`notices: ${entries.length} packages -> ${out}`);
