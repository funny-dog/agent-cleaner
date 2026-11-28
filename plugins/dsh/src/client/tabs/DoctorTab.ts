import React from 'react';
import type { Dict } from '../i18n.js';
import type { BackupEntry, DoctorReport, Lang, RunActionFn } from '../types.js';
import { agentLabel, formatBytes, formatTimeAgo, ICONS, SvgIcon } from '../utils.js';

export interface DoctorTabProps {
  t: Dict;
  lang: Lang;
  busy: boolean;
  issuesCount: number;
  doctors: DoctorReport[];
  backups: BackupEntry[];
  runAction: RunActionFn;
}

export function DoctorTab({
  t,
  lang,
  busy,
  issuesCount,
  doctors,
  backups,
  runAction,
}: DoctorTabProps) {
  return React.createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    issuesCount > 0 &&
      React.createElement(
        'div',
        null,
        React.createElement(
          'button',
          {
            className: 'ac-btn ac-btn-primary',
            disabled: busy,
            onClick: () => void runAction(t.labelDoctorFix, '/agent-cleaner/api/doctor-fix'),
          },
          React.createElement(SvgIcon, { size: 13, paths: ICONS.wrench }),
          t.doctorFix,
        ),
      ),
    doctors.map((doc) =>
      React.createElement(
        'div',
        { key: doc.path, className: 'ac-card' },
        React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 13,
              fontWeight: 600,
            },
          },
          React.createElement('span', null, agentLabel(doc.agent)),
          React.createElement(
            'span',
            { style: { color: doc.healthy ? 'var(--ac-success-text)' : 'var(--ac-warn-text)' } },
            doc.healthy ? t.healthy : t.issueCount(doc.issues.length),
          ),
        ),
        React.createElement(
          'div',
          { className: 'ac-num', style: { fontSize: 11, color: 'var(--ac-text-muted)', marginTop: 2 } },
          doc.path,
        ),
        doc.issues.map((iss) => {
          const sev = iss.severity ?? 'warning';
          const sevStyle =
            sev === 'error'
              ? { background: 'var(--ac-danger-bg)', color: 'var(--ac-danger-text)', border: '1px solid var(--ac-danger-border)' }
              : sev === 'info'
                ? { background: 'var(--ac-info-bg)', color: 'var(--ac-info-text)', border: '1px solid var(--ac-border)' }
                : { background: 'var(--ac-warn-bg)', color: 'var(--ac-warn-text)', border: '1px solid var(--ac-warn-border)' };
          return React.createElement(
            'div',
            {
              key: iss.id,
              style: {
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                fontSize: 12,
                marginTop: 6,
              },
            },
            React.createElement(
              'div',
              {
                style: {
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: 6,
                  flex: 1,
                  minWidth: 0,
                },
              },
              React.createElement(
                'span',
                { className: 'ac-pill', style: sevStyle },
                sev.toUpperCase(),
              ),
              iss.autoFixable &&
                React.createElement(
                  'span',
                  {
                    className: 'ac-pill',
                    style: {
                      background: 'var(--ac-success-bg)',
                      color: 'var(--ac-success-text)',
                      border: '1px solid var(--ac-success-border)',
                    },
                  },
                  t.autoFixable,
                ),
              React.createElement(
                'span',
                { style: { color: sev === 'error' ? 'var(--ac-danger-text)' : 'var(--ac-warn-text)' } },
                iss.message,
              ),
            ),
            iss.autoFixable &&
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'ac-btn ac-btn-ghost',
                  style: { minHeight: 26, padding: '3px 10px', fontSize: 11, flexShrink: 0 },
                  disabled: busy,
                  onClick: () =>
                    void runAction(t.labelDoctorFix, '/agent-cleaner/api/doctor-fix', {
                      issueIds: [iss.id],
                    }),
                },
                React.createElement(SvgIcon, { size: 12, paths: ICONS.wrench }),
                t.fixOne,
              ),
          );
        }),
      ),
    ),

    // Config Backup History & Rollback
    React.createElement(
      'div',
      { className: 'ac-card', style: { marginTop: 4 } },
      React.createElement(
        'div',
        {
          style: {
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
            marginBottom: 10,
          },
        },
        React.createElement(
          'strong',
          { style: { fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 } },
          React.createElement(SvgIcon, { size: 14, paths: ICONS.history }),
          t.backupsTitle(backups.length),
        ),
        backups.length > 0 &&
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'ac-btn ac-btn-ghost',
              disabled: busy,
              onClick: () =>
                void runAction(t.labelBackupPrune, '/agent-cleaner/api/backup-prune', {}),
            },
            t.backupPrune,
          ),
      ),
      backups.length === 0
        ? React.createElement('div', { style: { fontSize: 12, color: 'var(--ac-text-muted)' } }, t.backupsEmpty)
        : React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto' } },
            backups.map((b) =>
              React.createElement(
                'div',
                {
                  key: b.id,
                  style: {
                    display: 'flex',
                    flexWrap: 'wrap',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 8,
                    padding: '7px 10px',
                    borderRadius: 8,
                    border: '1px solid var(--ac-border)',
                    fontSize: 12,
                  },
                },
                React.createElement(
                  'div',
                  { style: { flex: 1, minWidth: 0 } },
                  React.createElement(
                    'div',
                    { className: 'ac-num', style: { fontWeight: 600, wordBreak: 'break-all' } },
                    b.originalPath,
                  ),
                  React.createElement(
                    'div',
                    { className: 'ac-num', style: { fontSize: 11, color: 'var(--ac-text-muted)', marginTop: 2 } },
                    `${b.id.slice(0, 8)} · ${formatTimeAgo(b.createdAtMs, lang)} · ${formatBytes(b.sizeBytes)}`,
                  ),
                ),
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'ac-btn ac-btn-ghost',
                    style: { minHeight: 28, padding: '4px 10px', flexShrink: 0 },
                    disabled: busy,
                    onClick: () =>
                      void runAction(t.labelBackupRestore, '/agent-cleaner/api/backup-restore', {
                        backupId: b.id,
                      }),
                  },
                  React.createElement(SvgIcon, { size: 12, paths: ICONS.restore }),
                  t.backupRestore,
                ),
              ),
            ),
          ),
    ),
  );
}
