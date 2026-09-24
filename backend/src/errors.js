/** An error that maps to an HTTP response. `code` is stable and machine-readable; `message` is for humans. */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new AppError(400, 'VALIDATION_ERROR', message, details);
export const unauthorized = (message = 'Missing or invalid credentials') => new AppError(401, 'UNAUTHORIZED', message);
export const notFound = (code, message) => new AppError(404, code, message);
export const unprocessable = (code, message, details) => new AppError(422, code, message, details);

/** Raised by the Shopify client. `retryable` tells the caller whether a later attempt could succeed. */
export class ShopifyError extends Error {
  constructor(message, { retryable = false, status, code = 'SHOPIFY_ERROR' } = {}) {
    super(message);
    this.retryable = retryable;
    this.status = status;
    this.code = code;
  }
}
