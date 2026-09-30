// Delve Table client entry (docs/TABLE.md), built to /assets/table.js: reads
// the page's initial data and starts the table (apps/web/src/table/app.ts).
import { startTable, type Initial } from './table/app.ts';

startTable(JSON.parse(document.getElementById('table-initial')?.textContent ?? '{}') as Initial);
