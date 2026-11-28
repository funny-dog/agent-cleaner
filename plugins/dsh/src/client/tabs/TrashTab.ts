import React from 'react';
import type { Dict } from '../i18n.js';
import type { CleanerConfig, Lang, RunActionFn, TrashBatch } from '../types.js';
import { agentLabel, formatBytes, formatTimeAgo, ICONS, SvgIcon } from '../utils.js';

export interface TrashTabProps {
  t: Dict;
  lang: Lang;
  busy: boolean;
  config: CleanerConfig | null;
  trashBatches: TrashBatch[];
  trashTotalBytes: number;
  expandedBatchIds: Set<string>;
  toggleBatchDetails: (batchId: string) => void;
  runAction: RunActionFn;
}

export function TrashTab({
  t,
  lang,
  busy,
  config,
  trashBatches,
  trashTotalBytes,
  expandedBatchIds,
  toggleBatchDetails,
  runAction,
}: TrashTabProps) {
  const maxAgeDays = config?.trash_max_age_days ?? 30;
  const maxSizeMb = config?.trash_max_size_mb ?? 5120;
  const autoPrune = config?.auto_prune_trash ?? true;

  return React.createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    React.createElement(
      'div',
      {
        className: 'ac-card',
        style: {
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 10,
        },
      },
      React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        React.createElement(
          'div',
          { className: 'ac-num', style: { fontSize: 12, color: 'var(--ac-text-secondary)' } },
          t.trashSummary(trashBatches.length, formatBytes(trashTotalBytes)),
        ),
        React.createElement(
          'div',
          { style: { fontSize: 11, color: 'var(--ac-text-muted)' } },
          t.trashPolicy(maxAgeDays, maxSizeMb, autoPrune),
        ),
      ),
      React.createElement(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'ac-btn ac-btn-ghost',
            disabled: busy || trashBatches.length === 0,
            onClick: () => void runAction(t.labelTrashPrune, '/agent-cleaner/api/trash-prune', {}),
          },
          t.trashPrune,
        ),
        trashBatches.length > 0 &&
          React.createElement(
            'button',
            {
              className: 'ac-btn ac-btn-ghost',
              disabled: busy,
              style: {
                borderColor: 'var(--ac-danger-border)',
                color: 'var(--ac-danger-text)',
              },
              onClick: () => void runAction(t.labelPurge, '/agent-cleaner/api/purge', { all: true }),
            },
            React.createElement(SvgIcon, { size: 13, paths: ICONS.trash }),
            t.purgeAll,
          ),
      ),
    ),
    trashBatches.map((b) => {
      const expanded = expandedBatchIds.has(b.batchId);
      return React.createElement(
        'div',
        { key: b.batchId, className: 'ac-card' },
        React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 10,
            },
          },
          React.createElement(
            'div',
            { className: 'ac-num', style: { fontSize: 12 } },
            React.createElement(
              'strong',
              { style: { color: 'var(--ac-accent)' } },
              b.batchId.slice(0, 8),
            ),
            ` · ${formatTimeAgo(b.timestamp, lang)} · ${t.itemsUnit(b.items.length)} · ${formatBytes(b.totalBytes)}`,
          ),
          React.createElement(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
            React.createElement(
              'button',
              {
                className: 'ac-btn ac-btn-ghost',
                onClick: () => toggleBatchDetails(b.batchId),
              },
              expanded ? t.hideDetails : t.details,
            ),
            React.createElement(
              'button',
              {
                className: 'ac-btn ac-btn-ghost',
                disabled: busy,
                onClick: () =>
                  void runAction(t.labelRestore, '/agent-cleaner/api/restore', {
                    batchId: b.batchId,
                  }),
              },
              React.createElement(SvgIcon, { size: 13, paths: ICONS.restore }),
              t.restore,
            ),
            React.createElement(
              'button',
              {
                className: 'ac-btn ac-btn-ghost',
                disabled: busy,
                onClick: () =>
                  void runAction(t.labelPurge, '/agent-cleaner/api/purge', {
                    batchId: b.batchId,
                  }),
              },
              t.purge,
            ),
          ),
        ),
        expanded &&
          React.createElement(
            'div',
            {
              style: {
                marginTop: 10,
                paddingTop: 8,
                borderTop: '1px solid var(--ac-border)',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              },
            },
            b.items.map((item) =>
              React.createElement(
                'div',
                {
                  key: item.id,
                  className: 'ac-num',
                  style: {
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 10,
                    fontSize: 11,
                    color: 'var(--ac-text-secondary)',
                  },
                },
                React.createElement(
                  'span',
                  { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  `[${agentLabel(item.agent)}] ${item.originalPath}`,
                ),
                React.createElement(
                  'span',
                  { style: { flexShrink: 0, color: 'var(--ac-text-muted)' } },
                  formatBytes(item.sizeBytes),
                ),
              ),
            ),
          ),
      );
    }),
    trashBatches.length === 0 &&
      React.createElement(
        'div',
        { className: 'ac-card', style: { fontSize: 12, color: 'var(--ac-text-muted)' } },
        t.trashEmpty,
      ),
  );
}
