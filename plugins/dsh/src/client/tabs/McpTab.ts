import React from 'react';
import type { Dict } from '../i18n.js';
import type { McpEntry, McpOrphanProcess, RunActionFn } from '../types.js';
import { agentLabel, formatBytes } from '../utils.js';

export interface McpTabProps {
  t: Dict;
  busy: boolean;
  orphans: McpOrphanProcess[];
  deadLinks: McpEntry[];
  duplicates: McpEntry[][];
  conflicts: McpEntry[][];
  coldCaches: Array<{ source: string; path: string; sizeBytes: number; lastAccessDays: number }>;
  runAction: RunActionFn;
}

export function McpTab({
  t,
  busy,
  orphans,
  deadLinks,
  duplicates,
  conflicts,
  coldCaches,
  runAction,
}: McpTabProps) {
  return React.createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
    // Orphan Processes
    React.createElement(
      'div',
      { className: 'ac-card' },
      React.createElement(
        'div',
        {
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 10,
          },
        },
        React.createElement('strong', { style: { fontSize: 13 } }, t.mcpTitle),
        orphans.length > 0 &&
          React.createElement(
            'button',
            {
              className: 'ac-btn ac-btn-primary',
              disabled: busy,
              onClick: () => void runAction(t.labelMcpKill, '/agent-cleaner/api/mcp-kill'),
            },
            t.killAll,
          ),
      ),
      orphans.length === 0
        ? React.createElement('div', { style: { fontSize: 12, color: 'var(--ac-text-muted)' } }, t.noOrphans)
        : React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            orphans.map((p) => {
              const memMb = Math.max(1, Math.round((p.rssKb || 0) / 1024));
              return React.createElement(
                'div',
                {
                  key: p.pid,
                  style: {
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: '1px solid var(--ac-warn-border)',
                    background: 'var(--ac-warn-bg)',
                  },
                },
                React.createElement(
                  'div',
                  { style: { flex: 1, minWidth: 0 } },
                  React.createElement(
                    'div',
                    {
                      className: 'ac-num',
                      style: {
                        display: 'flex',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 12,
                        fontWeight: 600,
                        color: 'var(--ac-warn-text)',
                      },
                    },
                    `PID ${p.pid}`,
                    p.matchedAgent &&
                      React.createElement(
                        'span',
                        {
                          className: 'ac-pill',
                          style: { background: 'var(--ac-info-bg)', color: 'var(--ac-info-text)' },
                        },
                        agentLabel(p.matchedAgent),
                      ),
                    React.createElement(
                      'span',
                      null,
                      `${p.matchedName ?? 'MCP Stdio Process'} · ${memMb} MB`,
                    ),
                  ),
                  React.createElement(
                    'div',
                    {
                      className: 'ac-num',
                      style: {
                        fontSize: 11,
                        color: 'var(--ac-text-secondary)',
                        marginTop: 3,
                        wordBreak: 'break-all',
                      },
                    },
                    p.command,
                  ),
                ),
                React.createElement(
                  'button',
                  {
                    className: 'ac-btn ac-btn-ghost',
                    disabled: busy,
                    style: { flexShrink: 0 },
                    onClick: () =>
                      void runAction(t.labelMcpKill, '/agent-cleaner/api/mcp-kill', {
                        pid: p.pid,
                      }),
                  },
                  t.killOne,
                ),
              );
            }),
          ),
    ),

    // Dead Links
    React.createElement(
      'div',
      { className: 'ac-card' },
      React.createElement(
        'div',
        { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } },
        t.deadLinksTitle(deadLinks.length),
      ),
      deadLinks.length === 0
        ? React.createElement('div', { style: { fontSize: 12, color: 'var(--ac-text-muted)' } }, t.noDeadLinks)
        : React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            deadLinks.map((d, idx) =>
              React.createElement(
                'div',
                {
                  key: `${d.agent}:${d.name}:${idx}`,
                  style: {
                    padding: '7px 10px',
                    borderRadius: 8,
                    border: '1px solid var(--ac-danger-border)',
                    background: 'var(--ac-danger-bg)',
                    fontSize: 12,
                  },
                },
                React.createElement(
                  'div',
                  { style: { fontWeight: 600, color: 'var(--ac-danger-text)' } },
                  `[${agentLabel(d.agent)}] ${d.name}`,
                ),
                React.createElement(
                  'div',
                  {
                    className: 'ac-num',
                    style: { fontSize: 11, color: 'var(--ac-text-muted)', marginTop: 2, wordBreak: 'break-all' },
                  },
                  d.command || d.url || d.configPath || '',
                ),
              ),
            ),
          ),
    ),

    // Cross-Agent Conflicts
    React.createElement(
      'div',
      { className: 'ac-card' },
      React.createElement(
        'div',
        { style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } },
        t.conflictsTitle(conflicts.length),
      ),
      conflicts.length > 0 &&
        React.createElement(
          'div',
          { style: { fontSize: 11, color: 'var(--ac-text-muted)', marginBottom: 8 } },
          t.conflictDivergenceHint,
        ),
      conflicts.length === 0
        ? React.createElement('div', { style: { fontSize: 12, color: 'var(--ac-text-muted)' } }, t.noConflicts)
        : React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            conflicts.map((group, idx) => {
              const serverName = group[0]?.name ?? 'MCP';
              return React.createElement(
                'div',
                {
                  key: `${serverName}:${idx}`,
                  style: {
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: '1px solid var(--ac-warn-border)',
                    background: 'var(--ac-warn-bg)',
                    fontSize: 12,
                  },
                },
                React.createElement(
                  'div',
                  { style: { fontWeight: 600, color: 'var(--ac-warn-text)', marginBottom: 6 } },
                  serverName,
                ),
                React.createElement(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
                  group.map((entry, eIdx) => {
                    const target = entry.command
                      ? [entry.command, ...(entry.args ?? [])].join(' ')
                      : entry.url || '';
                    return React.createElement(
                      'div',
                      {
                        key: `${entry.agent}:${entry.configPath ?? eIdx}:${eIdx}`,
                        style: {
                          padding: '5px 8px',
                          borderRadius: 6,
                          background: 'var(--ac-surface)',
                          border: '1px solid var(--ac-border)',
                        },
                      },
                      React.createElement(
                        'div',
                        { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 } },
                        React.createElement(
                          'span',
                          {
                            className: 'ac-pill',
                            style: { background: 'var(--ac-info-bg)', color: 'var(--ac-info-text)' },
                          },
                          agentLabel(entry.agent),
                        ),
                        React.createElement(
                          'span',
                          {
                            className: 'ac-pill',
                            style: { background: 'var(--ac-hover-bg)', color: 'var(--ac-text-secondary)' },
                          },
                          (entry.transport ?? 'stdio').toUpperCase(),
                        ),
                        React.createElement(
                          'span',
                          { className: 'ac-num', style: { fontSize: 11, wordBreak: 'break-all' } },
                          target,
                        ),
                      ),
                      entry.configPath &&
                        React.createElement(
                          'div',
                          {
                            className: 'ac-num',
                            style: { fontSize: 10, color: 'var(--ac-text-muted)', marginTop: 2, wordBreak: 'break-all' },
                          },
                          entry.configPath,
                        ),
                    );
                  }),
                ),
              );
            }),
          ),
    ),

    // Cross-Agent Duplicates
    duplicates.length > 0 &&
      React.createElement(
        'div',
        { className: 'ac-card' },
        React.createElement(
          'div',
          { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } },
          t.duplicatesTitle(duplicates.length),
        ),
        React.createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          duplicates.map((group, idx) => {
            const first = group[0];
            const agentsList = [...new Set(group.map((g) => agentLabel(g.agent)))].join(', ');
            return React.createElement(
              'div',
              {
                key: idx,
                style: {
                  padding: '7px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--ac-border)',
                  fontSize: 12,
                },
              },
              React.createElement(
                'div',
                { style: { fontWeight: 600 } },
                `${first?.name ?? 'MCP'} · ${agentsList}`,
              ),
              React.createElement(
                'div',
                {
                  className: 'ac-num',
                  style: { fontSize: 11, color: 'var(--ac-text-muted)', marginTop: 2, wordBreak: 'break-all' },
                },
                first?.command || first?.url || '',
              ),
            );
          }),
        ),
      ),

    // Cold Caches
    React.createElement(
      'div',
      { className: 'ac-card' },
      React.createElement(
        'div',
        { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } },
        t.coldCachesTitle(coldCaches.length),
      ),
      coldCaches.length === 0
        ? React.createElement('div', { style: { fontSize: 12, color: 'var(--ac-text-muted)' } }, t.noColdCaches)
        : React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto' } },
            coldCaches.map((c) =>
              React.createElement(
                'div',
                {
                  key: c.path,
                  style: {
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 10px',
                    borderRadius: 8,
                    border: '1px solid var(--ac-border)',
                    fontSize: 11,
                  },
                },
                React.createElement(
                  'span',
                  { className: 'ac-num', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  `[${c.source}] ${c.path.split(/[/\\]/).pop() || c.path} (${c.lastAccessDays}d)`,
                ),
                React.createElement(
                  'span',
                  { className: 'ac-num', style: { color: 'var(--ac-text-secondary)', flexShrink: 0 } },
                  formatBytes(c.sizeBytes),
                ),
              ),
            ),
          ),
    ),
  );
}
