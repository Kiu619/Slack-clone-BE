import { validateAuthConfig } from './auth-config.validation'

describe('validateAuthConfig', () => {
  it('uses safe auth lifecycle defaults', () => {
    expect(validateAuthConfig({})).toMatchObject({
      AUTH_ACCESS_TTL_SECONDS: 900,
      AUTH_REFRESH_TTL_SECONDS: 2_592_000,
      AUTH_ROTATE_WINDOW_SECONDS: 86_400,
      AUTH_SOCKET_REVALIDATION_SECONDS: 60,
    })
  })

  it.each([
    ['AUTH_ACCESS_TTL_SECONDS', '15m'],
    ['AUTH_REFRESH_TTL_SECONDS', '0'],
    ['AUTH_ROTATE_WINDOW_SECONDS', '-1'],
    ['AUTH_SOCKET_REVALIDATION_SECONDS', '9'],
  ])('rejects invalid %s', (key, value) => {
    expect(() => validateAuthConfig({ [key]: value })).toThrow()
  })

  it('rejects incompatible TTL boundaries', () => {
    expect(() =>
      validateAuthConfig({
        AUTH_ACCESS_TTL_SECONDS: '300',
        AUTH_REFRESH_TTL_SECONDS: '300',
      }),
    ).toThrow('AUTH_ACCESS_TTL_SECONDS must be smaller')
    expect(() =>
      validateAuthConfig({
        AUTH_ACCESS_TTL_SECONDS: '60',
        AUTH_REFRESH_TTL_SECONDS: '300',
        AUTH_ROTATE_WINDOW_SECONDS: '300',
      }),
    ).toThrow('AUTH_ROTATE_WINDOW_SECONDS must be smaller')
  })
})
