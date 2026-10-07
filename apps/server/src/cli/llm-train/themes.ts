// Furnishing themes: what a tavern, a library or a crypt gets, as steps of
// add_prop by place. Steps that refer to an earlier prop ("around" a table,
// "near" the forge) wait for its id. The user's words for each theme and for
// each prop come along, for the requests and the answers.
import type { Corner, Side } from './tools.ts';

export type ThemePlace =
  | { kind: 'center' }
  | { kind: 'wall'; side?: Side }
  | { kind: 'corner'; corner?: Corner }
  | { kind: 'around'; of: number; count: number }
  | { kind: 'near'; of: number };

export interface ThemeStep {
  asset: string;
  place: ThemePlace;
  /** How many along a wall or in a corner (default 1). */
  count?: number;
  /** "a bar counter", "chairs" (plural used when count > 1). */
  word: string;
  plural?: string;
  /** Can be left out when the room is small. */
  optional?: boolean;
}

export interface Theme {
  id: string;
  /** The user's words: "a tavern", "the guards' barracks". */
  words: readonly string[];
  /** Smallest room it fits in (squares). */
  min: [number, number];
  steps: readonly ThemeStep[];
}

const wall = (side?: Side): ThemePlace => ({ kind: 'wall', ...(side ? { side } : {}) });
const corner = (c?: Corner): ThemePlace => ({ kind: 'corner', ...(c ? { corner: c } : {}) });
const center: ThemePlace = { kind: 'center' };
const around = (of: number, count: number): ThemePlace => ({ kind: 'around', of, count });
const near = (of: number): ThemePlace => ({ kind: 'near', of });

