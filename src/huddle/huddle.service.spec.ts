import { ConfigService } from '@nestjs/config'
import { HuddleService } from './huddle.service'

describe('HuddleService', () => {
  const now = new Date('2026-06-09T00:00:00.000Z')

  const messageService = {
    assertRealtimeChannelAccess: jest.fn(),
    assertRealtimeConversationAccess: jest.fn(),
  }

  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'LIVEKIT_URL') return 'ws://localhost:7880'
      if (key === 'LIVEKIT_API_KEY') return 'devkey'
      if (key === 'LIVEKIT_API_SECRET')
        return 'dev-secret-please-change-me-1234567890'
      return undefined
    }),
  } as unknown as ConfigService

  const broadcastService = {
    broadcastState: jest.fn(),
  }

  const chatBroadcastService = {
    broadcastMessage: jest.fn(),
    broadcastMessageUpdated: jest.fn(),
  }

  const createDbMock = () => {
    const selectBuilder = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn(),
    }

    const updateSessionBuilder = {
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      returning: jest.fn(),
    }

    const updateParticipantBuilder = {
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
    }

    return {
      query: {
        huddleSessions: {
          findFirst: jest.fn(),
          findMany: jest.fn(),
        },
        huddleParticipants: {
          findMany: jest.fn(),
        },
      },
      select: jest.fn(() => selectBuilder),
      update: jest
        .fn()
        .mockReturnValueOnce(updateSessionBuilder)
        .mockReturnValueOnce(updateParticipantBuilder),
      insert: jest.fn(),
      __selectBuilder: selectBuilder,
      __updateSessionBuilder: updateSessionBuilder,
      __updateParticipantBuilder: updateParticipantBuilder,
    }
  }

  const makeSession = (overrides: Partial<any> = {}) => ({
    id: 'session-1',
    workspaceId: 'workspace-1',
    entityType: 'channel',
    entityId: 'channel-1',
    roomName: 'huddle:workspace-1:channel:channel-1',
    entityActiveKey: 'workspace-1:channel:channel-1',
    status: 'pending',
    startedById: 'user-1',
    startedAt: new Date('2026-06-08T23:40:00.000Z'),
    endedAt: null,
    lastActivityAt: new Date('2026-06-08T23:40:00.000Z'),
    createdAt: new Date('2026-06-08T23:40:00.000Z'),
    updatedAt: new Date('2026-06-08T23:40:00.000Z'),
    ...overrides,
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('parses huddle room names safely', () => {
    const db = createDbMock()
    const service = new HuddleService(
      db as any,
      messageService as any,
      configService,
      broadcastService as any,
      chatBroadcastService as any,
    )

    expect(
      (service as any).parseRoomName('huddle:workspace-1:channel:channel-1'),
    ).toEqual({
      workspaceId: 'workspace-1',
      entityType: 'channel',
      entityId: 'channel-1',
    })
    expect((service as any).parseRoomName('not-a-room')).toBeNull()
    expect(
      (service as any).parseRoomName('huddle:workspace-1:invalid:x'),
    ).toBeNull()
  })

  it('ends stale pending sessions before state is read', async () => {
    const db = createDbMock()
    db.query.huddleSessions.findFirst.mockResolvedValueOnce(
      makeSession({
        status: 'pending',
        startedAt: new Date('2026-06-08T23:30:00.000Z'),
        lastActivityAt: new Date('2026-06-08T23:30:00.000Z'),
      }),
    )
    db.__updateSessionBuilder.returning.mockResolvedValueOnce([
      makeSession({
        status: 'ended',
        endedAt: now,
        entityActiveKey: null,
        lastActivityAt: now,
      }),
    ])

    const service = new HuddleService(
      db as any,
      messageService as any,
      configService,
      broadcastService as any,
      chatBroadcastService as any,
    )

    const result = await (service as any).cleanupOpenSessionIfStale(
      {
        workspaceId: 'workspace-1',
        entityType: 'channel',
        entityId: 'channel-1',
      },
      now,
    )

    expect(result).toBeNull()
    expect(db.update).toHaveBeenCalledTimes(2)
    expect(db.__updateSessionBuilder.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ended',
        endedAt: now,
        entityActiveKey: null,
      }),
    )
  })
})
