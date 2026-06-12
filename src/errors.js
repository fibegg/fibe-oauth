export class UnknownProviderError extends Error {
  constructor(message = 'unknown_provider') {
    super(message);
    this.name = 'UnknownProviderError';
  }
}

export class NotFoundError extends Error {
  constructor(message = 'session_not_found') {
    super(message);
    this.name = 'NotFoundError';
  }
}
