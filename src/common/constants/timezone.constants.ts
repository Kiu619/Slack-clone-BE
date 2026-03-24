/**
 * Giá trị timezone hợp lệ — khớp với TIMEZONE_OPTIONS ở frontend.
 */
export const TIMEZONE_VALUES = [
  '(UTC-11:00)',
  '(UTC-10:00)',
  '(UTC-09:00)',
  '(UTC-08:00)',
  '(UTC-07:00)',
  '(UTC-06:00)',
  '(UTC-05:00)',
  '(UTC-04:00)',
  '(UTC-03:00)',
  '(UTC-02:00)',
  '(UTC-01:00)',
  '(UTC+00:00)',
  '(UTC+01:00)',
  '(UTC+02:00)',
  '(UTC+03:00)',
  '(UTC+04:00)',
  '(UTC+05:00)',
  '(UTC+06:00)',
  '(UTC+07:00)',
  '(UTC+08:00)',
  '(UTC+09:00)',
  '(UTC+10:00)',
  '(UTC+11:00)',
  '(UTC+12:00)',
  '(UTC+13:00)',
  '(UTC+14:00)',
] as const

export function isValidTimeZoneValue(value: string): boolean {
  return TIMEZONE_VALUES.includes(value as (typeof TIMEZONE_VALUES)[number])
}
