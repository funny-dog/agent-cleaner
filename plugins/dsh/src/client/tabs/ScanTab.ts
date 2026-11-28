import React from 'react';
import type { Dict } from '../i18n.js';
import { AGENT_COLORS } from '../styles.js';
import type { Lang, Recommendation, RunActionFn, ScanItem, ScanResult } from '../types.js';
import { agentLabel, formatBytes, ICONS, recBadge, SvgIcon } from '../utils.js';

export interface ScanTabProps {
  t: Dict;
  lang: Lang;
  loading: boolean;
  busy: boolean;
  exemptHours: number;
  agents: ScanResult[];
  allItems: ScanItem[];
  visibleItems: ScanItem[];
  selectedItems: ScanItem[];
  selectedBytes: number;
  selectedIds: Set<string>;
  recItemsCount: number;
  optCount: number;
  exemptCount: number;
  totalDisk: number;
  safeTotalDisk: number;
  diskBreakdownAgents: ScanResult[];
  agentFilter: string;
  setAgentFilter: React.Dispatch<React.SetStateAction<string>>;
  recFilter: 'all' | Recommendation;
  setRecFilter: React.Dispatch<React.SetStateAction<'all' | Recommendation>>;
  searchQuery: string;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  toggleItem: (id: string) => void;
  setConfirmPermanent: React.Dispatch<React.SetStateAction<boolean>>;
  ignoredPaths: string[];
  runAction: RunActionFn;
}

