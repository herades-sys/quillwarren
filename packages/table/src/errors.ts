// Errors with messages meant for people: the server sends them to the client as-is.

/** A refused or invalid intent, e.g. "You don't control that token". */
export class TableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TableError';
  }
}

/** A dice expression that can't be rolled, e.g. "Unexpected 'x' at 4". */
export class DiceError extends TableError {
  constructor(message: string) {
    super(message);
    this.name = 'DiceError';
  }
}
