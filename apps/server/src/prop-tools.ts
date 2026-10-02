// MCP tools for this Delve's own props: Claude draws a prop the GM describes
// (prop_rules, then create_prop), looks at the preview it gets back, and fixes
// it with update_prop. Kept out of mcp.ts, which only registers them.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PROP_CATEGORIES, PROP_MARGIN, PROP_MAX_SIZE, PROP_MIN_SIZE } from '@delve/core';
import { assets } from './assets.ts';
import { mapsUsingProp, previewPng, PropError, PREVIEW_STYLES, type CustomProp, type PropLibrary } from './custom-props.ts';
import type { MapStore } from './store.ts';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean };

const text = (s: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: s }], ...(isError ? { isError: true } : {}) });

export const PROP_RULES = `How to draw a Delve prop (for create_prop and update_prop)

FOOTPRINT AND FILE
- One standalone <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w*100} {h*100}">: 100 units per grid square. w and h are ${PROP_MIN_SIZE} to ${PROP_MAX_SIZE} squares, in half squares.
- Keep every mark ${PROP_MARGIN} units inside the edge, stroke included (a 4-unit outline's geometry 6 units in). Small things don't fill their square: a barrel is about 85 units across, a chest about 70 × 45, a chair 40 × 40.
- Straight top-down, like a floor plan: no perspective, no sides showing, no cast shadows. Anything with a front (chair, throne, bed, altar, fireplace, chest) faces SOUTH, down the page, its back along the top edge. Wall-mounted things (sconce, shelf, shackles) sit against the top edge: that is the wall.
- Loose pieces of a set (chairs round a table, tools on a bench) sit a few degrees off-square and shifted a few units, so the set doesn't look rigid.

WHAT A FILE MAY CONTAIN
- Elements: path, rect, circle, ellipse, line, polyline, polygon, g. Attributes: geometry, fill, stroke, stroke-width, stroke-linecap, stroke-linejoin, fill-rule, and transform with translate() / rotate() only.
- Exactly three inks, written as these strings (Delve swaps them for each map style):
  #000000 ink: every line, openings (a pit, a keyhole, the gap behind a handle), tiny marks (rivets, nail heads). Never a surface.
  #FFFFFF paper: the main top surface (a table top, a lid, a barrel head, a statue's arms).
  #999999 shade: the second surface, for one of four reasons: metal fittings (bands, hoops, lock plates, blades); a darker material; something lower than its neighbour (a step, a recessed lid); contents and hair (liquid, coins, soil, coals).
  "none" where there is no paint.
- Never: text or letters, images, href or links, scripts, CSS (style, class), opacity, gradients, filters, masks, clip paths, <use>, scale().

LINES
- stroke-width 4 traces the silhouette of each separate piece; 2 draws construction inside a piece (seams, bands, rims, handles, plates); 1.5 is sparse texture (grain, cracks, folds: about one mark per 20 × 20 units). No other widths. Hardware narrower than about 8 units takes 2 even on its silhouette, or it turns solid black at 70 px.
- Give every shape an explicit fill ("none" for stroke-only lines). Fill every surface so the grid doesn't show through; the floor may show only between separate pieces. A closed outline with nothing inside is an error.
- Alternate paper and shade so neighbouring parts separate at 70 px (a statue: shade step, paper top, shade cloak, paper arms).
- Order: surface fills first, then details, then the outline on top. Draw a piece's surface as a fill-only shape (stroke "none"), then its details, then the same shape again with fill "none" and stroke-width 4, so seams end under the outline's ink.
- No marks that read as letters or digits at 70 px: a ring with a centre dot, zigzags, radiating fans, paired brackets, a circle with a bar through it.

THE HAND-INKED LINE
- Draw clean geometry. Delve inks it for you (ink true, the default): every shape gets the built-in art's slightly uneven, smooth pen line. Identical shapes get identical lines, so a fill and its outline stay together. Marks under 6 units (rivets, keyholes) stay exactly as drawn, and round caps and joins are added. Use ink false only for art that is hand-drawn already.

CHECKING YOUR DRAWING
- create_prop refuses anything outside these rules and lists what to fix. When it accepts, you get a preview: the prop on a floor of at least 3 × 3 squares at 70 px per square (Roll20's grid), in ${PREVIEW_STYLES.join(', ')}, and the prop alone, enlarged, to check the drawing itself.
- Look at the preview as a GM would: does it read at that size, are the parts told apart, does it face south, is anything solid black that shouldn't be, is anything too thin to see? One square is 70 px, so a 2-unit line is 1.4 px: a few bold parts beat many small ones.
- Fix it with update_prop (same id, new svg). Stop after about 3 tries and show the GM what you have.`;

