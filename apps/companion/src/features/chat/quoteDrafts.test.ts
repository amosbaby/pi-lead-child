// 还没发出的引用（设计规范 P17.4–P17.6）：一段一段加进托盘，改托盘里的一条，发送时连手上那段一起带上。
import { describe, expect, it } from 'vitest';

import { createQuoteDraftStore } from './quoteDrafts';

const lead = { kind: 'turn' as const, turnId: 'turn-a', role: 'assistant' as const };

describe('quote drafts', () => {
  it('adds a quote to the tray on commit, keeping the order quotes were added', () => {
    const store = createQuoteDraftStore();
    store.getState().begin({ source: lead, text: '第一段' });
    store.getState().setPendingNote('说明一');
    store.getState().commit();
    store.getState().begin({ source: lead, text: '第二段' });
    store.getState().commit();
    expect(store.getState().drafts.map((draft) => [draft.text, draft.note])).toEqual([['第一段', '说明一'], ['第二段', '']]);
    expect(store.getState().pending).toBeNull();
  });

  it('stows the quote in hand when another one begins, so nothing typed is lost', () => {
    const store = createQuoteDraftStore();
    store.getState().begin({ source: lead, text: '第一段' });
    store.getState().setPendingNote('已经打的字');
    store.getState().begin({ source: lead, text: '第二段' });
    expect(store.getState().drafts).toEqual([expect.objectContaining({ text: '第一段', note: '已经打的字' })]);
    expect(store.getState().pending).toMatchObject({ text: '第二段', note: '', editingId: null });
  });

  it('edits a tray quote in place and keeps it when the edit is cancelled', () => {
    const store = createQuoteDraftStore();
    store.getState().begin({ source: lead, text: '第一段' });
    store.getState().commit();
    const id = store.getState().drafts[0]!.id;
    store.getState().edit(id);
    store.getState().setPendingNote('新说明');
    store.getState().setPendingText('第一');
    store.getState().commit();
    expect(store.getState().drafts).toEqual([expect.objectContaining({ id, text: '第一', note: '新说明' })]);
    store.getState().edit(id);
    store.getState().setPendingNote('不要了');
    store.getState().cancel();
    expect(store.getState().drafts[0]).toMatchObject({ note: '新说明' });
  });

  it('removes a quote, and drops its edit if it was being edited', () => {
    const store = createQuoteDraftStore();
    store.getState().begin({ source: lead, text: '第一段' });
    store.getState().commit();
    const id = store.getState().drafts[0]!.id;
    store.getState().edit(id);
    store.getState().remove(id);
    expect(store.getState().drafts).toEqual([]);
    expect(store.getState().pending).toBeNull();
  });

  it('sends the tray and the quote in hand together, without empty notes, then clears', () => {
    const store = createQuoteDraftStore();
    store.getState().begin({ source: lead, text: '第一段', anchor: 's0:b1' });
    store.getState().setPendingNote('  能调吗 ');
    store.getState().commit();
    store.getState().begin({ source: { kind: 'card', cardId: 3 }, text: '对方的话' });
    expect(store.getState().take()).toEqual([
      { source: lead, text: '第一段', note: '能调吗', anchor: 's0:b1' },
      { source: { kind: 'card', cardId: 3 }, text: '对方的话' },
    ]);
    expect(store.getState()).toMatchObject({ drafts: [], pending: null });
  });
});
