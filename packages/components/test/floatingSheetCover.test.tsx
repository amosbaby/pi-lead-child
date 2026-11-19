// 悬浮底部面板盖住页面上的一块（2026-11-19 用户：加号面板的圆角要和输入框一样，正好把输入框盖住，不露出下面一截）。
// 给出 cover 时面板的左右和底边对齐这一块；不给时还是离边 12、离底 20。
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FloatingSheet, Text } from '../src';
import { renderUI } from './render';

describe('FloatingSheet cover', () => {
  it('lines its left, right and bottom edges up with the element it covers', () => {
    renderUI(
      <FloatingSheet testID="plus" open onClose={() => {}} label="Add" inset="menu" cover={{ left: 8, right: 16, bottom: 30 }}>
        <Text>Photos</Text>
      </FloatingSheet>,
    );
    const panel = screen.getByTestId('plus');
    expect(panel.style.left).toBe('8px');
    expect(panel.style.right).toBe('16px');
    expect(panel.style.bottom).toBe('30px');
  });

  it('keeps 20 from the bottom without a cover', () => {
    renderUI(
      <FloatingSheet testID="plus" open onClose={() => {}} label="Add" inset="menu">
        <Text>Photos</Text>
      </FloatingSheet>,
    );
    expect(screen.getByTestId('plus').style.bottom).toBe('20px');
  });
});
