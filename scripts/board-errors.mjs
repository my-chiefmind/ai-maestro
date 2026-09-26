/** Stable, machine-readable errors for the public board API. */
class BoardError extends Error {
  constructor(name, code, message, detail = {}) {
    super(message);
    this.name = name;
    this.code = code;
    Object.assign(this, detail);
  }
}

export class BoardInputError extends BoardError {
  constructor(message, detail = {}) { super("BoardInputError", "EBOARDINPUT", message, detail); }
}

export class BoardNotFoundError extends BoardError {
  constructor(message, detail = {}) { super("BoardNotFoundError", "EBOARDNOTFOUND", message, detail); }
}

export class BoardDuplicateError extends BoardError {
  constructor(message, detail = {}) { super("BoardDuplicateError", "EBOARDDUPLICATE", message, detail); }
}

export class BoardValidationError extends BoardError {
  constructor(message, detail = {}) {
    super("BoardValidationError", "EBOARDVALIDATION", message, {
      errors: detail.errors ?? [], warnings: detail.warnings ?? [], ...detail,
    });
  }
}

export class BoardConflictError extends BoardError {
  constructor(message, detail = {}) { super("BoardConflictError", "EBOARDCONFLICT", message, detail); }
}

export class BoardLockError extends BoardError {
  constructor(message, detail = {}) { super("BoardLockError", "EBOARDLOCK", message, detail); }
}
