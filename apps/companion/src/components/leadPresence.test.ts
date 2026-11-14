// Lead 状态点的说法跟着界面语言（2026-11-01）：缺省英文，选了中文时是原来的中文。
import { describe, expect, it } from 'vitest';

import { leadFairy, leadPresence, type LeadPresence } from './leadPresence';

const NOW = Date.parse('2026-10-20T02:00:00.000Z');

describe('the Lead presence text', () => {
  it('is English by default', () => {
    expect(leadPresence({ connectionState: 'disconnected', phase: 'unpaired', lead: undefined, name: 'Paimon', now: NOW }))
      .toMatchObject({ state: 'offline', label: 'Not paired · Click to pair' });
    expect(leadPresence({ connectionState: 'reconnecting', phase: 'ready', lead: undefined, name: 'Paimon', now: NOW }))
      .toMatchObject({ label: 'Paimon is offline', subtitle: 'Offline · Reconnecting' });
    expect(leadPresence({ connectionState: 'connected', phase: 'ready', lead: undefined, name: 'Paimon', now: NOW }))
      .toMatchObject({ state: 'online', label: 'Paimon is online', subtitle: null });
  });

  it('uses the original Chinese when the interface language is Chinese', () => {
    expect(leadPresence({ connectionState: 'disconnected', phase: 'unpaired', lead: undefined, name: 'Paimon', now: NOW, locale: 'zh' }))
      .toMatchObject({ label: '未配对 · 点击配对' });
    expect(leadPresence({ connectionState: 'reconnecting', phase: 'ready', lead: undefined, name: 'Paimon', now: NOW, locale: 'zh' }))
      .toMatchObject({ label: 'Paimon 离线', subtitle: '离线 · 正在重连' });
    expect(leadPresence({ connectionState: 'connected', phase: 'ready', lead: undefined, name: 'Paimon', now: NOW, locale: 'zh' }))
      .toMatchObject({ label: 'Paimon 在线' });
  });
});

// 2026-11-14：Lead 认证失败、在自动重试时（降级），卡住的那一轮还没结束，busy 一直是真，形象就一直按「在想」呼吸。
// 它没在想，是在失败重试：只有在线并且在一轮里才算在想，降级和离线时只慢慢转（离线是灰色、静止）。
describe('the Fairy state', () => {
  const presence = (state: LeadPresence['state']): LeadPresence => ({
    state, dotColor: state === 'offline' ? 'text-muted' : state === 'degraded' ? 'danger' : 'success', pulse: false, label: '', subtitle: null,
  });
  it('thinks only while Lead is online and in a turn', () => {
    expect(leadFairy(presence('online'), true).state).toBe('thinking');
    expect(leadFairy(presence('online'), false).state).toBe('idle');
  });
  it('only turns, without breathing, while Lead is degraded and retrying', () => {
    expect(leadFairy(presence('degraded'), true)).toMatchObject({ state: 'idle', tone: 'color' });
  });
  it('is grey and still while Lead is offline', () => {
    expect(leadFairy(presence('offline'), true)).toMatchObject({ state: 'idle', tone: 'quiet' });
  });
});