/** Two clean drawings that follow the rules, for Delve to ink. */
const EXAMPLES = `EXAMPLE 1, clean geometry (what you send; Delve inks it). "Strongbox", 1×1, storage: a paper lid, shade iron bands and lock plate, an ink keyhole, one grain line, the outline last over the surface.
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<rect x="20" y="29" width="60" height="42" rx="3" fill="#FFFFFF" stroke="none"/>
<rect x="31" y="29" width="7" height="42" fill="#999999" stroke="#000000" stroke-width="2"/>
<rect x="62" y="29" width="7" height="42" fill="#999999" stroke="#000000" stroke-width="2"/>
<line x1="43" y1="39" x2="57" y2="40" stroke="#000000" stroke-width="1.5"/>
<rect x="44" y="61" width="12" height="10" rx="1.5" fill="#999999" stroke="#000000" stroke-width="2"/>
<rect x="49" y="64" width="2" height="4" fill="#000000" stroke="none"/>
<rect x="20" y="29" width="60" height="42" rx="3" fill="none" stroke="#000000" stroke-width="4"/>
</svg>

EXAMPLE 2, clean geometry. "Cart wheel", 1×1, workshop: a ring (fill-rule evenodd), spokes in detail weight, a shade hub.
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<path d="M50 14 A36 36 0 1 1 49.9 14 Z M50 24 A26 26 0 1 0 50.1 24 Z" fill="#FFFFFF" fill-rule="evenodd" stroke="#000000" stroke-width="4"/>
<path d="M50 26 L50 74 M26 50 L74 50 M33 33 L67 67 M67 33 L33 67" fill="none" stroke="#000000" stroke-width="2"/>
<circle cx="50" cy="50" r="8" fill="#999999" stroke="#000000" stroke-width="2"/>
</svg>`;

const sizeLine = (p: CustomProp) => `${p.w}×${p.h}`;
const blocksWord = (b: string) => (b === 'none' ? 'walk over it' : b === 'movement' ? 'blocks movement' : 'blocks sight');

const svgArg = z.string().max(70_000).describe(`The drawing: a standalone <svg> with viewBox "0 0 {w*100} {h*100}" following prop_rules (at most 64 KB)`);
const metaArgs = {
  name: z.string().min(1).max(60).describe('What the GM sees in the Prop picker, e.g. "Blacksmith’s anvil"'),
  category: z.enum(PROP_CATEGORIES.map((c) => c.id) as [string, ...string[]]).optional().describe('Where it shows in the picker. Default custom; or a built-in category such as workshop or dungeon (decals draw under the walls, symbols only in the GM view)'),
  w: z.number().min(PROP_MIN_SIZE).max(PROP_MAX_SIZE).describe('Footprint width in squares (0.5 steps)'),
  h: z.number().min(PROP_MIN_SIZE).max(PROP_MAX_SIZE).describe('Footprint height in squares (0.5 steps)'),
  tags: z.array(z.string().max(24)).max(12).optional().describe('Search words, e.g. ["smithy", "metal", "tools"]'),
  blocks: z.enum(['none', 'movement', 'sight']).optional().describe('none: walk over it (rug, web); movement (default): blocks walking (table, anvil); sight: blocks walking and the view (wardrobe, tree)'),
  ink: z.boolean().optional().describe('Default true: Delve gives your clean shapes the hand-inked line. false keeps every line exactly as drawn'),
};

