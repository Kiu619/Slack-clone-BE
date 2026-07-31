const OFFICE_PREVIEW_CATEGORIES = new Set([
  'document',
  'presentation',
  'spreadsheet',
])

export function supportsOfficeThumbnail(category: string | null | undefined) {
  return category != null && OFFICE_PREVIEW_CATEGORIES.has(category)
}
