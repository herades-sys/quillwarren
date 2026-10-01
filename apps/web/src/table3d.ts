// The 3D table view's entry (docs/TABLE.md, "3D table view"), built to
// /assets/table3d.js with three.js: reads the page's initial data and starts the
// view (apps/web/src/table/app3d.ts). Later panels (notes) take the returned
// context and add their tab with ctx.addPanel().
import { startTable3d, type Initial3d } from './table/app3d.ts';

startTable3d(JSON.parse(document.getElementById('table3d-initial')?.textContent ?? '{}') as Initial3d);
