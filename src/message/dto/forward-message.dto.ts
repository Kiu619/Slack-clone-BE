import { z } from 'zod'

const destinationChannelSchema = z.object({
  type: z.literal('channel'),
  channelId: z.string().uuid(),
})

const destinationConversationSchema = z.object({
  type: z.literal('conversation'),
  conversationId: z.string().uuid(),
})

export const ForwardMessageSchema = z.object({
  destinations: z
    .array(z.discriminatedUnion('type', [destinationChannelSchema, destinationConversationSchema]))
    .min(1, 'Select at least one destination')
    .max(50, 'Too many destinations'),
  /** Optional HTML from client editor (same trust model as create message) */
  commentary: z.string().max(40000).optional(),
})

export type ForwardMessageDto = z.infer<typeof ForwardMessageSchema>
