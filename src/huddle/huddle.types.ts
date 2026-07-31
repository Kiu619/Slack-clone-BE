export type HuddleEntityType = 'channel' | 'dm'

export type HuddleSessionStatus = 'pending' | 'active' | 'ended'

export interface HuddleTarget {
  workspaceId: string
  entityType: HuddleEntityType
  entityId: string
}

export interface HuddleParticipantSnapshot {
  id: string
  sessionId: string
  userId: string
  email: string | null
  name: string | null
  displayName: string | null
  avatar: string | null
  membershipStatus: 'active' | 'deactivated'
  joinedAt: string
  leftAt: string | null
  isMuted: boolean
  isCameraOn: boolean
  isScreenSharing: boolean
  isSpeaking: boolean
}

export interface HuddleSessionSnapshot {
  id: string
  workspaceId: string
  entityType: HuddleEntityType
  entityId: string
  roomName: string
  entityActiveKey: string | null
  feedMessageId: string | null
  status: HuddleSessionStatus
  startedById: string | null
  startedAt: string
  endedAt: string | null
  lastActivityAt: string
  participantCount: number
  activeParticipantCount: number
  participants: HuddleParticipantSnapshot[]
  topic: string | null
}

export interface HuddleMessageSnapshot extends HuddleSessionSnapshot {
  entityLabel: string | null
}

export interface HuddleStateSnapshot {
  activeSession: HuddleSessionSnapshot | null
  recentSessions: HuddleSessionSnapshot[]
}

export interface HuddleJoinResponse {
  livekitUrl: string
  token: string
  session: HuddleSessionSnapshot
}
