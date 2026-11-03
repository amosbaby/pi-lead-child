import { ActionLink, PopoverPanel, type PopoverAnchor } from '@pi-lead-child/components';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { useControlPlaneStore } from '../../state/CompanionStateProvider';
import { useTicketRef } from '../genui/useTicketRef';
import { ObjectLinkRenderer, ObjectLinkText, type ObjectLinkProps } from './ObjectLink';

// 文字里对象链接的实现（P14.7）。应用的根放一个：
// - 工单（含提醒）：点了打开工单详情，提醒打开日程（和卡片里的 TicketRef 一样）。
// - 外来消息卡：点了在锚定浮层里打开那张卡。浮层画在这里，不画在文字里面。
// 对象取不到时只显示文字（P14.8）。

type CardHost = (cardId: number, label: string, anchor: PopoverAnchor) => void;

const CardHostContext = createContext<CardHost | null>(null);

// renderCard：浮层里画那张卡（应用的根传 ChannelCardSlot）。
export function ObjectLinkProvider({ renderCard, children }: { renderCard: (cardId: number) => ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState<{ cardId: number; label: string; anchor: PopoverAnchor } | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const host = useCallback<CardHost>((cardId, label, anchor) => setOpen({ cardId, label, anchor }), []);
  const render = useMemo(() => (props: ObjectLinkProps) => (
    props.target.kind === 'ticket'
      ? <TicketLink {...props} ticketId={props.target.id} />
      : <CardLink {...props} cardId={props.target.id} />
  ), []);
  return (
    <CardHostContext.Provider value={host}>
      <ObjectLinkRenderer.Provider value={render}>
        {children}
        <PopoverPanel testID="object-link-card" anchor={open?.anchor ?? null} onClose={close} label={open?.label ?? ''} width={420}>
          {open ? renderCard(open.cardId) : null}
        </PopoverPanel>
      </ObjectLinkRenderer.Provider>
    </CardHostContext.Provider>
  );
}

function TicketLink({ ticketId, ...props }: ObjectLinkProps & { ticketId: number }) {
  const ref = useTicketRef(ticketId);
  if (ref.missing) return <ObjectLinkText {...props} />;
  return (
    <ActionLink testID={`object-link-ticket-${ticketId}`} underline="hover" size={props.size} weight={props.weight} italic={props.italic} onPress={ref.open}>
      {props.text}
    </ActionLink>
  );
}

function CardLink({ cardId, ...props }: ObjectLinkProps & { cardId: number }) {
  const open = useContext(CardHostContext);
  const known = useControlPlaneStore((state) => state.channelCards.some((card) => card.id === cardId));
  if (!open || !known) return <ObjectLinkText {...props} />;
  return (
    <ActionLink
      testID={`object-link-card-${cardId}`}
      underline="hover"
      size={props.size}
      weight={props.weight}
      italic={props.italic}
      // 浮层在链接的下面打开，左边和链接对齐。
      onPress={(box) => open(cardId, props.text, box)}
    >
      {props.text}
    </ActionLink>
  );
}