export const THEMES: readonly Theme[] = [
  {
    id: 'tavern',
    words: ['a tavern', 'a taproom', 'an inn common room', 'a tavern with a bar'],
    min: [6, 5],
    steps: [
      { asset: 'bar-counter', place: wall(), word: 'a bar counter' },
      { asset: 'table-round', place: center, word: 'a round table' },
      { asset: 'chair', place: around(1, 4), word: 'a chair', plural: 'chairs' },
      { asset: 'barrels', place: corner(), word: 'barrels', optional: true },
      { asset: 'fireplace', place: wall(), word: 'a fireplace', optional: true },
    ],
  },
  {
    id: 'library',
    words: ['a library', 'a study', 'an archive', "a wizard's library"],
    min: [5, 5],
    steps: [
      { asset: 'bookshelf', place: wall(), count: 2, word: 'a bookshelf', plural: 'bookshelves' },
      { asset: 'desk', place: center, word: 'a desk' },
      { asset: 'chair', place: near(1), word: 'a chair' },
      { asset: 'books', place: corner(), word: 'a pile of books', optional: true },
      { asset: 'candles', place: corner(), word: 'candles', optional: true },
    ],
  },
  {
    id: 'barracks',
    words: ['barracks', 'a barracks', "the guards' quarters", 'a bunk room'],
    min: [6, 5],
    steps: [
      { asset: 'bunk-bed', place: wall(), count: 3, word: 'a bunk bed', plural: 'bunk beds' },
      { asset: 'chest', place: wall(), count: 2, word: 'a chest', plural: 'chests', optional: true },
      { asset: 'weapon-rack', place: wall(), word: 'a weapon rack' },
      { asset: 'table-square', place: center, word: 'a small table', optional: true },
    ],
  },
  {
    id: 'shrine',
    words: ['a shrine', 'a chapel', 'a small temple', 'a holy shrine'],
    min: [5, 5],
    steps: [
      { asset: 'altar', place: wall(), word: 'an altar' },
      { asset: 'statue', place: corner(), count: 2, word: 'a statue', plural: 'statues' },
      { asset: 'candles', place: near(0), word: 'candles' },
      { asset: 'font', place: center, word: 'a font', optional: true },
    ],
  },
  {
    id: 'crypt',
    words: ['a crypt', 'a burial chamber', 'a tomb'],
    min: [5, 5],
    steps: [
      { asset: 'sarcophagus', place: center, word: 'a sarcophagus' },
      { asset: 'coffin', place: wall(), count: 2, word: 'a coffin', plural: 'coffins' },
      { asset: 'urns', place: corner(), word: 'urns', optional: true },
      { asset: 'bones', place: corner(), word: 'bones', optional: true },
      { asset: 'candles', place: near(0), word: 'candles', optional: true },
    ],
  },
  {
    id: 'kitchen',
    words: ['a kitchen', 'a cookhouse', 'the kitchen'],
    min: [5, 4],
    steps: [
      { asset: 'oven', place: wall(), word: 'an oven' },
      { asset: 'table-long', place: center, word: 'a long table' },
      { asset: 'cauldron', place: corner(), word: 'a cauldron' },
      { asset: 'barrel', place: corner(), word: 'a barrel', optional: true },
      { asset: 'sacks', place: wall(), word: 'sacks', optional: true },
    ],
  },
  {
    id: 'smithy',
    words: ['a smithy', 'a forge', "a blacksmith's workshop"],
    min: [5, 5],
    steps: [
      { asset: 'forge', place: wall(), word: 'a forge' },
      { asset: 'anvil', place: near(0), word: 'an anvil' },
      { asset: 'workbench', place: wall(), word: 'a workbench' },
      { asset: 'grindstone', place: corner(), word: 'a grindstone', optional: true },
      { asset: 'weapon-rack', place: wall(), word: 'a weapon rack', optional: true },
    ],
  },
  {
    id: 'bedroom',
    words: ['a bedroom', "the captain's quarters", 'a guest room', 'a bedchamber'],
    min: [4, 4],
    steps: [
      { asset: 'bed-double', place: wall(), word: 'a double bed' },
      { asset: 'wardrobe', place: wall(), word: 'a wardrobe' },
      { asset: 'chest-closed', place: near(0), word: 'a chest' },
      { asset: 'desk', place: wall(), word: 'a desk', optional: true },
      { asset: 'mirror', place: corner(), word: 'a mirror', optional: true },
    ],
  },
  {
    id: 'throne',
    words: ['a throne room', 'a royal audience hall', "the king's court"],
    min: [6, 6],
    steps: [
      { asset: 'throne', place: wall(), word: 'a throne' },
      { asset: 'brazier', place: near(0), word: 'a brazier' },
      { asset: 'statue', place: corner(), count: 2, word: 'a statue', plural: 'statues' },
      { asset: 'chandelier', place: center, word: 'a chandelier', optional: true },
    ],
  },
  {
    id: 'prison',
    words: ['a prison', 'cells', 'a torture chamber', 'a dungeon cell block'],
    min: [5, 4],
    steps: [
      { asset: 'shackles', place: wall(), count: 2, word: 'shackles', plural: 'sets of shackles' },
      { asset: 'cage', place: corner(), word: 'a cage' },
      { asset: 'rack', place: center, word: 'a rack' },
      { asset: 'bones', place: corner(), word: 'bones', optional: true },
      { asset: 'stocks', place: wall(), word: 'stocks', optional: true },
    ],
  },
  {
    id: 'treasury',
    words: ['a treasury', 'a treasure vault', "a dragon's hoard room"],
    min: [4, 4],
    steps: [
      { asset: 'hoard', place: center, word: 'a hoard of treasure' },
      { asset: 'chest-closed', place: wall(), count: 2, word: 'a chest', plural: 'chests' },
      { asset: 'coins', place: corner(), word: 'coins' },
      { asset: 'urns', place: corner(), word: 'urns', optional: true },
    ],
  },
  {
    id: 'lab',
    words: ["an alchemist's lab", 'a wizard laboratory', 'an alchemy workshop'],
    min: [5, 4],
    steps: [
      { asset: 'alchemy-table', place: wall(), word: 'an alchemy table' },
      { asset: 'cauldron', place: center, word: 'a cauldron' },
      { asset: 'bookshelf', place: wall(), word: 'a bookshelf' },
      { asset: 'orb-pedestal', place: corner(), word: 'an orb on a pedestal', optional: true },
      { asset: 'candles', place: corner(), word: 'candles', optional: true },
    ],
  },
  {
    id: 'store',
    words: ['a storeroom', 'a store room', 'a supply room', 'a larder'],
    min: [4, 4],
    steps: [
      { asset: 'crates', place: corner(), word: 'crates' },
      { asset: 'barrels', place: corner(), word: 'barrels' },
      { asset: 'supply-shelf', place: wall(), word: 'a supply shelf' },
      { asset: 'sacks', place: wall(), word: 'sacks', optional: true },
    ],
  },
  {
    id: 'guard',
    words: ['a guard room', 'a guard post', 'a watch room'],
    min: [4, 4],
    steps: [
      { asset: 'table-square', place: center, word: 'a table' },
      { asset: 'chair', place: around(0, 2), word: 'a chair', plural: 'chairs' },
      { asset: 'weapon-rack', place: wall(), word: 'a weapon rack' },
      { asset: 'brazier', place: corner(), word: 'a brazier', optional: true },
    ],
  },
  {
    id: 'dining',
    words: ['a dining hall', 'a feast hall', 'a mess hall'],
    min: [6, 5],
    steps: [
      { asset: 'table-long', place: center, word: 'a long table' },
      { asset: 'chair', place: around(0, 6), word: 'a chair', plural: 'chairs' },
      { asset: 'fireplace', place: wall(), word: 'a fireplace' },
      { asset: 'barrel', place: corner(), word: 'a barrel', optional: true },
    ],
  },
];

