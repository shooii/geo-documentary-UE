/**
 * An error that carries the status the client should see.
 *
 * The request handler used to answer 400 for everything it caught, so a
 * well-formed request for a project that simply does not exist was reported as a
 * bad request, while the job and asset routes answered 404 for exactly the same
 * situation. Lives in its own module so the asset store - which is not part of
 * the router - can refuse an upload with 415 instead of 400.
 */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}
