export { AVATAR_IDS, EYE_COLOR, presenceColor, avatarIdFor, readPresenceEngine, PRESENCE_COLORS } from './catalog.ts'
export type { AvatarId } from './catalog.ts'
export {
  completionActive,
  derivePresence,
  isBlocked,
  isThinking,
  isWaiting,
  isWorking,
  nextSettledAt,
  presenceState,
} from './derive.ts'
export type { SettledStamp } from './derive.ts'
export { DONE_WINDOW_MS } from './types.ts'
export type {
  PresenceEngine,
  PresenceMood,
  PresenceSegment,
  PresenceSource,
  PresenceState,
  PresenceThread,
  PresenceView,
} from './types.ts'
