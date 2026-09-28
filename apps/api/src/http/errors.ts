import type { ContentfulStatusCode } from "hono/utils/http-status";

export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }

  toBody(): { error: string; message: string } {
    return { error: this.code, message: this.message };
  }
}

export const unauthorized = (message = "A valid, unrevoked key is required") =>
  new HttpError(401, "UNAUTHORIZED", message);
export const forbidden = (role: string) =>
  new HttpError(403, "FORBIDDEN", `This action isn't available to a ${role.toLowerCase()} key`);
export const notFound = (what: string) => new HttpError(404, "NOT_FOUND", `${what} not found`);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
export const badRequest = (message: string) => new HttpError(400, "BAD_REQUEST", message);
