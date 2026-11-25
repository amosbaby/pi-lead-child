import { Column, Dot, Icon, Pressable, Row, Text } from '@pi-lead-child/components';
import type { TopicDto } from '@pi-lead-child/protocol';

import { useMessages } from '@/i18n';
import { useWorkspaceStore } from '@/state/CompanionStateProvider';
import { useTopics } from '@/state/hooks';

import { useTopicHasNewReply } from './TopicReferences';
import { topicsMessages } from './topics.messages';
import { useOpenTopic } from './useOpenTopic';

// The open topics in the work rail (design rules P18, theme 11.26). This is the lasting way back to a topic: the
// place on the right holds one thing at a time (P16.2), so a ticket detail or the views can take it from a topic.
// One line per topic. The group is not drawn when there is no open topic.
export function RailTopics() {
  const m = useMessages(topicsMessages);
  const topics = useTopics().filter((topic) => topic.state === 'open');
  if (!topics.length) return null;
  return (
    <Column testID="rail-topics" w="100%" pt="page-section">
      <Row items="center" gap="inline-item" px="section-label-x" pt="section-label-top" pb="section-label-bottom">
        <Text size="eyebrow" weight="extrabold" letterSpacing={0.3} tone="secondary">{m.railTitle}</Text>
        <Text size="meta" weight="bold" tone="muted">{String(topics.length)}</Text>
      </Row>
      {topics.map((topic) => <RailTopicRow key={topic.id} topic={topic} />)}
    </Column>
  );
}

function RailTopicRow({ topic }: { topic: TopicDto }) {
  const m = useMessages(topicsMessages);
  const open = useOpenTopic();
  const active = useWorkspaceStore((state) => state.topicOpenId === topic.id);
  const fresh = useTopicHasNewReply(topic);
  return (
    <Pressable
      testID={`rail-topic-${topic.id}`}
      aria-label={m.openTopic(topic.title)}
      aria-pressed={active}
      onPress={() => open(topic.id)}
      feedback="opacity"
      w="100%"
    >
      <Row items="center" gap="icon-label" px="section-label-x" py="list-row" minW={0}>
        <Icon name="branch" size={14} color={active ? 'accent-strong' : 'text-secondary'} />
        <Text flex={1} minW={0} size="body" weight={active ? 'semibold' : 'regular'} tone={active ? 'accent' : 'strong'} numberOfLines={1}>
          {topic.title}
        </Text>
        {fresh ? <Dot color="accent" /> : null}
      </Row>
    </Pressable>
  );
}
