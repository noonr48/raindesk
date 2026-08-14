'use strict';

/** HTTP-facing error with a status code; libs throw these, the server maps them. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

module.exports = { HttpError };
