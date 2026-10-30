const DEFAULT_ACCESS_TTL_SECONDS = 15 * 60
const DEFAULT_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60
const DEFAULT_ROTATE_WINDOW_SECONDS = 24 * 60 * 60
const DEFAULT_SOCKET_REVALIDATION_SECONDS = 60
const MIN_SOCKET_REVALIDATION_SECONDS = 10

function positiveInteger(name: string, value: unknown, fallback: number): number {
  const raw = value == null || value === '' ? fallback : Number(value)
  if (!Number.isSafeInteger(raw) || raw <= 0) {
    throw new Error(`${name} must be a positive integer number of seconds`)
  }
  return raw
}

export function validateAuthConfig(config: Record<string, unknown>) {
  const access = positiveInteger('AUTH_ACCESS_TTL_SECONDS', config.AUTH_ACCESS_TTL_SECONDS, DEFAULT_ACCESS_TTL_SECONDS)
  const refresh = positiveInteger('AUTH_REFRESH_TTL_SECONDS', config.AUTH_REFRESH_TTL_SECONDS, DEFAULT_REFRESH_TTL_SECONDS)
  const rotateWindow = positiveInteger('AUTH_ROTATE_WINDOW_SECONDS', config.AUTH_ROTATE_WINDOW_SECONDS, DEFAULT_ROTATE_WINDOW_SECONDS)
  const socketRevalidation = positiveInteger('AUTH_SOCKET_REVALIDATION_SECONDS', config.AUTH_SOCKET_REVALIDATION_SECONDS, DEFAULT_SOCKET_REVALIDATION_SECONDS)

  if (access >= refresh) throw new Error('AUTH_ACCESS_TTL_SECONDS must be smaller than AUTH_REFRESH_TTL_SECONDS')
  if (rotateWindow >= refresh) throw new Error('AUTH_ROTATE_WINDOW_SECONDS must be smaller than AUTH_REFRESH_TTL_SECONDS')
  if (socketRevalidation < MIN_SOCKET_REVALIDATION_SECONDS) throw new Error(`AUTH_SOCKET_REVALIDATION_SECONDS must be at least ${MIN_SOCKET_REVALIDATION_SECONDS}`)

  return {
    ...config,
    AUTH_ACCESS_TTL_SECONDS: access,
    AUTH_REFRESH_TTL_SECONDS: refresh,
    AUTH_ROTATE_WINDOW_SECONDS: rotateWindow,
    AUTH_SOCKET_REVALIDATION_SECONDS: socketRevalidation,
  }
}
