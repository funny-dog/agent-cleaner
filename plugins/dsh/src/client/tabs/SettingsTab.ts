import React, { useEffect, useState } from 'react';
import type { Dict } from '../i18n.js';
import type { CleanerConfig, RunActionFn } from '../types.js';
import { agentLabel, ICONS, SvgIcon } from '../utils.js';

export interface SettingsTabProps {
  t: Dict;
  busy: boolean;
  config: CleanerConfig | null;
  runAction: RunActionFn;
}

const KNOWN_AGENT_OPTIONS = [
  'claude',
  'opencode',
  'codex',
  'dsh',
  'gemini',
  'cursor',
  'windsurf',
  'trae',
  'kiro',
  'kimi',
  'qoder',
  'workbuddy',
  'codebuddy',
  'zcode',
  'devin',
  'continue',
  'copilot',
  'zed',
  'aider',
  'ollama',
  'pkg-cache',
];

export function SettingsTab({ t, busy, config, runAction }: SettingsTabProps) {
  const [exemptHours, setExemptHours] = useState<number>(config?.exempt_hours ?? 24);
  const [coldDays, setColdDays] = useState<number>(config?.cold_threshold_days ?? 14);
  const [trashMaxAgeDays, setTrashMaxAgeDays] = useState<number>(config?.trash_max_age_days ?? 30);
  const [trashMaxSizeMb, setTrashMaxSizeMb] = useState<number>(config?.trash_max_size_mb ?? 5120);
  const [backupMaxCount, setBackupMaxCount] = useState<number>(config?.backup_max_count ?? 30);
  const [autoPruneTrash, setAutoPruneTrash] = useState<boolean>(config?.auto_prune_trash ?? true);
  const [newPath, setNewPath] = useState<string>('');
  const [newAgent, setNewAgent] = useState<string>('');

  useEffect(() => {
    if (!config) return;
    setExemptHours(config.exempt_hours);
    setColdDays(config.cold_threshold_days);
    setTrashMaxAgeDays(config.trash_max_age_days);
    setTrashMaxSizeMb(config.trash_max_size_mb);
    setBackupMaxCount(config.backup_max_count);
    setAutoPruneTrash(config.auto_prune_trash);
  }, [config]);

  const toNonNegInt = (val: string, fallback: number): number => {
    const n = Number(val);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };

  const ignoredPaths = config?.ignored_paths ?? [];
  const ignoredAgents = config?.ignored_agents ?? [];

  return React.createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 10 } },

    // Global Policy Card
    React.createElement(
      'div',
      { className: 'ac-card' },
      React.createElement(
        'div',
        { style: { fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 } },
        React.createElement(SvgIcon, { size: 14, paths: ICONS.settings }),
        t.settingsTitle,
      ),
      React.createElement(
        'div',
        { style: { fontSize: 11, color: 'var(--ac-text-muted)', marginTop: 4, marginBottom: 12 } },
        t.settingsDesc,
      ),
      React.createElement(
        'div',
        { className: 'ac-form-grid' },
        React.createElement(
          'label',
          { className: 'ac-field' },
          React.createElement('span', null, t.exemptHoursLabel),
          React.createElement('input', {
            type: 'number',
            min: 0,
            className: 'ac-input-plain ac-num',
            value: exemptHours,
            disabled: busy,
            onChange: (e: any) => setExemptHours(toNonNegInt(e.target.value, 0)),
          }),
        ),
        React.createElement(
          'label',
          { className: 'ac-field' },
          React.createElement('span', null, t.coldDaysLabel),
          React.createElement('input', {
            type: 'number',
            min: 0,
            className: 'ac-input-plain ac-num',
            value: coldDays,
            disabled: busy,
            onChange: (e: any) => setColdDays(toNonNegInt(e.target.value, 0)),
          }),
        ),
        React.createElement(
          'label',
          { className: 'ac-field' },
          React.createElement('span', null, t.trashMaxAgeLabel),
          React.createElement('input', {
            type: 'number',
            min: 0,
            className: 'ac-input-plain ac-num',
            value: trashMaxAgeDays,
            disabled: busy,
            onChange: (e: any) => setTrashMaxAgeDays(toNonNegInt(e.target.value, 0)),
          }),
        ),
        React.createElement(
          'label',
          { className: 'ac-field' },
          React.createElement('span', null, t.trashMaxSizeLabel),
          React.createElement('input', {
            type: 'number',
            min: 0,
            className: 'ac-input-plain ac-num',
            value: trashMaxSizeMb,
            disabled: busy,
            onChange: (e: any) => setTrashMaxSizeMb(toNonNegInt(e.target.value, 0)),
          }),
        ),
        React.createElement(
          'label',
          { className: 'ac-field' },
          React.createElement('span', null, t.backupMaxCountLabel),
          React.createElement('input', {
            type: 'number',
            min: 0,
            className: 'ac-input-plain ac-num',
            value: backupMaxCount,
            disabled: busy,
            onChange: (e: any) => setBackupMaxCount(toNonNegInt(e.target.value, 0)),
          }),
        ),
      ),
      React.createElement(
        'div',
        {
          style: {
            marginTop: 12,
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 10,
          },
        },
        React.createElement(
          'label',
          { style: { display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' } },
          React.createElement('input', {
            type: 'checkbox',
            className: 'ac-checkbox',
            style: { marginTop: 0 },
            checked: autoPruneTrash,
            disabled: busy,
            onChange: (e: any) => setAutoPruneTrash(Boolean(e.target.checked)),
          }),
          React.createElement('span', null, t.autoPruneLabel),
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'ac-btn ac-btn-primary',
            disabled: busy,
            onClick: () =>
              void runAction(t.labelSaveConfig, '/agent-cleaner/api/config', {
                action: 'set',
                exempt_hours: exemptHours,
                cold_threshold_days: coldDays,
                trash_max_age_days: trashMaxAgeDays,
                trash_max_size_mb: trashMaxSizeMb,
                backup_max_count: backupMaxCount,
                auto_prune_trash: autoPruneTrash,
              }),
          },
          t.saveSettings,
        ),
      ),
    ),

    // Ignored Paths Whitelist
    React.createElement(
      'div',
      { className: 'ac-card' },
      React.createElement(
        'div',
        { style: { fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 } },
        React.createElement(SvgIcon, { size: 14, paths: ICONS.shield }),
        t.ignoredPathsTitle(ignoredPaths.length),
      ),
      React.createElement(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 } },
        React.createElement('input', {
          type: 'text',
          className: 'ac-input-plain ac-num',
          style: { flex: 1, minWidth: 220 },
          value: newPath,
          disabled: busy,
          placeholder: t.ignoredPathPlaceholder,
          onChange: (e: any) => setNewPath(e.target.value),
          onKeyDown: (e: any) => {
            if (e.key === 'Enter' && newPath.trim() && !busy) {
              const pat = newPath.trim();
              setNewPath('');
              void runAction(t.labelIgnorePath, '/agent-cleaner/api/config', {
                action: 'ignore_path',
                pattern: pat,
              });
            }
          },
        }),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'ac-btn ac-btn-ghost',
            disabled: busy || !newPath.trim(),
            onClick: () => {
              const pat = newPath.trim();
              if (!pat) return;
              setNewPath('');
              void runAction(t.labelIgnorePath, '/agent-cleaner/api/config', {
                action: 'ignore_path',
                pattern: pat,
              });
            },
          },
          React.createElement(SvgIcon, { size: 13, paths: ICONS.plus }),
          t.addIgnore,
        ),
      ),
      ignoredPaths.length === 0
        ? React.createElement('div', { style: { fontSize: 12, color: 'var(--ac-text-muted)' } }, t.noIgnoredPaths)
        : React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            ignoredPaths.map((pat) =>
              React.createElement(
                'div',
                {
                  key: pat,
                  style: {
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 10,
                    padding: '6px 10px',
                    borderRadius: 8,
                    border: '1px solid var(--ac-border)',
                    fontSize: 12,
                  },
                },
                React.createElement(
                  'span',
                  { className: 'ac-num', style: { wordBreak: 'break-all' } },
                  pat,
                ),
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'ac-btn ac-btn-ghost',
                    style: { minHeight: 28, padding: '4px 10px', flexShrink: 0 },
                    disabled: busy,
                    onClick: () =>
                      void runAction(t.remove, '/agent-cleaner/api/config', {
                        action: 'unignore_path',
                        pattern: pat,
                      }),
                  },
                  t.remove,
                ),
              ),
            ),
          ),
    ),

    // Ignored Agents
    React.createElement(
      'div',
      { className: 'ac-card' },
      React.createElement(
        'div',
        { style: { fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 } },
        React.createElement(SvgIcon, { size: 14, paths: ICONS.eyeOff }),
        t.ignoredAgentsTitle(ignoredAgents.length),
      ),
      React.createElement(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 } },
        React.createElement(
          'select',
          {
            className: 'ac-select',
            value: '',
            disabled: busy,
            onChange: (e: any) => {
              const ag = String(e.target.value || '').trim();
              if (!ag) return;
              void runAction(t.labelSaveConfig, '/agent-cleaner/api/config', {
                action: 'ignore_agent',
                pattern: ag,
              });
            },
          },
          React.createElement('option', { value: '' }, `+ ${t.ignoredAgentPlaceholder}`),
          KNOWN_AGENT_OPTIONS.filter((a) => !ignoredAgents.includes(a)).map((ag) =>
            React.createElement('option', { key: ag, value: ag }, `${agentLabel(ag)} (${ag})`),
          ),
        ),
        React.createElement('input', {
          type: 'text',
          className: 'ac-input-plain ac-num',
          style: { flex: 1, minWidth: 160 },
          value: newAgent,
          disabled: busy,
          placeholder: t.ignoredAgentPlaceholder,
          onChange: (e: any) => setNewAgent(e.target.value),
        }),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'ac-btn ac-btn-ghost',
            disabled: busy || !newAgent.trim(),
            onClick: () => {
              const ag = newAgent.trim();
              if (!ag) return;
              setNewAgent('');
              void runAction(t.labelSaveConfig, '/agent-cleaner/api/config', {
                action: 'ignore_agent',
                pattern: ag,
              });
            },
          },
          React.createElement(SvgIcon, { size: 13, paths: ICONS.plus }),
          t.addIgnore,
        ),
      ),
      ignoredAgents.length === 0
        ? React.createElement('div', { style: { fontSize: 12, color: 'var(--ac-text-muted)' } }, t.noIgnoredAgents)
        : React.createElement(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
            ignoredAgents.map((ag) =>
              React.createElement(
                'span',
                { key: ag, className: 'ac-chip' },
                React.createElement('span', null, `${agentLabel(ag)} (${ag})`),
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'ac-btn ac-btn-ghost',
                    style: { minHeight: 22, padding: '2px 6px', borderRadius: 999 },
                    disabled: busy,
                    'aria-label': `${t.remove} ${ag}`,
                    onClick: () =>
                      void runAction(t.remove, '/agent-cleaner/api/config', {
                        action: 'unignore_agent',
                        pattern: ag,
                      }),
                  },
                  React.createElement(SvgIcon, { size: 11, paths: ICONS.close }),
                ),
              ),
            ),
          ),
    ),
  );
}
