// The 3D table view's entry (docs/TABLE.md, "3D table view"), built to
// /assets/table3d.js with three.js: reads the page's initial data and starts the
// view (apps/web/src/table/app3d.ts). The GM's notes (docs/TABLE.md, "GM notes")
// take the returned context and add their tab with ctx.addPanel().
import { startTable3d, type Initial3d } from './table/app3d.ts';
import { initNotes3d } from './table/notes3d.ts';

const ctx = startTable3d(JSON.parse(document.getElementById('table3d-initial')?.textContent ?? '{}') as Initial3d);
initNotes3d(ctx);
