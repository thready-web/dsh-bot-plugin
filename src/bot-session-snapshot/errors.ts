export class SnapshotError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
    this.name = 'SnapshotError'
  }
}

export function validation(message: string) {
  return new SnapshotError(400, 'VALIDATION', message)
}

export function forbidden(message: string) {
  return new SnapshotError(403, 'FORBIDDEN', message)
}

export function notFound(message: string) {
  return new SnapshotError(404, 'NOT_FOUND', message)
}

export function conflict(message: string) {
  return new SnapshotError(409, 'CONFLICT', message)
}

export function unavailable(message: string) {
  return new SnapshotError(503, 'UNAVAILABLE', message)
}

export function corrupt(message: string) {
  return new SnapshotError(409, 'CORRUPT', message)
}
