import React, { useCallback, useEffect, useMemo, useState } from 'react';

export const name = 'agent-cleaner';
export const inject = ['slots'];

type Lang = 'zh' | 'en';
type Recommendation = 'recommended' | 'optional' | 'exempt';

const LANG_KEY = 'agent-cleaner-lang';

function readStoredLang(): Lang {
  try {
    return window.localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

function writeStoredLang(lang: Lang): void {
  try {
    window.localStorage.setItem(LANG_KEY, lang);
  } catch {
    // ignore storage errors
  }
}

interface ScanItem {
  id: string;
  agent: string;
  category: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  description: string;
  status: string;
  recommendation: Recommendation;
  recommendationReason: string;
}

interface ScanResult {
  agent: string;
  items: ScanItem[];
  totalBytes: number;
  diskUsageBytes: number;
}

interface DoctorReport {
  agent: string;
  path: string;
  healthy: boolean;
  issues: Array<{ id: string; message: string }>;
}

interface TrashBatch {
  batchId: string;
  timestamp: number;
  totalBytes: number;
  items: Array<{ id: string; agent: string; originalPath: string; sizeBytes: number }>;
}

interface OverviewPayload {
  agents: ScanResult[];
  doctors: DoctorReport[];
  mcpAudit: {
    audit: {
      entries: unknown[];
      deadLinks: Array<{ agent: string; name: string; command?: string }>;
      orphanProcesses: Array<{ pid: number; command: string; rssKb: number }>;
      coldCaches: Array<{ source: string; path: string; sizeBytes: number; lastAccessDays: number }>;
    };
  };
  trash: TrashBatch[];
  exemptHours: number;
}

const DICT = {
  zh: {
    subtitle: '自由勾选清理 · 24h 活跃保护 · 可逆回收站',
    guardLabel: '保护窗',
    guardOff: '0h (全部可清)',
    h12: '12 小时',
    h24: '24 小时 (默认)',
    h48: '48 小时',
    d7: '7 天',
    rescan: '刷新扫描',
    scanning: '扫描中...',
    totalDisk: 'Agent 总占用',
    recCard: (n: number) => `推荐清理 (${n} 项)`,
    reclaimCard: '发现可清理总量',
    statusCard: 'MCP / 配置 / 回收站',
    tabScan: (n: number) => `空间清理 (${n})`,
    tabMcp: (n: number) => `MCP 雷达 (${n})`,
    tabDoctor: (n: number) => `配置自愈 (${n})`,
    tabTrash: (n: number) => `回收站 (${n})`,
    breakdownTitle: '各 Agent 占用分布（点击区块筛选）',
    filterAll: (n: number) => `全部 (${n})`,
    filterRec: (n: number) => `推荐 (${n})`,
    filterOpt: (n: number) => `复核 (${n})`,
    filterExempt: (n: number) => `豁免 (${n})`,
    searchPlaceholder: '搜索路径或描述...',
    selectRec: '只选推荐项',
    selectVisible: '全选当前',
    clearSel: '清空',
    selectedPrefix: '已勾选 ',
    selectedMid: ' 项，合计可释放 ',
    dryRun: '预演 (Dry-Run)',
    deleteSelected: (s: string) => `删除所选到回收站 (${s})`,
    badgeRec: '推荐清理',
    badgeOpt: '建议复核',
    badgeExempt: '活跃豁免',
    noItems: '当前筛选条件下无匹配条目',
    mcpTitle: 'PPID=1 孤儿 stdio 进程',
    killAll: '一键查杀',
    noOrphans: '暂无孤儿 MCP 进程',
    doctorFix: '一键保注释修复',
    healthy: '健康',
    issueCount: (n: number) => `${n} 个问题`,
    restore: '原路还原',
    purge: '永久删除',
    trashEmpty: '回收站为空',
    labelDryRun: '预演',
    labelClean: '清理',
    labelMcpKill: '查杀孤儿 MCP',
    labelDoctorFix: '保注释自愈',
    labelRestore: '原路还原',
    labelPurge: '永久清除',
  },
  en: {
    subtitle: 'Rust Native Core · Free Selection · 24h Active Guard · Reversible Trash',
    guardLabel: 'Guard',
    guardOff: '0h (All eligible)',
    h12: '12 Hours',
    h24: '24 Hours (Default)',
    h48: '48 Hours',
    d7: '7 Days',
    rescan: 'Rescan',
    scanning: 'Scanning...',
    totalDisk: 'Total Disk Usage',
    recCard: (n: number) => `Recommended (${n})`,
    reclaimCard: 'Total Reclaimable',
    statusCard: 'MCP / Config / Trash',
    tabScan: (n: number) => `Cleanup (${n})`,
    tabMcp: (n: number) => `MCP Radar (${n})`,
    tabDoctor: (n: number) => `Config Doctor (${n})`,
    tabTrash: (n: number) => `Trash (${n})`,
    breakdownTitle: 'Disk Usage by Agent (click to filter)',
    filterAll: (n: number) => `All (${n})`,
    filterRec: (n: number) => `Recommended (${n})`,
    filterOpt: (n: number) => `Optional (${n})`,
    filterExempt: (n: number) => `Exempt (${n})`,
    searchPlaceholder: 'Search path or description...',
    selectRec: 'Recommended Only',
    selectVisible: 'Select Visible',
    clearSel: 'Clear',
    selectedPrefix: 'Selected ',
    selectedMid: ' item(s), reclaimable ',
    dryRun: 'Dry-Run',
    deleteSelected: (s: string) => `Move Selected to Trash (${s})`,
    badgeRec: 'Recommended',
    badgeOpt: 'Optional',
    badgeExempt: 'Active Guard',
    noItems: 'No matching items under current filters',
    mcpTitle: 'PPID=1 Orphan stdio Processes',
    killAll: 'Terminate All',
    noOrphans: 'No orphan MCP processes detected',
    doctorFix: 'Auto-Heal (Preserve Comments)',
    healthy: 'Healthy',
    issueCount: (n: number) => `${n} issue(s)`,
    restore: 'Restore',
    purge: 'Purge',
    trashEmpty: 'Trash is empty',
    labelDryRun: 'Dry-Run',
    labelClean: 'Clean',
    labelMcpKill: 'Kill Orphan MCP',
    labelDoctorFix: 'Config Auto-Heal',
    labelRestore: 'Restore Batch',
    labelPurge: 'Purge Batch',
  },
} as const;

const AGENT_COLORS = [
  '#06b6d4',
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#6366f1',
  '#f43f5e',
  '#14b8a6',
];

const SCOPED_CSS = `
.ac-dsh-root {
  --ac-text-primary: var(--dsw-alias-label-primary, #0f172a);
  --ac-text-secondary: var(--dsw-alias-label-secondary, #334155);
  --ac-text-muted: var(--dsw-alias-label-tertiary, #64748b);
  --ac-surface: var(--dsw-alias-card-fill, #f8fafc);
  --ac-surface-hover: var(--dsw-alias-card-fill-hover, #f1f5f9);
  --ac-input-bg: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-1, #ffffff));
  --ac-border: var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.12));
  --ac-border-strong: var(--dsw-alias-border-l3, rgba(15, 23, 42, 0.22));
  --ac-hover-bg: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  --ac-active-bg: var(--dsw-alias-interactive-bg-active, rgba(38, 49, 72, 0.1));
  --ac-track-bg: rgba(15, 23, 42, 0.08);
  --ac-accent: var(--dsw-alias-state-business-primary, #0284c7);
  --ac-accent-soft: var(--dsw-alias-state-business-tertiary, rgba(2, 132, 199, 0.12));
  --ac-accent-border: rgba(2, 132, 199, 0.38);
  --ac-on-accent: var(--dsw-alias-label-on-color, #ffffff);
  --ac-success-text: #047857;
  --ac-success-bg: var(--dsw-alias-state-success-tertiary, rgba(16, 185, 129, 0.14));
  --ac-success-border: rgba(5, 150, 105, 0.32);
  --ac-warn-text: var(--dsw-alias-state-warn-label, #b45309);
  --ac-warn-bg: var(--dsw-alias-state-warn-tertiary, rgba(245, 158, 11, 0.14));
  --ac-warn-border: rgba(217, 119, 6, 0.34);
  --ac-danger-text: var(--dsw-alias-state-error-primary, #dc2626);
  --ac-danger-bg: rgba(220, 38, 38, 0.09);
  --ac-danger-border: rgba(220, 38, 38, 0.35);
  --ac-info-text: #1d4ed8;
  --ac-info-bg: rgba(37, 99, 235, 0.12);
  --ac-exempt-text: var(--dsw-alias-label-tertiary, #475569);
  --ac-exempt-bg: rgba(100, 116, 139, 0.12);
  --ac-exempt-border: rgba(100, 116, 139, 0.24);

  height: 100%;
  display: flex;
  flex-direction: column;
  color-scheme: light;
  color: var(--ac-text-primary);
  font-family: var(--dsh-font-family-text, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', sans-serif);
  box-sizing: border-box;
}
body[data-ds-dark-theme] .ac-dsh-root {
  --ac-text-primary: var(--dsw-alias-label-primary, #e2e8f0);
  --ac-text-secondary: var(--dsw-alias-label-secondary, #cbd5e1);
  --ac-text-muted: var(--dsw-alias-label-tertiary, #94a3b8);
  --ac-surface: var(--dsw-alias-card-fill, rgba(15, 23, 42, 0.42));
  --ac-surface-hover: var(--dsw-alias-card-fill-hover, rgba(30, 41, 59, 0.55));
  --ac-input-bg: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-1, rgba(2, 6, 23, 0.35)));
  --ac-border: var(--dsw-alias-border-l2, rgba(148, 163, 184, 0.22));
  --ac-border-strong: var(--dsw-alias-border-l3, rgba(148, 163, 184, 0.42));
  --ac-hover-bg: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08));
  --ac-active-bg: var(--dsw-alias-interactive-bg-active, rgba(255, 255, 255, 0.14));
  --ac-track-bg: rgba(148, 163, 184, 0.14);
  --ac-accent: var(--dsw-alias-state-business-primary, #22d3ee);
  --ac-accent-soft: var(--dsw-alias-state-business-tertiary, rgba(6, 182, 212, 0.14));
  --ac-accent-border: rgba(56, 189, 248, 0.42);
  --ac-on-accent: var(--dsw-alias-label-on-color, #ffffff);
  --ac-success-text: #34d399;
  --ac-success-bg: rgba(16, 185, 129, 0.16);
  --ac-success-border: rgba(16, 185, 129, 0.28);
  --ac-warn-text: #fbbf24;
  --ac-warn-bg: rgba(245, 158, 11, 0.16);
  --ac-warn-border: rgba(245, 158, 11, 0.28);
  --ac-danger-text: var(--dsw-alias-state-error-primary, #fb7185);
  --ac-danger-bg: rgba(244, 63, 94, 0.12);
  --ac-danger-border: rgba(244, 63, 94, 0.45);
  --ac-info-text: #93c5fd;
  --ac-info-bg: rgba(59, 130, 246, 0.16);
  --ac-exempt-text: var(--dsw-alias-label-tertiary, #94a3b8);
  --ac-exempt-bg: rgba(148, 163, 184, 0.16);
  --ac-exempt-border: rgba(148, 163, 184, 0.22);
  color-scheme: dark;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-ds-theme-source]) .ac-dsh-root {
    --ac-text-primary: var(--dsw-alias-label-primary, #e2e8f0);
    --ac-text-secondary: var(--dsw-alias-label-secondary, #cbd5e1);
    --ac-text-muted: var(--dsw-alias-label-tertiary, #94a3b8);
    --ac-surface: var(--dsw-alias-card-fill, rgba(15, 23, 42, 0.42));
    --ac-surface-hover: var(--dsw-alias-card-fill-hover, rgba(30, 41, 59, 0.55));
    --ac-input-bg: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-1, rgba(2, 6, 23, 0.35)));
    --ac-border: var(--dsw-alias-border-l2, rgba(148, 163, 184, 0.22));
    --ac-border-strong: var(--dsw-alias-border-l3, rgba(148, 163, 184, 0.42));
    --ac-hover-bg: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08));
    --ac-active-bg: var(--dsw-alias-interactive-bg-active, rgba(255, 255, 255, 0.14));
    --ac-track-bg: rgba(148, 163, 184, 0.14);
    --ac-accent: var(--dsw-alias-state-business-primary, #22d3ee);
    --ac-accent-soft: var(--dsw-alias-state-business-tertiary, rgba(6, 182, 212, 0.14));
    --ac-accent-border: rgba(56, 189, 248, 0.42);
    --ac-on-accent: var(--dsw-alias-label-on-color, #ffffff);
    --ac-success-text: #34d399;
    --ac-success-bg: rgba(16, 185, 129, 0.16);
    --ac-success-border: rgba(16, 185, 129, 0.28);
    --ac-warn-text: #fbbf24;
    --ac-warn-bg: rgba(245, 158, 11, 0.16);
    --ac-warn-border: rgba(245, 158, 11, 0.28);
    --ac-danger-text: var(--dsw-alias-state-error-primary, #fb7185);
    --ac-danger-bg: rgba(244, 63, 94, 0.12);
    --ac-danger-border: rgba(244, 63, 94, 0.45);
    --ac-info-text: #93c5fd;
    --ac-info-bg: rgba(59, 130, 246, 0.16);
    --ac-exempt-text: var(--dsw-alias-label-tertiary, #94a3b8);
    --ac-exempt-bg: rgba(148, 163, 184, 0.16);
    --ac-exempt-border: rgba(148, 163, 184, 0.22);
    color-scheme: dark;
  }
}
.ac-dsh-root * { box-sizing: border-box; }
.ac-drag-strip {
  flex: none;
  height: calc(28px + var(--dsh-frame-top-clearance, 0px));
  min-height: 28px;
  width: 100%;
  -webkit-app-region: drag;
  user-select: none;
}
.ac-scroll-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 24px 36px;
}
.ac-num { font-variant-numeric: tabular-nums; font-family: var(--dsh-font-family-code, ui-monospace, 'Fira Code', monospace); }
.ac-header {
  display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px;
  padding-bottom: 14px; margin-bottom: 16px;
  border-bottom: 1px solid var(--ac-border);
  -webkit-app-region: drag;
}
.ac-no-drag {
  -webkit-app-region: no-drag;
}
.ac-card {
  padding: 12px 14px; border-radius: 12px;
  border: 1px solid var(--ac-border);
  background: var(--ac-surface);
  transition: border-color 180ms ease, background-color 180ms ease;
}
.ac-row-card {
  display: flex; align-items: flex-start; gap: 10px; cursor: pointer;
}
.ac-row-card:hover {
  border-color: var(--ac-accent-border);
  background: var(--ac-surface-hover);
}
.ac-btn {
  display: inline-flex; align-items: center; gap: 6px; border-radius: 8px; font-size: 12px;
  cursor: pointer; transition: background-color 160ms ease, border-color 160ms ease, opacity 160ms ease;
  -webkit-app-region: no-drag;
}
.ac-btn:focus-visible, .ac-input:focus-visible, .ac-select:focus-visible {
  outline: 2px solid var(--ac-accent); outline-offset: 1px;
}
.ac-btn:disabled { opacity: 0.42; cursor: not-allowed; }
.ac-btn-primary {
  padding: 7px 14px; border: none; font-weight: 600;
  background: var(--dsw-alias-button-info-fill, var(--ac-accent)); color: var(--ac-on-accent);
}
.ac-btn-primary:hover:not(:disabled) { filter: brightness(1.08); }
.ac-btn-ghost {
  padding: 6px 11px; border: 1px solid var(--ac-border);
  background: transparent; color: var(--ac-text-primary);
}
.ac-btn-ghost:hover:not(:disabled) {
  border-color: var(--ac-border-strong); background: var(--ac-hover-bg);
}
.ac-input, .ac-select {
  border: 1px solid var(--ac-border);
  background: var(--ac-input-bg);
  color: var(--ac-text-primary); border-radius: 8px; font-size: 12px;
  -webkit-app-region: no-drag;
}
.ac-input::placeholder { color: var(--ac-text-muted); opacity: 1; }
.ac-input { padding: 5px 10px 5px 28px; min-width: 180px; }
.ac-select { padding: 5px 8px; cursor: pointer; }
.ac-pill {
  display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px;
  font-size: 11px; font-weight: 600; line-height: 1.4;
}
@media (prefers-reduced-motion: reduce) {
  .ac-card, .ac-btn { transition: none !important; }
}
`;

function formatBytes(bytes: number): string {
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

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
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

function SvgIcon({
  size = 16,
  paths,
}: {
  size?: number;
  paths: Array<{ d: string }>;
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
      style: { flexShrink: 0 },
    },
    ...paths.map((p, idx) => React.createElement('path', { key: idx, d: p.d })),
  );
}

const ICONS = {
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
};

function recBadge(rec: Recommendation, t: (typeof DICT)[Lang]) {
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

function CleanerPanel() {
  const [lang, setLang] = useState<Lang>(readStoredLang);
  const [data, setData] = useState<OverviewPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'scan' | 'mcp' | 'doctor' | 'trash'>('scan');
  const [recFilter, setRecFilter] = useState<'all' | Recommendation>('all');
  const [agentFilter, setAgentFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [exemptHours, setExemptHours] = useState<number>(24);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);

  const t = DICT[lang];

  const load = useCallback(
    async (hours = exemptHours, curLang = lang, preserveSelection = false) => {
      setLoading(true);
      try {
        const ov = await apiJson<OverviewPayload>(
          `/agent-cleaner/api/overview?hours=${hours}&lang=${curLang}`,
        );
        setData(ov);
        if (!preserveSelection) {
          const next = new Set<string>();
          for (const ag of ov.agents) {
            for (const it of ag.items) {
              if (it.recommendation === 'recommended') next.add(it.id);
            }
          }
          setSelectedIds(next);
        }
      } catch (err) {
        setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
      } finally {
        setLoading(false);
      }
    },
    [exemptHours, lang],
  );

  useEffect(() => {
    void load(exemptHours, lang, false);
  }, [exemptHours, lang, load]);

  const toggleLanguage = () => {
    const next: Lang = lang === 'zh' ? 'en' : 'zh';
    writeStoredLang(next);
    setLang(next);
  };

  const agents = data?.agents ?? [];
  const allItems = useMemo(() => agents.flatMap((a) => a.items), [agents]);

  const visibleItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const rank = (r: Recommendation) => (r === 'recommended' ? 0 : r === 'optional' ? 1 : 2);
    return allItems
      .filter((it) => (agentFilter === 'all' ? true : it.agent === agentFilter))
      .filter((it) => (recFilter === 'all' ? true : it.recommendation === recFilter))
      .filter((it) =>
        q
          ? it.path.toLowerCase().includes(q) ||
            it.description.toLowerCase().includes(q) ||
            it.agent.toLowerCase().includes(q) ||
            it.recommendationReason.toLowerCase().includes(q)
          : true,
      )
      .sort((a, b) => rank(a.recommendation) - rank(b.recommendation) || b.sizeBytes - a.sizeBytes);
  }, [allItems, agentFilter, recFilter, searchQuery]);

  const selectedItems = useMemo(
    () => allItems.filter((it) => selectedIds.has(it.id)),
    [allItems, selectedIds],
  );
  const selectedBytes = useMemo(
    () => selectedItems.reduce((s, it) => s + it.sizeBytes, 0),
    [selectedItems],
  );

  const toggleItem = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runAction = async (label: string, url: string, body: unknown = {}) => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await apiJson<any>(url, { method: 'POST', body: JSON.stringify(body) });
      if (res?.dryRun) {
        setNotice({
          kind: 'info',
          text:
            lang === 'zh'
              ? `[预演模式] 将移入回收站 ${res.cleanedCount ?? 0} 项，预计释放 ${formatBytes(res.freedBytes ?? 0)}`
              : `[Dry-Run] Would move ${res.cleanedCount ?? 0} item(s) to trash, freeing ${formatBytes(res.freedBytes ?? 0)}`,
        });
      } else if (res?.batchId) {
        setNotice({
          kind: 'info',
          text:
            lang === 'zh'
              ? `${label}成功：已移入回收站 ${res.cleanedCount ?? 0} 项（释放 ${formatBytes(res.freedBytes ?? 0)}），还原批次：${res.batchId}`
              : `${label} succeeded: moved ${res.cleanedCount ?? 0} item(s) (${formatBytes(res.freedBytes ?? 0)}), batchId: ${res.batchId}`,
        });
        await load(exemptHours, lang, false);
      } else {
        setNotice({ kind: 'info', text: `${label}: OK` });
        await load(exemptHours, lang, false);
      }
    } catch (err) {
      setNotice({
        kind: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const totalDisk = agents.reduce((s, a) => s + (a.diskUsageBytes || 0), 0);
  const safeTotalDisk = Math.max(1, totalDisk);
  const totalReclaim = agents.reduce((s, a) => s + (a.totalBytes || 0), 0);
  const recItems = allItems.filter((i) => i.recommendation === 'recommended');
  const recBytes = recItems.reduce((s, i) => s + i.sizeBytes, 0);
  const optCount = allItems.filter((i) => i.recommendation === 'optional').length;
  const exemptCount = allItems.filter((i) => i.recommendation === 'exempt').length;
  const orphans = data?.mcpAudit?.audit?.orphanProcesses ?? [];
  const issuesCount = (data?.doctors ?? []).reduce((s, d) => s + d.issues.length, 0);

  return React.createElement(
    'div',
    { className: 'ac-dsh-root' },
    React.createElement('style', null, SCOPED_CSS),
    React.createElement('div', { className: 'ac-drag-strip', 'aria-hidden': 'true' }),

    React.createElement(
      'div',
      { className: 'ac-scroll-body' },
      // Header (blank spaces draggable; controls marked no-drag)
      React.createElement(
        'div',
        { className: 'ac-header' },
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          React.createElement(
            'div',
            {
              style: {
                width: 34,
                height: 34,
                borderRadius: 10,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'var(--ac-accent-soft)',
                color: 'var(--ac-accent)',
                border: '1px solid var(--ac-accent-border)',
              },
            },
            React.createElement(SvgIcon, { size: 18, paths: ICONS.broom }),
          ),
          React.createElement(
            'div',
            null,
            React.createElement('div', { style: { fontSize: 15, fontWeight: 600 } }, 'Agent Cleaner'),
            React.createElement('div', { style: { fontSize: 12, color: 'var(--ac-text-secondary)' } }, t.subtitle),
          ),
        ),
        React.createElement(
          'div',
          {
            className: 'ac-no-drag',
            style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
          },
          React.createElement(
            'button',
            {
              className: 'ac-btn ac-btn-ghost',
              onClick: toggleLanguage,
              title: lang === 'zh' ? 'Switch to English' : '切换为中文',
            },
            React.createElement(SvgIcon, { size: 14, paths: ICONS.globe }),
            lang === 'zh' ? '中文 / EN' : 'EN / 中文',
          ),
          React.createElement(
            'label',
            { style: { fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 } },
            React.createElement('span', { style: { color: 'var(--ac-text-secondary)' } }, t.guardLabel),
            React.createElement(
              'select',
              {
                className: 'ac-select',
                value: exemptHours,
                onChange: (e: any) => setExemptHours(Number(e.target.value)),
              },
              React.createElement('option', { value: 0 }, t.guardOff),
              React.createElement('option', { value: 12 }, t.h12),
              React.createElement('option', { value: 24 }, t.h24),
              React.createElement('option', { value: 48 }, t.h48),
              React.createElement('option', { value: 168 }, t.d7),
            ),
          ),
          React.createElement(
            'button',
            {
              className: 'ac-btn ac-btn-ghost',
              disabled: loading || busy,
              onClick: () => void load(exemptHours, lang, false),
            },
            React.createElement(SvgIcon, { size: 14, paths: ICONS.refresh }),
            loading ? t.scanning : t.rescan,
          ),
        ),
      ),

      // Feedback Banner
      notice &&
        React.createElement(
          'div',
          {
            role: 'alert',
            className: 'ac-card',
            style: {
              marginBottom: 14,
              borderColor:
                notice.kind === 'error' ? 'var(--ac-danger-border)' : 'var(--ac-accent-border)',
              background:
                notice.kind === 'error' ? 'var(--ac-danger-bg)' : 'var(--ac-accent-soft)',
              color: notice.kind === 'error' ? 'var(--ac-danger-text)' : 'var(--ac-text-primary)',
              fontSize: 12,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 10,
            },
          },
          React.createElement('span', null, notice.text),
          React.createElement(
            'button',
            {
              className: 'ac-btn ac-btn-ghost',
              style: { padding: 4 },
              'aria-label': 'Close',
              onClick: () => setNotice(null),
            },
            React.createElement(SvgIcon, { size: 13, paths: ICONS.close }),
          ),
        ),

      // KPI Cards
      React.createElement(
        'div',
        {
          style: {
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: 10,
            marginBottom: 14,
          },
        },
        React.createElement(
          'div',
          { className: 'ac-card' },
          React.createElement('div', { style: { fontSize: 11, color: 'var(--ac-text-muted)' } }, t.totalDisk),
          React.createElement(
            'div',
            { className: 'ac-num', style: { fontSize: 19, fontWeight: 700, marginTop: 4 } },
            formatBytes(totalDisk),
          ),
        ),
        React.createElement(
          'div',
          { className: 'ac-card', style: { borderColor: 'var(--ac-success-border)' } },
          React.createElement(
            'div',
            { style: { fontSize: 11, color: 'var(--ac-text-muted)' } },
            t.recCard(recItems.length),
          ),
          React.createElement(
            'div',
            {
              className: 'ac-num',
              style: { fontSize: 19, fontWeight: 700, marginTop: 4, color: 'var(--ac-success-text)' },
            },
            formatBytes(recBytes),
          ),
        ),
        React.createElement(
          'div',
          { className: 'ac-card' },
          React.createElement('div', { style: { fontSize: 11, color: 'var(--ac-text-muted)' } }, t.reclaimCard),
          React.createElement(
            'div',
            {
              className: 'ac-num',
              style: { fontSize: 19, fontWeight: 700, marginTop: 4, color: 'var(--ac-accent)' },
            },
            formatBytes(totalReclaim),
          ),
        ),
        React.createElement(
          'div',
          { className: 'ac-card' },
          React.createElement('div', { style: { fontSize: 11, color: 'var(--ac-text-muted)' } }, t.statusCard),
          React.createElement(
            'div',
            { className: 'ac-num', style: { fontSize: 19, fontWeight: 700, marginTop: 4 } },
            `${orphans.length} / ${issuesCount} / ${data?.trash?.length ?? 0}`,
          ),
        ),
      ),

      // Tabs
      React.createElement(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 } },
        (['scan', 'mcp', 'doctor', 'trash'] as const).map((k) =>
          React.createElement(
            'button',
            {
              key: k,
              className: `ac-btn ${tab === k ? 'ac-btn-primary' : 'ac-btn-ghost'}`,
              onClick: () => setTab(k),
            },
            k === 'scan'
              ? t.tabScan(allItems.length)
              : k === 'mcp'
                ? t.tabMcp(orphans.length)
                : k === 'doctor'
                  ? t.tabDoctor(issuesCount)
                  : t.tabTrash(data?.trash?.length ?? 0),
          ),
        ),
      ),

      tab === 'scan' &&
        React.createElement(
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
                agents
                  .filter((a) => a.diskUsageBytes > 0)
                  .map((a, idx) =>
                    React.createElement('button', {
                      key: a.agent,
                      type: 'button',
                      title: `${a.agent}: ${formatBytes(a.diskUsageBytes)}`,
                      onClick: () =>
                        setAgentFilter((prev) => (prev === a.agent ? 'all' : a.agent)),
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
                agents
                  .filter((a) => a.diskUsageBytes > 0)
                  .map((a, idx) =>
                    React.createElement(
                      'button',
                      {
                        key: a.agent,
                        type: 'button',
                        onClick: () =>
                          setAgentFilter((prev) => (prev === a.agent ? 'all' : a.agent)),
                        style: {
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 5,
                          border: 'none',
                          background:
                            agentFilter === a.agent ? 'var(--ac-active-bg)' : 'transparent',
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
                      a.agent,
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
                  ['recommended', t.filterRec(recItems.length)],
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
              { style: { display: 'flex', gap: 8 } },
              React.createElement(
                'button',
                {
                  className: 'ac-btn ac-btn-ghost',
                  disabled: busy || selectedItems.length === 0,
                  onClick: () =>
                    void runAction(t.labelDryRun, '/agent-cleaner/api/clean', {
                      exemptHours,
                      lang,
                      dryRun: true,
                      selectedIds: selectedItems.map((i) => i.id),
                    }),
                },
                t.dryRun,
              ),
              React.createElement(
                'button',
                {
                  className: 'ac-btn ac-btn-primary',
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
                  checked,
                  onChange: () => toggleItem(it.id),
                  style: { marginTop: 3, accentColor: 'var(--ac-accent)', cursor: 'pointer' },
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
                      it.agent,
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
                    className: 'ac-num',
                    style: { fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' },
                  },
                  formatBytes(it.sizeBytes),
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
        ),

      tab === 'mcp' &&
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
            : orphans.map((p) =>
                React.createElement(
                  'div',
                  { key: p.pid, className: 'ac-num', style: { fontSize: 12, marginTop: 6 } },
                  `PID ${p.pid}: ${p.command}`,
                ),
              ),
        ),

      tab === 'doctor' &&
        React.createElement(
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
          (data?.doctors ?? []).map((doc) =>
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
                React.createElement('span', null, doc.agent),
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
              doc.issues.map((iss) =>
                React.createElement(
                  'div',
                  { key: iss.id, style: { fontSize: 12, marginTop: 6, color: 'var(--ac-warn-text)' } },
                  iss.message,
                ),
              ),
            ),
          ),
        ),

      tab === 'trash' &&
        React.createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          (data?.trash ?? []).map((b) =>
            React.createElement(
              'div',
              {
                key: b.batchId,
                className: 'ac-card',
                style: {
                  display: 'flex',
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
                ` · ${b.items.length} · ${formatBytes(b.totalBytes)}`,
              ),
              React.createElement(
                'div',
                { style: { display: 'flex', gap: 6 } },
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
          ),
          (!data?.trash || data.trash.length === 0) &&
            React.createElement(
              'div',
              { className: 'ac-card', style: { fontSize: 12, color: 'var(--ac-text-muted)' } },
              t.trashEmpty,
            ),
        ),
    ),
  );
}

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
