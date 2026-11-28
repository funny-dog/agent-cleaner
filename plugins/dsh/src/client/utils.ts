import React from 'react';
import type { Dict } from './i18n.js';
import type { Lang, Recommendation } from './types.js';

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let val = bytes;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i += 1;
  }
  return i === 0 ? `${bytes} B` : `${val.toFixed(1)} ${units[i]}`;
}

export function formatTimeAgo(ms: number | null | undefined, lang: Lang): string {
  if (!ms) return '--';
  const diff = Math.max(0, Date.now() - ms);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return lang === 'zh' ? '刚刚' : 'just now';
  if (mins < 60) return lang === 'zh' ? `${mins} 分钟前` : `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return lang === 'zh' ? `${hours} 小时前` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return lang === 'zh' ? `${days} 天前` : `${days}d ago`;
}

const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex CLI',
  dsh: 'DSH',
  gemini: 'Gemini / Antigravity',
  workbuddy: 'WorkBuddy',
  qoder: 'Qoder',
  kimi: 'Kimi',
  kiro: 'Kiro',
  ollama: 'Ollama',
  aider: 'Aider',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  trae: 'Trae',
  codebuddy: 'CodeBuddy',
  zcode: 'ZCode',
  devin: 'Devin',
  continue: 'Continue',
  copilot: 'Copilot CLI',
  zed: 'Zed',
  'pkg-cache': 'Cold Cache (npx/uv)',
  'cold-cache': 'Cold Cache (npx/uv)',
};

export function agentLabel(agent: string): string {
  return AGENT_LABELS[agent] ?? agent;
}

export async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: init?.credentials ?? 'same-origin',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  let payload: { ok?: boolean; data?: T; error?: string } = {};
  try {
    const parsed = await res.json();
    if (parsed && typeof parsed === 'object') {
      payload = parsed as { ok?: boolean; data?: T; error?: string };
    }
  } catch {
    // Non-JSON error response (e.g., plain text 401/403 from host or proxy)
  }
  if (!res.ok || !payload.ok) {
    throw new Error(payload.error || `HTTP ${res.status}`);
  }
  return payload.data as T;
}

export function SvgIcon({
  size = 16,
  paths,
  className,
}: {
  size?: number;
  paths: Array<{ d: string }>;
  className?: string;
}) {
  return React.createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      className,
      style: { flexShrink: 0 },
    },
    ...paths.map((p, idx) => React.createElement('path', { key: idx, d: p.d })),
  );
}

export const ICONS = {
  broom: [
    { d: 'm13 11 9-9' },
    { d: 'M14.6 12.6c.8.8.9 2.1.2 3L10 22l-8-8 6.4-4.8c.9-.7 2.2-.6 3 .2Z' },
    { d: 'm6.8 10.4 6.8 6.8' },
  ],
  refresh: [
    { d: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8' },
    { d: 'M21 3v5h-5' },
  ],
  trash: [
    { d: 'M3 6h18' },
    { d: 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6' },
    { d: 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2' },
  ],
  search: [
    { d: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z' },
    { d: 'm21 21-4.3-4.3' },
  ],
  restore: [
    { d: 'M3 7v6h6' },
    { d: 'M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13' },
  ],
  wrench: [
    {
      d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
    },
  ],
  globe: [
    { d: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z' },
    { d: 'M2 12h20' },
    { d: 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z' },
  ],
  close: [{ d: 'M18 6 6 18' }, { d: 'm6 6 12 12' }],
  alert: [
    { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z' },
    { d: 'M12 9v4' },
    { d: 'M12 17h.01' },
  ],
  settings: [
    { d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z' },
    { d: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z' },
  ],
  shield: [{ d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' }],
  eyeOff: [
    { d: 'M9.88 9.88a3 3 0 1 0 4.24 4.24' },
    { d: 'M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68' },
    { d: 'M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61' },
    { d: 'm2 2 20 20' },
  ],
  history: [
    { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' },
    { d: 'M3 3v5h5' },
    { d: 'M12 7v5l4 2' },
  ],
  plus: [{ d: 'M5 12h14' }, { d: 'M12 5v14' }],
};

export function recBadge(rec: Recommendation, t: Dict) {
  if (rec === 'recommended') {
    return React.createElement(
      'span',
      {
        className: 'ac-pill',
        style: {
          background: 'var(--ac-success-bg)',
          color: 'var(--ac-success-text)',
          border: '1px solid var(--ac-success-border)',
        },
      },
      t.badgeRec,
    );
  }
  if (rec === 'optional') {
    return React.createElement(
      'span',
      {
        className: 'ac-pill',
        style: {
          background: 'var(--ac-warn-bg)',
          color: 'var(--ac-warn-text)',
          border: '1px solid var(--ac-warn-border)',
        },
      },
      t.badgeOpt,
    );
  }
  return React.createElement(
    'span',
    {
      className: 'ac-pill',
      style: {
        background: 'var(--ac-exempt-bg)',
        color: 'var(--ac-exempt-text)',
        border: '1px solid var(--ac-exempt-border)',
      },
    },
    t.badgeExempt,
  );
}
