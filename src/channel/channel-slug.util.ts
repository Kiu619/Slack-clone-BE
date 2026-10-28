/**
 * Channel name validation & slug helpers — isomorphic.
 *
 * Mirror của `slack-clone/src/lib/channel-slug.ts`. Dùng chung ở BE để
 * defense-in-depth: kể cả khi FE bị bypass, BE vẫn từ chối tên không
 * hợp lệ trước khi truy vấn DB.
 *
 * Allowlist ký tự hợp lệ: bất kỳ chữ cái hoặc chữ số Unicode (\p{L}\p{N}),
 * dấu gạch ngang (-), và khoảng trắng ( ). KHÔNG cho phép `_`, emoji, ký
 * tự điều khiển, ký tự zero-width, ký hiệu đặc biệt.
 */

export const CHANNEL_NAME_MIN = 2
export const CHANNEL_NAME_MAX = 80

const ALLOWED_NAME_CHARS = /[\p{L}\p{N}\- ]/u

export function slugifyChannelName(raw: string): string {
  return raw.toLowerCase().trim().replace(/\s+/g, '-')
}

export function isValidChannelName(raw: string): boolean {
  const v = raw.trim()
  if (v.length < CHANNEL_NAME_MIN || v.length > CHANNEL_NAME_MAX) return false
  for (const ch of v) {
    if (!ALLOWED_NAME_CHARS.test(ch)) return false
  }
  return true
}

export function getChannelNameError(raw: string): string | null {
  const v = raw.trim()
  if (v.length === 0) return 'Channel name cannot be empty'
  if (v.length < CHANNEL_NAME_MIN) {
    return `Channel name must be at least ${CHANNEL_NAME_MIN} characters`
  }
  if (v.length > CHANNEL_NAME_MAX) {
    return `Channel name must be at most ${CHANNEL_NAME_MAX} characters`
  }
  for (const ch of v) {
    if (!ALLOWED_NAME_CHARS.test(ch)) {
      return 'Channel name can only contain letters, numbers, hyphens and spaces'
    }
  }
  return null
}
