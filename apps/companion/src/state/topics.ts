// Topics (protocol's topics.ts): how the turns of a topic sit in the control-plane store.
// A topic is its own session there (messageIdsBySession, turnIdsBySession), so the message entities, parts and
// streams are the same as in the main conversation, and the same components draw them. The main conversation never
// lists these messages: it reads the Lead session's id only.
import type { GatewayEvent } from '@pi-lead-child/protocol';

export const TOPIC_SESSION_PREFIX = 'topic:';

export function topicSessionId(topicId: number): string {
  return `${TOPIC_SESSION_PREFIX}${topicId}`;
}

export function isTopicSessionId(sessionId: string | null | undefined): boolean {
  return typeof sessionId === 'string' && sessionId.startsWith(TOPIC_SESSION_PREFIX);
}

/** The topic of a turn event (lead.* with topicId in the payload), or null for an event of the main conversation. */
export function topicIdOfEvent(event: Pick<GatewayEvent, 'type' | 'payload'>): number | null {
  if (!event.type.startsWith('lead.')) return null;
  const id = event.payload.topicId;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
}