export function ScanTab(props: ScanTabProps) {
  const {
    t,
    lang,
    loading,
    busy,
    exemptHours,
    agents,
    allItems,
    visibleItems,
    selectedItems,
    selectedBytes,
    selectedIds,
    recItemsCount,
    optCount,
    exemptCount,
    totalDisk,
    safeTotalDisk,
    diskBreakdownAgents,
    agentFilter,
    setAgentFilter,
    recFilter,
    setRecFilter,
    searchQuery,
    setSearchQuery,
    setSelectedIds,
    toggleItem,
    setConfirmPermanent,
    ignoredPaths,
    runAction,
  } = props;

  const normPath = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const ignoredSet = new Set(ignoredPaths.map(normPath));

  return React.createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
    agents.length > 0 &&
      React.createElement(
        'div',
        { className: 'ac-card' },
        React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 11,
              color: 'var(--ac-text-secondary)',
              marginBottom: 8,
            },
          },
          React.createElement('span', null, t.breakdownTitle),
          React.createElement('span', { className: 'ac-num' }, formatBytes(totalDisk)),
        ),
        React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              height: 8,
              width: '100%',
              borderRadius: 999,
              overflow: 'hidden',
              background: 'var(--ac-track-bg)',
            },
          },
          diskBreakdownAgents.map((a, idx) =>
            React.createElement('button', {
              key: a.agent,
              type: 'button',
              title: `${agentLabel(a.agent)}: ${formatBytes(a.diskUsageBytes)}`,
              onClick: () => setAgentFilter((prev) => (prev === a.agent ? 'all' : a.agent)),
              style: {
                width: `${Math.max(1.5, (a.diskUsageBytes / safeTotalDisk) * 100)}%`,
                height: '100%',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                background: AGENT_COLORS[idx % AGENT_COLORS.length],
                opacity: agentFilter !== 'all' && agentFilter !== a.agent ? 0.3 : 1,
              },
            }),
          ),
        ),
        React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              flexWrap: 'wrap',
              gap: 10,
              marginTop: 8,
              fontSize: 11,
            },
          },
          diskBreakdownAgents.map((a, idx) =>
            React.createElement(
              'button',
              {
                key: a.agent,
                type: 'button',
                onClick: () => setAgentFilter((prev) => (prev === a.agent ? 'all' : a.agent)),
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  border: 'none',
                  background: agentFilter === a.agent ? 'var(--ac-active-bg)' : 'transparent',
                  color: 'inherit',
                  borderRadius: 6,
                  padding: '2px 6px',
                  cursor: 'pointer',
                  fontSize: 11,
                },
              },
              React.createElement('span', {
                style: {
                  width: 7,
                  height: 7,
                  borderRadius: 999,
                  background: AGENT_COLORS[idx % AGENT_COLORS.length],
                },
              }),
              agentLabel(a.agent),
              React.createElement(
                'span',
                { className: 'ac-num', style: { color: 'var(--ac-text-muted)' } },
                formatBytes(a.diskUsageBytes),
              ),
            ),
          ),
        ),
      ),

    // Filter + Search + Selection Toolbar
    React.createElement(
      'div',
      {
        className: 'ac-card',
        style: {
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          alignItems: 'center',
          justifyContent: 'space-between',
        },
      },
      React.createElement(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' } },
        (
          [
            ['all', t.filterAll(allItems.length)],
            ['recommended', t.filterRec(recItemsCount)],
            ['optional', t.filterOpt(optCount)],
            ['exempt', t.filterExempt(exemptCount)],
          ] as const
        ).map(([k, label]) =>
          React.createElement(
            'button',
            {
              key: k,
              className: 'ac-btn ac-btn-ghost',
              style: {
                borderColor: recFilter === k ? 'var(--ac-accent)' : undefined,
                color: recFilter === k ? 'var(--ac-accent)' : undefined,
                background: recFilter === k ? 'var(--ac-accent-soft)' : undefined,
              },
              onClick: () => setRecFilter(k),
            },
            label,
          ),
        ),
        React.createElement(
          'div',
          { style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
          React.createElement(
            'span',
            {
              style: {
                position: 'absolute',
                left: 9,
                color: 'var(--ac-text-muted)',
                pointerEvents: 'none',
                display: 'inline-flex',
              },
            },
            React.createElement(SvgIcon, { size: 13, paths: ICONS.search }),
          ),
          React.createElement('input', {
            type: 'text',
            className: 'ac-input',
            value: searchQuery,
            placeholder: t.searchPlaceholder,
            onChange: (e: any) => setSearchQuery(e.target.value),
          }),
        ),
      ),
      React.createElement(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' } },
        React.createElement(
          'button',
          {
            className: 'ac-btn ac-btn-ghost',
            onClick: () =>
              setSelectedIds(
                new Set(
                  allItems
                    .filter((i) => i.recommendation === 'recommended')
                    .map((i) => i.id),
                ),
              ),
          },
          t.selectRec,
        ),
        React.createElement(
          'button',
          {
            className: 'ac-btn ac-btn-ghost',
            onClick: () =>
              setSelectedIds((prev) => {
                const next = new Set(prev);
                for (const it of visibleItems) next.add(it.id);
                return next;
              }),
          },
          t.selectVisible,
        ),
        React.createElement(
          'button',
          {
            className: 'ac-btn ac-btn-ghost',
            onClick: () => setSelectedIds(new Set()),
          },
          t.clearSel,
        ),
      ),
    ),

    // Selected Summary & Execution Bar
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
          borderColor: selectedItems.length > 0 ? 'var(--ac-accent-border)' : undefined,
        },
      },
      React.createElement(
        'div',
        { style: { fontSize: 12 } },
        t.selectedPrefix,
        React.createElement(
          'strong',
          { className: 'ac-num', style: { color: 'var(--ac-accent)' } },
          `${selectedItems.length}`,
        ),
        t.selectedMid,
        React.createElement(
          'strong',
          { className: 'ac-num', style: { color: 'var(--ac-accent)' } },
          formatBytes(selectedBytes),
        ),
      ),
      React.createElement(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
        React.createElement(
          'button',
          {
            className: 'ac-btn ac-btn-ghost',
            disabled: busy || selectedItems.length === 0,
            onClick: () =>
              void runAction(t.labelClean, '/agent-cleaner/api/clean', {
                exemptHours,
                lang,
                dryRun: false,
                selectedIds: selectedItems.map((i) => i.id),
              }),
          },
          React.createElement(SvgIcon, { size: 13, paths: ICONS.trash }),
          t.deleteSelected(formatBytes(selectedBytes)),
        ),
        React.createElement(
          'button',
          {
            className: 'ac-btn ac-btn-primary',
            disabled: busy || selectedItems.length === 0,
            onClick: () => setConfirmPermanent(true),
          },
          React.createElement(SvgIcon, { size: 13, paths: ICONS.trash }),
          t.deletePermanently,
        ),
      ),
    ),

    // Item List
    React.createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      visibleItems.map((it) => {
        const checked = selectedIds.has(it.id);
        return React.createElement(
          'label',
          {
            key: it.id,
            className: 'ac-card ac-row-card',
            style: {
              borderColor: checked ? 'var(--ac-accent)' : undefined,
              opacity: it.recommendation === 'exempt' && !checked ? 0.72 : 1,
            },
          },
          React.createElement('input', {
            type: 'checkbox',
            className: 'ac-checkbox',
            checked,
            onChange: () => toggleItem(it.id),
          }),
          React.createElement(
            'div',
            { style: { flex: 1, minWidth: 0 } },
            React.createElement(
              'div',
              {
                style: {
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  fontWeight: 600,
                },
              },
              recBadge(it.recommendation, t),
              React.createElement(
                'span',
                {
                  className: 'ac-pill',
                  style: { background: 'var(--ac-info-bg)', color: 'var(--ac-info-text)' },
                },
                agentLabel(it.agent),
              ),
              React.createElement('span', null, it.description),
            ),
            React.createElement(
              'div',
              { style: { fontSize: 11, color: 'var(--ac-text-secondary)', marginTop: 4 } },
              it.recommendationReason,
            ),
            React.createElement(
              'div',
              {
                className: 'ac-num',
                style: {
                  fontSize: 11,
                  color: 'var(--ac-text-muted)',
                  marginTop: 3,
                  wordBreak: 'break-all',
                },
              },
              it.path,
            ),
          ),
          React.createElement(
            'div',
            {
              style: {
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-end',
                gap: 6,
                flexShrink: 0,
              },
            },
            React.createElement(
              'div',
              {
                className: 'ac-num',
                style: { fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' },
              },
              formatBytes(it.sizeBytes),
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'ac-btn ac-btn-ghost',
                style: { minHeight: 26, padding: '3px 8px', fontSize: 11 },
                disabled: busy || ignoredSet.has(normPath(it.path)),
                onClick: (e: any) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void runAction(t.labelIgnorePath, '/agent-cleaner/api/config', {
                    action: 'ignore_path',
                    pattern: it.path,
                  });
                },
              },
              React.createElement(SvgIcon, { size: 12, paths: ICONS.shield }),
              ignoredSet.has(normPath(it.path)) ? t.ignoredBadge : t.ignorePath,
            ),
          ),
        );
      }),
      !loading &&
        visibleItems.length === 0 &&
        React.createElement(
          'div',
          { className: 'ac-card', style: { textAlign: 'center', fontSize: 12, color: 'var(--ac-text-muted)' } },
          t.noItems,
        ),
    ),
  );
}
