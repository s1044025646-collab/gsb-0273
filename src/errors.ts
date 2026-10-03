export type ErrorCode =
  | "INVALID_PRECISION"
  | "INVALID_NAME"
  | "INVALID_KEYS"
  | "INVALID_REGISTERS"
  | "INVALID_RANK"
  | "INVALID_STATE"
  | "INCOMPATIBLE_COUNTERS"
  | "COUNTER_NOT_FOUND"
  | "SNAPSHOT_NOT_FOUND"
  | "CONFLICT"
  | "BAD_REQUEST"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}
