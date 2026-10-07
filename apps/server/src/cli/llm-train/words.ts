// Words for the generator: map names, room names, GM notes, label texts.
// Written for this generator (generic fantasy vocabulary), nothing taken
// from published maps or adventures.

export const DUNGEON_NAMES = [
  'The Sunken Keep', 'Kobold Warren', 'Old Mill Cellars', "Smugglers' Cove", 'The Drowned Abbey', 'Barrow of the Grey King', 'Goblin Tunnels', 'The Iron Vault',
  'Tower of Ash', 'Hollow Shrine', 'The Lost Mine', 'Cultist Hideout', 'Bandit Lair', 'The Salt Caves', 'Ruined Watchpost', 'Temple of the Moon',
  "The Alchemist's Basement", 'Undercroft', 'The Ossuary', 'Frostdeep Halls', 'Wizard Tower, ground floor', 'Thieves Guild', 'The Rat Pits', 'Ogre Den',
  'Forgotten Library', 'The Black Spire', 'Dwarven Outpost', 'Sewer Junction', 'The Pale Chapel', 'Mushroom Grotto', 'Dragon Hoard', 'Prison Block',
  'Session 4 dungeon', 'Test map', 'Dungeon level 2', 'Lich lair', 'Manor cellar', 'Castle basement', 'Orc stronghold', 'The Maze',
];

export const OUTDOOR_NAMES = [
  'Mirefen Crossing', 'The Old Quarry', 'Hollow Hill', 'Ravenwood Clearing', 'Bramble Ford', 'Stonewatch Pass', 'The Blighted Field', 'Lakeside Camp',
  'Wolf Run', 'Thornvale', 'Frozen Shore', 'Desert Oasis', 'Elder Grove', 'Highmoor', 'The Long Road', 'Bandit Ambush',
  'Ruined Farmstead', 'Riverbend', 'Misty Marsh', 'Goblin Camp', 'Crossroads', 'Hunting Grounds', 'Wilderness encounter', 'Outdoor map',
];

export const EMPTY_NAMES = ['Untitled map', 'New map', 'Sketch', 'Draft', 'Map 1', 'Next session', 'Scratch', 'Encounter', 'New dungeon', 'Blank'];

/** Room names by kind; the kind also picks the props a furnished room gets. */
export const ROOM_KINDS: Record<string, readonly string[]> = {
  guard: ['Guard room', 'Guard post', 'Watch room', 'Gatehouse'],
  barracks: ['Barracks', 'Bunk room', 'Soldiers quarters', 'Dormitory'],
  armoury: ['Armoury', 'Weapon store', 'Arsenal'],
  store: ['Storeroom', 'Pantry', 'Supply room', 'Larder', 'Cellar'],
  kitchen: ['Kitchen', 'Scullery', 'Cookhouse'],
  hall: ['Great hall', 'Feast hall', 'Hall', 'Audience chamber', 'Entrance hall'],
  throne: ['Throne room', 'Court'],
  shrine: ['Shrine', 'Chapel', 'Temple', 'Sanctum'],
  crypt: ['Tomb', 'Burial chamber', 'Ossuary', 'Catacomb'],
  library: ['Library', 'Archive', 'Study', 'Scriptorium'],
  lab: ['Laboratory', "Alchemist's workshop", 'Wizard study'],
  prison: ['Cells', 'Prison', 'Holding cells', 'Torture chamber'],
  treasury: ['Treasury', 'Vault', 'Strongroom'],
  smithy: ['Forge', 'Smithy', 'Workshop'],
  bedroom: ['Bedroom', "Captain's quarters", 'Master bedroom', 'Guest room'],
  tavern: ['Common room', 'Taproom', 'Tavern'],
  plain: ['Antechamber', 'Passage room', 'Junction', 'Empty room', 'Collapsed room', 'Well room', 'Cistern'],
};

export const NOTES = [
  'Three skeletons rise when the door opens.',
  'A goblin sentry dozes here; DC 12 to sneak past.',
  'The floor is slick with oil.',
  'A hidden lever behind the shelf opens the east wall.',
  'Two guards play dice. They have the key to the cells.',
  'Smells of sulphur. A gelatinous cube lurks in the corner.',
  'The chest holds 120 gp and a potion of healing.',
  'Dim light; the ceiling has partly collapsed.',
  'An old map of the lower levels is pinned to the wall.',
  'Rats everywhere. Swarm attacks after 2 rounds.',
  'The statue whispers a riddle.',
  'Trap: poison needle in the lock (DC 14).',
  'The cult leader keeps her journal here.',
  'Water drips from the ceiling; the floor is flooded ankle-deep.',
];

/** GM notes a user might dictate (for the notes family). */
export const DICTATED_NOTES = [
  'Two ogres sleep here; a chest with 40 gp under the bed',
  'The door sticks: Strength DC 13 to open',
  'A ghost appears at midnight and asks for its name',
  'Secret compartment in the north wall holds a silver dagger',
  'The well is 60 ft deep and leads to the sewers',
  'Four bandits, one of them is the informant',
  'Cursed altar: touching it drains 1d6 hp',
  'The smell of fresh bread; the cook is friendly',
  'Gnolls camp here at night',
  'Hidden trapdoor under the rug leads to the cellar',
  'Collapsed ceiling, difficult terrain',
  'The prisoner knows the password: "ember"',
];

export const LABEL_TEXTS = [
  'Here be dragons', 'To the mines', 'Old road', 'Danger', 'Keep out', 'North tower', 'The Pit', 'Kingsroad', 'Flooded', 'Collapsed',
  'Goblin territory', 'Camp', 'Ford', 'To the village', 'Lair', 'Ruins', 'Shrine of the Moon', 'Watch out', 'Exit', 'Market',
];

export const PATH_NAMES = ['path', 'track', 'trail', 'road'];
