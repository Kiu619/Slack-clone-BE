import { z } from 'zod'

export const HuddleEntityTypeFilterSchema = z.enum(['all', 'channel', 'dm'])
export type HuddleEntityTypeFilter = z.infer<
  typeof HuddleEntityTypeFilterSchema
>

export const HuddleStatusFilterSchema = z.enum(['all', 'active', 'ended'])
export type HuddleStatusFilter = z.infer<typeof HuddleStatusFilterSchema>

export const HuddleSortBySchema = z.enum(['recent', 'participants'])
export type HuddleSortBy = z.infer<typeof HuddleSortBySchema>

/**
 * Parse CSV string or array into string array.
 * Handles both formats: "id1,id2,id3" or ["id1,id2", "id3"]
 */
function csvToArray(value: unknown): string[] {
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

export const GetWorkspaceHuddlesQuerySchema = z.object({
  filter_entityTypes: HuddleEntityTypeFilterSchema.optional().default('all'),
  filter_channelIds: z.preprocess(csvToArray, z.array(z.string()).optional()),
  filter_conversationIds: z.preprocess(
    csvToArray,
    z.array(z.string()).optional(),
  ),
  filter_participantIds: z.preprocess(
    csvToArray,
    z.array(z.string()).optional(),
  ),
  sort: HuddleSortBySchema.optional().default('recent'),
  status: HuddleStatusFilterSchema.optional().default('all'),
  missedOnly: z.coerce.boolean().optional().default(false),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).optional().default(20),
})

export type GetWorkspaceHuddlesQuery = z.infer<
  typeof GetWorkspaceHuddlesQuerySchema
>

// DTO for Recent Huddles - only ended huddles
export const GetRecentHuddlesQuerySchema = z.object({
  // Type filter: 'all' = all ended huddles, 'missed' = ended huddles user didn't attend
  type: z.enum(['all', 'missed']).optional().default('all'),
  // Channel/DM filter
  filter_entityTypes: HuddleEntityTypeFilterSchema.optional().default('all'),
  filter_channelIds: z.preprocess(csvToArray, z.array(z.string()).optional()),
  filter_conversationIds: z.preprocess(
    csvToArray,
    z.array(z.string()).optional(),
  ),
  // Participant filter (only for 'all' type)
  filter_participantIds: z.preprocess(
    csvToArray,
    z.array(z.string()).optional(),
  ),
  // Sort
  sort: HuddleSortBySchema.optional().default('recent'),
  // Pagination
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).optional().default(20),
})

export type GetRecentHuddlesQuery = z.infer<typeof GetRecentHuddlesQuerySchema>
