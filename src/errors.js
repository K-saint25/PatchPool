export class PatchPoolError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'PatchPoolError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