/** Which theme fits a room kind from words.ts (for partly furnished starting maps). */
export const THEME_OF_KIND: Record<string, string> = {
  guard: 'guard', barracks: 'barracks', armoury: 'guard', store: 'store', kitchen: 'kitchen', hall: 'dining', throne: 'throne', shrine: 'shrine', crypt: 'crypt',
  library: 'library', lab: 'lab', prison: 'prison', treasury: 'treasury', smithy: 'smithy', bedroom: 'bedroom', tavern: 'tavern',
};

/** The user's words for single props (single_prop family): asset id → words. */
export const PROP_WORDS: Record<string, readonly string[]> = {
  'chest-closed': ['a chest', 'a treasure chest', 'a locked chest'],
  'chest-open': ['an open chest'],
  barrel: ['a barrel'],
  crate: ['a crate'],
  crates: ['some crates', 'a stack of crates'],
  statue: ['a statue'],
  altar: ['an altar'],
  fountain: ['a fountain'],
  'table-round': ['a round table'],
  'table-rect': ['a table'],
  'bed-single': ['a bed', 'a single bed'],
  'bed-double': ['a double bed'],
  bookshelf: ['a bookshelf', 'a bookcase'],
  desk: ['a desk', 'a writing desk'],
  throne: ['a throne'],
  brazier: ['a brazier'],
  candles: ['some candles', 'candles'],
  'weapon-rack': ['a weapon rack'],
  'armor-stand': ['an armour stand', 'an armor stand'],
  anvil: ['an anvil'],
  cauldron: ['a cauldron'],
  sarcophagus: ['a sarcophagus', 'a stone coffin'],
  coffin: ['a coffin'],
  lectern: ['a lectern'],
  obelisk: ['an obelisk'],
  'orb-pedestal': ['a crystal orb on a pedestal'],
  idol: ['an idol', 'a small idol'],
  cage: ['a cage'],
  bones: ['a pile of bones', 'bones'],
  skeleton: ['a skeleton'],
  'rubble-large': ['a heap of rubble'],
  lever: ['a lever'],
  'pressure-plate': ['a pressure plate', 'a hidden pressure plate'],
  'spike-trap': ['a spike trap'],
  'stairs-spiral': ['a spiral staircase'],
  ladder: ['a ladder'],
  mirror: ['a mirror'],
  wardrobe: ['a wardrobe'],
  'hoard': ['a treasure hoard', 'a pile of treasure'],
  'war-table': ['a war table', 'a map table'],
  loom: ['a loom'],
  'alchemy-table': ['an alchemy table'],
  urns: ['some urns'],
  sconce: ['a wall torch'],
  chandelier: ['a chandelier'],
  campfire: ['a campfire'],
  tent: ['a tent'],
  boulder: ['a boulder', 'a rock'],
  'boulder-large': ['a big boulder'],
  'tree-dead': ['a dead tree'],
  stump: ['a stump', 'a tree stump'],
  log: ['a log', 'a fallen log'],
  'drain-grate': ['a drain grate'],
};

/** Where a single prop can go by meaning, and how the user says it. */
export const PLACE_PHRASES: Record<string, readonly string[]> = {
  center: ['in the middle of', 'in the centre of', 'in the center of', 'right in the middle of'],
  'north wall': ['against the north wall of', 'along the north wall of', 'by the north wall of', 'on the north side of'],
  'south wall': ['against the south wall of', 'along the south wall of', 'by the south wall of', 'on the south side of'],
  'east wall': ['against the east wall of', 'along the east wall of', 'by the east wall of', 'on the east side of'],
  'west wall': ['against the west wall of', 'along the west wall of', 'by the west wall of', 'on the west side of'],
  'ne corner': ['in the north-east corner of', 'in the NE corner of', 'in the northeast corner of'],
  'nw corner': ['in the north-west corner of', 'in the NW corner of', 'in the northwest corner of'],
  'se corner': ['in the south-east corner of', 'in the SE corner of', 'in the southeast corner of'],
  'sw corner': ['in the south-west corner of', 'in the SW corner of', 'in the southwest corner of'],
};
