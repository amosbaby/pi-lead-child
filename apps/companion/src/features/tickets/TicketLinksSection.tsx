import {
  Button, canCopyText, Column, copyText, FactList, Link, Row, Text, type FactItem,
} from '@pi-lead-child/components';
import type { TicketAction, TicketLinks, TicketMeta } from '@pi-lead-child/protocol';
import { useState } from 'react';

import { useLocale, useMessages } from '@/i18n';

import {
  complexityLabel, handlingLabel, idleClaimHours, LINK_PROTOCOLS, sessionPresentation, sourcePresentation,
} from './ticketLinks';
import { ticketLinksMessages } from './ticketLinks.messages';

type Handling = 'auto' | 'needs_user';

export type TicketLinksSectionProps = {
  links: TicketLinks;
  // 列表接口给的这张单的事实（处理方式、复杂度、领取人）。旧 daemon 没有时为 null，只画来源和会话。
  meta: TicketMeta | null;
  // 操作清单里的 ticket.set_handling：能不能点、为什么不能点都按它（user_direct，只有你本人能改）。
  handlingAction: TicketAction | null;
  // 有操作正在做（同组的按钮停用，设计规范 P5.4）。
  busy: boolean;
  // 正在改处理方式。
  settingHandling: boolean;
  onSetHandling?: (handling: Handling) => void;
};

// 「来源与会话」块的内容（工单详情，external-worker-hub Task 10）：来源、处理方式和理由、复杂度、领取人、会话。
// 一行一样，和「工单信息」同一种名字和值的对照（FactList labeled）。链接只认 https: 和 claude:，别的地址照原样写成文字。
export function TicketLinksSection({ links, meta, handlingAction, busy, settingHandling, onSetHandling }: TicketLinksSectionProps) {
  const locale = useLocale();
  const m = useMessages(ticketLinksMessages);

  const sources = links.sources.map((source) => sourcePresentation(source, locale));
  const sourceFact: FactItem = {
    label: m.source,
    value: sources.length === 0 ? m.noSource : (
      <Column testID="ticket-links-sources" gap="text-stack">
        {sources.map((source) => source.href ? (
          <Link key={source.key} testID={`ticket-source-${source.key}`} href={source.href} protocols={LINK_PROTOCOLS} size="body">{source.label}</Link>
        ) : (
          <Text key={source.key} testID={`ticket-source-${source.key}`} size="body">{source.text}</Text>
        ))}
      </Column>
    ),
  };

  // 处理方式：要你拿主意的（还没判断的也按要你拿主意算）给「改成自动处理」，自动的给「改成交给我」。
  const handling = meta?.handling ?? null;
  const target: Handling = handling === 'auto' ? 'needs_user' : 'auto';
  const unavailable = handlingAction && !handlingAction.available ? handlingAction.reason : null;
  const handlingDetail = [links.handlingReason, unavailable].filter(Boolean).join(' ');
  const handlingFact: FactItem | null = meta ? {
    label: m.handling,
    value: handlingLabel(handling, locale),
    ...(handlingDetail ? { detail: handlingDetail } : {}),
    ...(handlingAction && onSetHandling ? {
      action: {
        label: settingHandling ? m.working : target === 'auto' ? m.makeAuto : m.makeNeedsUser,
        onPress: () => onSetHandling(target),
        disabled: busy || !handlingAction.available,
        testID: target === 'auto' ? 'ticket-handling-auto' : 'ticket-handling-needs-user',
      },
    } : {}),
  } : null;

  const complexity = complexityLabel(meta?.complexity ?? null, locale);
  const idle = idleClaimHours(meta);
  const claimFact: FactItem | null = meta ? {
    label: m.claimedBy,
    value: meta.claimedBy ? (meta.claimMode === 'auto' ? m.claimedAuto(meta.claimedBy) : meta.claimedBy) : m.nobody,
    ...(idle !== null ? { detail: m.idle(idle) } : {}),
  } : null;

  const sessions = links.sessions.map((session, index) => sessionPresentation(session, index, locale));
  const sessionFact: FactItem = {
    label: m.session,
    value: sessions.length === 0 ? m.noSession : (
      <Column testID="ticket-links-sessions" gap="text-stack">
        {sessions.map((session) => session.kind === 'link' ? (
          <Link key={session.key} testID="ticket-session-link" href={session.href} protocols={LINK_PROTOCOLS} size="body">{session.label}</Link>
        ) : session.kind === 'resume' ? (
          <ResumeCommand key={session.key} command={session.command} />
        ) : (
          <Text key={session.key} testID="ticket-session-text" size="body">{session.text}</Text>
        ))}
      </Column>
    ),
  };

  const items = [
    sourceFact,
    ...(handlingFact ? [handlingFact] : []),
    ...(complexity ? [{ label: m.complexity, value: complexity }] : []),
    ...(claimFact ? [claimFact] : []),
    sessionFact,
  ];
  return <FactList testID="ticket-links" variant="labeled" items={items} />;
}

// 会话只有 id：写出接着这个会话的命令，旁边一个复制按钮（原生应用里还没有剪贴板，不给按钮）。
function ResumeCommand({ command }: { command: string }) {
  const m = useMessages(ticketLinksMessages);
  const [copied, setCopied] = useState(false);
  return (
    <Row items="baseline" gap="inline-item" flexWrap="wrap">
      <Text testID="ticket-session-resume" size="code" mono>{command}</Text>
      {canCopyText ? (
        <Button
          testID="ticket-session-copy"
          label={copied ? m.copied : m.copy}
          variant="link"
          tone="accent"
          size="xs"
          onPress={() => { void copyText(command).then(setCopied); }}
        />
      ) : null}
    </Row>
  );
}
