import React from 'react';
import { CleanerPanel } from './client/CleanerPanel.js';
import { ICONS, SvgIcon } from './client/utils.js';

export const name = 'agent-cleaner';
export const inject = ['slots'];

export function apply(ctx: any): void {
  const slots = typeof ctx?.get === 'function' ? ctx.get('slots') : ctx?.slots;
  if (!slots || typeof slots.register !== 'function') return;

  const offPanel = slots.register(
    {
      name: 'main',
      key: 'agent-cleaner',
    },
    () => React.createElement(CleanerPanel),
  );

  const offRow = slots.register(
    {
      name: 'sidebar.panellist',
      id: 'agent-cleaner',
      order: 85,
      label: () => 'Agent Cleaner',
    },
    (owner: { size?: number } = {}) =>
      React.createElement(SvgIcon, { size: owner.size ?? 16, paths: ICONS.broom }),
  );

  if (typeof ctx.effect === 'function') {
    ctx.effect(
      () => () => {
        if (typeof offRow === 'function') offRow();
        if (typeof offPanel === 'function') offPanel();
      },
      'agent-cleaner: sidebar slots',
    );
  }
}

export default { name, inject, apply };