export function registerPropTools(server: McpServer, props: PropLibrary, store: MapStore, base: string, by: string): void {
  const previewLink = (p: CustomProp) => `${base}/api/v1/props/${p.id}/preview.png?v=${encodeURIComponent(p.updated)}`;
  const withPreview = async (p: CustomProp, head: string, notes: string[]): Promise<ToolResult> => {
    const png = await previewPng(p.id);
    return {
      content: [
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
        {
          type: 'text',
          text:
            `${head}\n${p.id} "${p.name}": ${sizeLine(p)} squares, category ${p.category}, ${blocksWord(p.blocks)}${p.tags.length ? `, tags ${p.tags.join(', ')}` : ''}.` +
            (notes.length ? `\nNotes: ${notes.join('; ')}.` : '') +
            `\nThe picture: the prop on a floor at 70 px per square (Roll20's grid) in ${PREVIEW_STYLES.join(', ')}, then enlarged on its own. Judge it at 70 px, check the drawing in the enlargement, and fix it with update_prop if it doesn't follow prop_rules.` +
            `\nIt is in the editor's Prop picker now. A link to this preview for the GM: ${previewLink(p)}`,
        },
      ],
    };
  };
  const refused = (e: unknown): ToolResult => {
    if (e instanceof PropError) {
      return text(`Not saved. ${e.problems.length === 1 ? 'Fix this' : `Fix these ${e.problems.length} problems`} and send it again:\n- ${e.problems.join('\n- ')}`, true);
    }
    return text(`internal error: ${(e as Error).message}`, true);
  };

  server.registerTool(
    'prop_rules',
    {
      title: 'How to draw a prop',
      description: "The rules for drawing a new prop (Delve's ink style, footprint, colours, line weights) and two example SVGs. Read it before create_prop.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => {
      const chair = assets.svg('chair');
      const real = chair ? `\n\nEXAMPLE 3, a built-in prop as Delve draws it (chair, 1×1, furniture: the seat in paper, the shade back rail along the top edge, two grain lines; this is the inked line your shapes get):\n${chair}` : '';
      return text(`${PROP_RULES}\n\n${EXAMPLES}${real}`);
    },
  );

  server.registerTool(
    'create_prop',
    {
      title: 'Create a prop',
      description:
        'Draw a new prop for this Delve\'s shared library, when the GM asks for one the catalog (list_assets) does not have. Call prop_rules first. ' +
        'Refused drawings come back with what to fix. Saved ones come back with a preview picture to check; fix them with update_prop. The prop shows in every GM\'s Prop picker; place it on a map only if asked (add_prop with its id).',
      inputSchema: { ...metaArgs, svg: svgArg, id: z.string().max(60).optional().describe('Wanted id; it becomes my-<words>. Default: from the name') },
    },
    async (a) => {
      try {
        const { prop, notes } = props.create(a, by);
        return await withPreview(prop, `Saved the new prop ${prop.id}.`, notes);
      } catch (e) {
        return refused(e);
      }
    },
  );

  server.registerTool(
    'update_prop',
    {
      title: 'Change a custom prop',
      description:
        'Redraw a custom prop (new svg) and/or change its name, category, size, tags or blocks. It keeps its id, so maps that use it show the change. ' +
        'A new size without a new svg scales the old drawing (line weights kept). Returns the preview like create_prop.',
      inputSchema: {
        id: z.string().describe('The custom prop id, e.g. "my-anvil"'),
        svg: svgArg.optional(),
        name: metaArgs.name.optional(),
        category: metaArgs.category,
        w: metaArgs.w.optional(),
        h: metaArgs.h.optional(),
        tags: metaArgs.tags,
        blocks: metaArgs.blocks,
        ink: metaArgs.ink,
      },
    },
    async ({ id, ...a }) => {
      try {
        const { prop, notes } = props.update(id, a);
        return await withPreview(prop, `Updated ${prop.id}.`, notes);
      } catch (e) {
        return refused(e);
      }
    },
  );

  server.registerTool(
    'get_prop',
    {
      title: 'Read a custom prop',
      description: 'A custom prop\'s details, its SVG as it was drawn (before inking, ready to change and send to update_prop) and its preview. Use it before redrawing a prop the GM wants changed.',
      inputSchema: { id: z.string().describe('The custom prop id, e.g. "my-anvil"') },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const p = props.get(id);
      if (!p) return text(`No custom prop ${id}. list_assets with category custom (or search) shows them.`, true);
      const used = mapsUsingProp(store, id);
      const res = await withPreview(p, `Custom prop ${p.id}, made by ${p.by} on ${p.created.slice(0, 10)}${p.updated !== p.created ? `, changed ${p.updated.slice(0, 10)}` : ''}. ${used.length ? `Used on ${used.map((m) => `"${m.name}" (${m.count}×)`).join(', ')}.` : 'Not on any map yet.'}${p.ink ? '' : ' Inked: no (lines kept as drawn).'}`, []);
      res.content.push({ type: 'text', text: `SVG as drawn:\n${props.source(id) ?? ''}` });
      return res;
    },
  );

  server.registerTool(
    'delete_prop',
    {
      title: 'Delete a custom prop',
      description:
        'Remove a custom prop from the library, only when the GM asks. If maps still use it, it is refused with their names, unless force is true: then those maps show a dashed outline where it stood.',
      inputSchema: { id: z.string(), force: z.boolean().optional() },
      annotations: { destructiveHint: true },
    },
    ({ id, force }) => {
      const p = props.get(id);
      if (!p) return text(`No custom prop ${id}.`, true);
      const used = mapsUsingProp(store, id);
      if (used.length && !force) {
        return text(`Not deleted: ${p.name} is on ${used.map((m) => `"${m.name}" (${m.count}×)`).join(', ')}. Ask the GM; with force true those maps show a dashed outline where it stood.`, true);
      }
      props.remove(id);
      return text(`Deleted ${id} "${p.name}".${used.length ? ` ${used.length === 1 ? '1 map now shows' : `${used.length} maps now show`} a dashed outline in its place.` : ''}`);
    },
  );
}
