// 还没发出的引用（设计规范 P17.4–P17.6）。一条消息可以带好几段，按加入的顺序；发出以后清空。
//   · drafts：收进托盘的引用（桌面浮层里按 Enter，手机上点「加上」或者又引用了一段）。
//   · pending：正在写说明的那一段。桌面是锚定在原文下方的浮层，手机是输入框里的「正在引用」。editingId 不为空时
//     改的是托盘里的那一条（点原文上的标记或托盘里那一行回到这里，P17.4）。
//   · activeId：悬停的那一条（桌面上原文的标记和托盘里的那一行互相指认）。
// 只在这台设备上，不存盘：刷新页面以后没发的引用就没了，和选区一样。
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import { CHAT_QUOTE_MAX_COUNT, type ChatQuoteInput, type ChatQuoteSource } from '@pi-lead-child/protocol';

export interface QuoteDraft {
  id: string;
  source: ChatQuoteSource;
  text: string;
  note: string;
  anchor?: string;
  // 手机上整段引用时那一段的全文：展开「正在引用」时在它里面改范围（Q-5）。桌面选字没有它。
  context?: string;
}

export interface PendingQuote extends Omit<QuoteDraft, 'id'> {
  // 改托盘里的一条时是它的 id；新的一段没有。
  editingId: string | null;
}

export interface QuoteDraftState {
  drafts: QuoteDraft[];
  pending: PendingQuote | null;
  activeId: string | null;
  // 开始引用一段（选区上的「回复」、手机上右滑或长按）。手上已经有一段在写说明时，它先收进托盘，什么都不丢（P17.5）。
  begin(quote: Omit<QuoteDraft, 'id' | 'note'> & { note?: string }): void;
  // 改托盘里的一条：把它提到 pending。
  edit(id: string): void;
  setPendingText(text: string): void;
  setPendingNote(note: string): void;
  // 收进托盘（新的一段）或保存（改的那一条）。说明可以不写。
  commit(): void;
  // 取消 pending：新的一段丢掉，改的那一条照旧留在托盘里。
  cancel(): void;
  remove(id: string): void;
  setActive(id: string | null): void;
  // 发送时用：托盘里的，加上手上还在写的那一段（它也算，P17.5），按加入的顺序。取完清空。
  take(): ChatQuoteInput[];
  clear(): void;
}

let nextId = 0;
const newId = () => `quote-${Date.now().toString(36)}-${(nextId++).toString(36)}`;

export function createQuoteDraftStore() {
  return createStore<QuoteDraftState>()((set, get) => {
    const stow = (state: QuoteDraftState): QuoteDraft[] => {
      const pending = state.pending;
      if (!pending) return state.drafts;
      const { editingId, ...draft } = pending;
      if (editingId) return state.drafts.map((item) => (item.id === editingId ? { ...draft, id: editingId } : item));
      if (state.drafts.length >= CHAT_QUOTE_MAX_COUNT) return state.drafts;
      return [...state.drafts, { ...draft, id: newId() }];
    };
    return {
      drafts: [],
      pending: null,
      activeId: null,
      begin: (quote) => set((state) => ({
        drafts: stow(state),
        pending: {
          source: quote.source, text: quote.text, note: quote.note ?? '', editingId: null,
          ...(quote.anchor ? { anchor: quote.anchor } : {}), ...(quote.context ? { context: quote.context } : {}),
        },
      })),
      edit: (id) => set((state) => {
        const drafts = stow(state);
        const draft = drafts.find((item) => item.id === id);
        if (!draft) return { drafts };
        const { id: editingId, ...rest } = draft;
        return { drafts, pending: { ...rest, editingId }, activeId: id };
      }),
      setPendingText: (text) => set((state) => (state.pending ? { pending: { ...state.pending, text } } : {})),
      setPendingNote: (note) => set((state) => (state.pending ? { pending: { ...state.pending, note } } : {})),
      commit: () => set((state) => ({ drafts: stow(state), pending: null })),
      cancel: () => set({ pending: null }),
      remove: (id) => set((state) => ({
        drafts: state.drafts.filter((item) => item.id !== id),
        pending: state.pending?.editingId === id ? null : state.pending,
        activeId: state.activeId === id ? null : state.activeId,
      })),
      setActive: (activeId) => { if (get().activeId !== activeId) set({ activeId }); },
      take: () => {
        const drafts = stow(get());
        set({ drafts: [], pending: null, activeId: null });
        return drafts.map(({ source, text, note, anchor }) => ({
          source, text, ...(note.trim() ? { note: note.trim() } : {}), ...(anchor ? { anchor } : {}),
        }));
      },
      clear: () => set({ drafts: [], pending: null, activeId: null }),
    };
  });
}

export type QuoteDraftStore = ReturnType<typeof createQuoteDraftStore>;

// Lead 的会话只有一个输入框，一份就够。工单对话不能引用（只有 Lead 的会话收引用）。
export const quoteDrafts: QuoteDraftStore = createQuoteDraftStore();

export function useQuoteDrafts<T>(select: (state: QuoteDraftState) => T): T {
  return useStore(quoteDrafts, select);
}
