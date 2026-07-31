import { z } from 'zod'

const MESSAGE_HAS_FILTERS = ['file', 'link', 'reaction'] as const
const MESSAGE_IS_FILTERS = ['dm', 'thread', 'saved', 'pinned'] as const
const MESSAGE_TYPE_FILTERS = [
  'documents',
  'spreadsheets',
  'presentations',
  'pdfs',
  'audio',
  'images',
  'videos',
  'snippets',
] as const

function csvToArray(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => (typeof item === 'string' ? item.split(',') : []))
      .map((item) => item.trim())
      .filter(Boolean)
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}

function optionalTrimmedString(value: unknown) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export const SearchWorkspaceMessagesSchema = z.object({
  q: z.preprocess(optionalTrimmedString, z.string().optional()),
  fromUserIds: z.preprocess(csvToArray, z.array(z.uuid()).default([])),
  withUserIds: z.preprocess(csvToArray, z.array(z.uuid()).default([])),
  channelIds: z.preprocess(csvToArray, z.array(z.uuid()).default([])),
  conversationIds: z.preprocess(csvToArray, z.array(z.uuid()).default([])),
  has: z.preprocess(
    csvToArray,
    z.array(z.enum(MESSAGE_HAS_FILTERS)).default([]),
  ),
  is: z.preprocess(csvToArray, z.array(z.enum(MESSAGE_IS_FILTERS)).default([])),
  types: z.preprocess(
    csvToArray,
    z.array(z.enum(MESSAGE_TYPE_FILTERS)).default([]),
  ),
  afterDate: z.preprocess(optionalTrimmedString, z.string().optional()),
  beforeDate: z.preprocess(optionalTrimmedString, z.string().optional()),
  sort: z.enum(['relevance', 'newest', 'oldest']).default('relevance'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
})

export type SearchWorkspaceMessagesDto = z.infer<
  typeof SearchWorkspaceMessagesSchema
>
