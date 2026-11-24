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

interface DoctorIssue {
  id: string;
  message: string;
  severity?: 'error' | 'warning' | 'info';
  autoFixable?: boolean;
}

interface DoctorReport {
  agent: string;
  path: string;
  healthy: boolean;
  issues: DoctorIssue[];
}

interface TrashBatch {
  batchId: string;
  timestamp: number;
  totalBytes: number;
  items: Array<{ id: string; agent: string; originalPath: string; sizeBytes: number }>;
}

interface McpEntry {
  agent: string;
  name: string;
  command?: string;
  url?: string;
  configPath?: string;
}

interface McpOrphanProcess {
  pid: number;
  command: string;
  rssKb: number;
  matchedName?: string;
  matchedAgent?: string;
}

interface OverviewPayload {
  agents: ScanResult[];
  doctors: DoctorReport[];
  mcpAudit: {
    audit: {
      entries: unknown[];
      deadLinks: McpEntry[];
      duplicates?: McpEntry[][];
      orphanProcesses: McpOrphanProcess[];
      coldCaches: Array<{ source: string; path: string; sizeBytes: number; lastAccessDays: number }>;
    };
  };
  trash: TrashBatch[];
  disk?: { totalBytes: number; availableBytes: number } | null;
  exemptHours: number;
  scannedAt?: number;
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
    lastScanned: (s: string) => `上次扫描：${s}`,
    scanningTitle: '正在扫描 AI Agent 环境...',
    rescanningTitle: '正在重新扫描环境...',
    scanningSubtitle: '正在检测各工具磁盘缓存、MCP 僵尸进程与配置文件',
    totalDisk: 'Agent 总占用',
    diskSpace: '磁盘剩余空间',
    diskSpaceHint: (total: string, pct: number) => `共 ${total} · 已用 ${pct}%`,
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
    deleteSelected: (s: string) => `删除所选到回收站 (${s})`,
    deletePermanently: '彻底删除',
    confirmPermanentTitle: '确认彻底删除',
    confirmPermanentDesc: (n: number, s: string) =>
      `确定要彻底删除所选的 ${n} 项（共 ${s}）吗？此操作不会进入回收站，删除后无法恢复。`,
    cancel: '取消',
    confirmDelete: '确认彻底删除',
    badgeRec: '推荐清理',
    badgeOpt: '建议复核',
    badgeExempt: '活跃豁免',
    noItems: '当前筛选条件下无匹配条目',
    mcpTitle: 'PPID=1 孤儿 stdio 进程',
    killAll: '一键全部查杀',
    killOne: '查杀',
    noOrphans: '暂无孤儿 MCP 进程',
    deadLinksTitle: (n: number) => `失效 MCP 死链 (${n})`,
    noDeadLinks: '暂无失效 MCP 死链',
    duplicatesTitle: (n: number) => `跨 Agent 重复 MCP 配置 (${n})`,
    coldCachesTitle: (n: number) => `冷缓存 (>14 天未访问) (${n})`,
    noColdCaches: '暂无长期未访问的 npx / uv 冷缓存',
    doctorFix: '一键保注释修复',
    healthy: '健康',
    issueCount: (n: number) => `${n} 个问题`,
    autoFixable: '可自动修复',
    trashSummary: (count: number, total: string) => `共 ${count} 个还原批次，回收站总占用 ${total}`,
    purgeAll: '一键清空回收站',
    details: '查看明细',
    hideDetails: '收起明细',
    itemsUnit: (n: number) => `${n} 项`,
    restore: '原路还原',
    purge: '永久删除',
    trashEmpty: '回收站为空',
    labelClean: '清理',
    labelPermanentDelete: '彻底删除',
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
    lastScanned: (s: string) => `Scanned ${s}`,
    scanningTitle: 'Scanning AI Agent Environments...',
    rescanningTitle: 'Rescanning Environments...',
    scanningSubtitle: 'Inspecting disk caches, orphan MCP processes, and config files',
    totalDisk: 'Total Disk Usage',
    diskSpace: 'Free Disk Space',
    diskSpaceHint: (total: string, pct: number) => `of ${total} · ${pct}% used`,
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
    deleteSelected: (s: string) => `Move Selected to Trash (${s})`,
    deletePermanently: 'Delete Permanently',
    confirmPermanentTitle: 'Confirm Permanent Deletion',
    confirmPermanentDesc: (n: number, s: string) =>
      `Permanently delete ${n} selected item(s) (${s})? This bypasses the trash and cannot be undone.`,
    cancel: 'Cancel',
    confirmDelete: 'Delete Permanently',
    badgeRec: 'Recommended',
    badgeOpt: 'Optional',
    badgeExempt: 'Active Guard',
    noItems: 'No matching items under current filters',
    mcpTitle: 'PPID=1 Orphan stdio Processes',
    killAll: 'Terminate All',
    killOne: 'Kill',
    noOrphans: 'No orphan MCP processes detected',
    deadLinksTitle: (n: number) => `Dead MCP Links (${n})`,
    noDeadLinks: 'No dead MCP links',
    duplicatesTitle: (n: number) => `Cross-Agent Duplicate MCPs (${n})`,
    coldCachesTitle: (n: number) => `Cold Caches (>14d unused) (${n})`,
    noColdCaches: 'No cold npx / uv caches',
    doctorFix: 'Auto-Heal (Preserve Comments)',
    healthy: 'Healthy',
    issueCount: (n: number) => `${n} issue(s)`,
    autoFixable: 'Auto-fixable',
    trashSummary: (count: number, total: string) => `${count} batch(es), total trash usage: ${total}`,
    purgeAll: 'Purge All',
    details: 'Details',
    hideDetails: 'Hide',
    itemsUnit: (n: number) => `${n} item(s)`,
    restore: 'Restore',
    purge: 'Purge',
    trashEmpty: 'Trash is empty',
    labelClean: 'Clean',
    labelPermanentDelete: 'Permanent Delete',
    labelMcpKill: 'Kill Orphan MCP',
    labelDoctorFix: 'Config Auto-Heal',
    labelRestore: 'Restore Batch',
    labelPurge: 'Purge Batch',
  },
} as const;

const AGENT_COLORS = [
  '#b76745',
  '#737a45',
  '#b6883d',
  '#6e8554',
  '#8b7765',
  '#a95d4a',
  '#6f8469',
];

const SCOPED_CSS = `
.ac-dsh-root {
  --ac-canvas: 48 33% 95%;
  --ac-surface: 48 50% 98%;
  --ac-surface-hover: 45 42% 94%;
  --ac-input-bg: 48 40% 97%;
  --ac-ink: 60 3% 8%;
  --ac-text-primary: hsl(var(--ac-ink));
  --ac-text-secondary: hsl(50 5% 30%);
  --ac-text-muted: hsl(50 5% 36%);
  --ac-border: hsl(48 20% 89%);
  --ac-border-strong: hsl(48 6% 75%);
  --ac-hover-bg: hsl(48 33% 93%);
  --ac-active-bg: hsl(43 30% 88%);
  --ac-track-bg: hsl(48 20% 86%);
  --ac-accent: hsl(18 47% 50%);
  --ac-accent-strong: hsl(16 51% 42%);
  --ac-accent-soft: hsl(18 52% 93%);
  --ac-accent-border: hsl(18 32% 73%);
  --ac-on-accent: hsl(48 50% 98%);
  --ac-success-text: hsl(103 15% 35%);
  --ac-success-bg: hsl(103 22% 92%);
  --ac-success-border: hsl(103 14% 76%);
  --ac-warn-text: hsl(31 49% 35%);
  --ac-warn-bg: hsl(38 54% 91%);
  --ac-warn-border: hsl(34 34% 73%);
  --ac-danger-text: hsl(0 50% 38%);
  --ac-danger-bg: hsl(0 45% 94%);
  --ac-danger-border: hsl(0 25% 76%);
  --ac-danger-solid-bg: hsl(0 50% 38%);
  --ac-info-text: hsl(28 12% 38%);
  --ac-info-bg: hsl(30 15% 88%);
  --ac-exempt-text: hsl(50 5% 36%);
  --ac-exempt-bg: hsl(48 20% 91%);
  --ac-exempt-border: hsl(48 12% 78%);
  --ac-overlay-bg: hsl(40 20% 20% / 0.38);
  --ac-overlay-card: hsl(48 50% 98%);
  --ac-overlay-shadow: 0 18px 50px hsl(38 20% 15% / 0.16), 0 0 0 1px hsl(var(--ac-border));
  --ac-ring-track: hsl(18 30% 83%);
  --ac-shadow-card: 0 1px 2px hsl(38 20% 15% / 0.03), 0 0 0 1px hsl(var(--ac-border) / 0.55);
  --ac-font-display: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
  --ac-font-ui: Inter, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
  --ac-font-mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  --ac-transition-ui: 160ms cubic-bezier(0.2, 0.7, 0.2, 1);

  height: 100%;
  display: flex;
  flex-direction: column;
  color-scheme: light;
  color: var(--ac-text-primary);
  background: hsl(var(--ac-canvas));
  font-family: var(--ac-font-ui);
  box-sizing: border-box;
}
body[data-ds-dark-theme] .ac-dsh-root {
  --ac-canvas: 35 12% 12%;
  --ac-surface: 35 10% 16%;
  --ac-surface-hover: 34 10% 20%;
  --ac-input-bg: 34 9% 19%;
  --ac-ink: 43 30% 93%;
  --ac-text-primary: hsl(var(--ac-ink));
  --ac-text-secondary: hsl(38 12% 78%);
  --ac-text-muted: hsl(36 9% 67%);
  --ac-border: hsl(34 8% 29%);
  --ac-border-strong: hsl(32 8% 40%);
  --ac-hover-bg: hsl(34 9% 22%);
  --ac-active-bg: hsl(32 10% 25%);
  --ac-track-bg: hsl(34 8% 27%);
  --ac-accent: hsl(18 60% 63%);
  --ac-accent-strong: hsl(16 56% 57%);
  --ac-accent-soft: hsl(18 28% 24%);
  --ac-accent-border: hsl(18 30% 43%);
  --ac-success-text: hsl(95 25% 68%);
  --ac-success-bg: hsl(100 16% 21%);
  --ac-success-border: hsl(96 14% 36%);
  --ac-warn-text: hsl(38 65% 69%);
  --ac-warn-bg: hsl(35 30% 22%);
  --ac-warn-border: hsl(35 26% 38%);
  --ac-danger-text: hsl(5 70% 72%);
  --ac-danger-bg: hsl(0 25% 23%);
  --ac-danger-border: hsl(0 25% 42%);
  --ac-danger-solid-bg: hsl(0 48% 47%);
  --ac-info-text: hsl(32 25% 75%);
  --ac-info-bg: hsl(30 12% 23%);
  --ac-exempt-text: hsl(36 9% 72%);
  --ac-exempt-bg: hsl(34 8% 24%);
  --ac-exempt-border: hsl(34 8% 36%);
  --ac-overlay-bg: hsl(30 12% 5% / 0.72);
  --ac-overlay-card: hsl(35 10% 16%);
  --ac-overlay-shadow: 0 20px 44px hsl(30 12% 5% / 0.55);
  --ac-ring-track: hsl(18 24% 31%);
  --ac-shadow-card: 0 1px 2px hsl(30 12% 5% / 0.12), 0 0 0 1px hsl(var(--ac-border) / 0.55);
  color-scheme: dark;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-ds-theme-source]) .ac-dsh-root {
    --ac-canvas: 35 12% 12%;
    --ac-surface: 35 10% 16%;
    --ac-surface-hover: 34 10% 20%;
    --ac-input-bg: 34 9% 19%;
    --ac-ink: 43 30% 93%;
    --ac-text-primary: hsl(var(--ac-ink));
    --ac-text-secondary: hsl(38 12% 78%);
    --ac-text-muted: hsl(36 9% 67%);
    --ac-border: hsl(34 8% 29%);
    --ac-border-strong: hsl(32 8% 40%);
    --ac-hover-bg: hsl(34 9% 22%);
    --ac-active-bg: hsl(32 10% 25%);
    --ac-track-bg: hsl(34 8% 27%);
    --ac-accent: hsl(18 60% 63%);
    --ac-accent-strong: hsl(16 56% 57%);
    --ac-accent-soft: hsl(18 28% 24%);
    --ac-accent-border: hsl(18 30% 43%);
    --ac-success-text: hsl(95 25% 68%);
    --ac-success-bg: hsl(100 16% 21%);
    --ac-success-border: hsl(96 14% 36%);
    --ac-warn-text: hsl(38 65% 69%);
    --ac-warn-bg: hsl(35 30% 22%);
    --ac-warn-border: hsl(35 26% 38%);
    --ac-danger-text: hsl(5 70% 72%);
    --ac-danger-bg: hsl(0 25% 23%);
    --ac-danger-border: hsl(0 25% 42%);
    --ac-danger-solid-bg: hsl(0 48% 47%);
    --ac-info-text: hsl(32 25% 75%);
    --ac-info-bg: hsl(30 12% 23%);
    --ac-exempt-text: hsl(36 9% 72%);
    --ac-exempt-bg: hsl(34 8% 24%);
    --ac-exempt-border: hsl(34 8% 36%);
    --ac-overlay-bg: hsl(30 12% 5% / 0.72);
    --ac-overlay-card: hsl(35 10% 16%);
    --ac-overlay-shadow: 0 20px 44px hsl(30 12% 5% / 0.55);
    --ac-ring-track: hsl(18 24% 31%);
    --ac-shadow-card: 0 1px 2px hsl(30 12% 5% / 0.12), 0 0 0 1px hsl(var(--ac-border) / 0.55);
    color-scheme: dark;
  }
}
.ac-dsh-root * { box-sizing: border-box; }
.ac-dsh-root ::selection { background: hsl(var(--ac-accent) / 0.2); color: var(--ac-text-primary); }
.ac-drag-strip {
  flex: none;
  height: calc(28px + var(--dsh-frame-top-clearance, 0px));
  min-height: 28px;
  width: 100%;
  -webkit-app-region: drag;
  user-select: none;
}
.ac-header-wrap {
  flex: none;
  padding: 8px 28px 0;
}
.ac-body-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.ac-scroll-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 28px 40px;
  scrollbar-width: thin;
  scrollbar-color: hsl(var(--ac-border-strong)) transparent;
}
.ac-scroll-body::-webkit-scrollbar { width: 7px; height: 7px; }
.ac-scroll-body::-webkit-scrollbar-track { background: transparent; }
.ac-scroll-body::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 999px;
  background: hsl(var(--ac-border-strong));
  background-clip: padding-box;
}
.ac-num {
  font-variant-numeric: tabular-nums;
  font-family: var(--ac-font-mono);
}
.ac-display { font-family: var(--ac-font-display); letter-spacing: -0.025em; }
.ac-header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 12px 0 18px;
  margin-bottom: 20px;
  border-bottom: 1px solid var(--ac-border);
  -webkit-app-region: drag;
}
.ac-header > div:first-child > div:last-child > div:first-child {
  font-family: var(--ac-font-display);
  font-size: 21px !important;
  font-weight: 600 !important;
  letter-spacing: -0.025em;
  line-height: 1.15;
}
.ac-no-drag { -webkit-app-region: no-drag; }
.ac-card {
  padding: 16px;
  border-radius: 14px;
  border: 1px solid var(--ac-border);
  background: var(--ac-surface);
  box-shadow: var(--ac-shadow-card);
  transition: border-color var(--ac-transition-ui), background-color var(--ac-transition-ui), box-shadow var(--ac-transition-ui);
}
.ac-row-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  cursor: pointer;
}
.ac-row-card:hover {
  border-color: var(--ac-accent-border);
  background: var(--ac-surface-hover);
  box-shadow: 0 4px 16px hsl(30 15% 20% / 0.05);
}
.ac-btn {
  display: inline-flex;
  min-height: 34px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border: 1px solid transparent;
  border-radius: 10px;
  padding: 7px 13px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.2;
  cursor: pointer;
  transition:
    background-color var(--ac-transition-ui),
    border-color var(--ac-transition-ui),
    color var(--ac-transition-ui),
    box-shadow var(--ac-transition-ui),
    transform var(--ac-transition-ui);
  -webkit-app-region: no-drag;
}
.ac-btn:not(:disabled):active { transform: translateY(1px); }
.ac-btn:focus-visible, .ac-input:focus-visible, .ac-select:focus-visible, .ac-checkbox:focus-visible {
  outline: 2px solid hsl(207 86% 56%);
  outline-offset: 2px;
}
.ac-btn:disabled { opacity: 0.42; cursor: not-allowed; }
.ac-btn-primary {
  border-color: var(--ac-accent-strong);
  background: var(--ac-accent-strong);
  color: var(--ac-on-accent);
  box-shadow: 0 0 0 1px var(--ac-accent-strong);
}
.ac-btn-primary:hover:not(:disabled) {
  border-color: var(--ac-accent);
  background: var(--ac-accent);
  box-shadow: 0 0 0 1px var(--ac-accent);
}
.ac-btn-ghost {
  border-color: hsl(var(--ac-border-strong) / 0.7);
  background: var(--ac-hover-bg);
  color: var(--ac-text-secondary);
  box-shadow: 0 0 0 1px hsl(var(--ac-border-strong) / 0.2);
}
.ac-btn-ghost:hover:not(:disabled) {
  border-color: var(--ac-border-strong);
  background: var(--ac-surface);
  color: var(--ac-text-primary);
}
.ac-btn-danger {
  border-color: hsl(0 50% 38% / 0.2);
  background: var(--ac-danger-bg);
  color: var(--ac-danger-text);
  font-weight: 600;
}
.ac-btn-danger:hover:not(:disabled) { border-color: hsl(0 50% 38% / 0.35); }
.ac-btn-danger-solid {
  border-color: var(--ac-danger-solid-bg);
  background: var(--ac-danger-solid-bg);
  color: hsl(48 50% 98%);
  font-weight: 600;
}
.ac-btn-danger-solid:hover:not(:disabled) { filter: brightness(1.08); }
.ac-checkbox {
  width: 16px;
  height: 16px;
  margin-top: 3px;
  border-radius: 5px;
  accent-color: var(--ac-accent-strong);
  cursor: pointer;
}
.ac-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: var(--ac-overlay-bg);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
.ac-modal-card {
  max-width: 440px;
  width: 100%;
  padding: 24px;
  border-radius: 16px;
  border: 1px solid var(--ac-danger-border);
  background: var(--ac-overlay-card);
  box-shadow: var(--ac-overlay-shadow);
  -webkit-app-region: no-drag;
}
.ac-input, .ac-select {
  min-height: 34px;
  border: 1px solid var(--ac-border);
  background: var(--ac-input-bg);
  color: var(--ac-text-primary);
  border-radius: 10px;
  font-size: 12px;
  transition: border-color var(--ac-transition-ui), background-color var(--ac-transition-ui), box-shadow var(--ac-transition-ui);
  -webkit-app-region: no-drag;
}
.ac-input:focus, .ac-select:focus {
  border-color: hsl(var(--ac-accent) / 0.65);
  background: var(--ac-surface);
  box-shadow: 0 0 0 3px hsl(var(--ac-accent) / 0.1);
  outline: none;
}
.ac-input::placeholder { color: var(--ac-text-muted); opacity: 1; }
.ac-input { padding: 7px 11px 7px 30px; min-width: 200px; }
.ac-select { padding: 6px 10px; cursor: pointer; }
.ac-select option { background: var(--ac-surface); color: var(--ac-text-primary); }
.ac-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-radius: 999px;
  padding: 3px 9px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
}
@keyframes ac-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.ac-spin {
  animation: ac-spin 0.9s linear infinite;
}
.ac-spin-reverse {
  animation: ac-spin 1.25s linear infinite reverse;
}
.ac-loading-overlay {
  position: absolute;
  inset: 0;
  z-index: 25;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--ac-overlay-bg);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
}
.ac-loading-card {
  max-width: 340px;
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 26px 28px;
  border-radius: 16px;
  border: 1px solid var(--ac-accent-border);
  background: var(--ac-overlay-card);
  box-shadow: var(--ac-overlay-shadow);
}
.ac-radar {
  position: relative;
  width: 76px;
  height: 76px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ac-radar-outer {
  position: absolute;
  inset: 0;
  border-radius: 9999px;
  border: 3px solid var(--ac-ring-track);
  border-top-color: var(--ac-accent);
}
.ac-radar-inner {
  position: absolute;
  inset: 10px;
  border-radius: 9999px;
  border: 2px solid var(--ac-border);
  border-bottom-color: var(--ac-accent);
}
.ac-radar-core {
  width: 38px;
  height: 38px;
  border-radius: 9999px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--ac-accent-soft);
  color: var(--ac-accent);
  border: 1px solid var(--ac-accent-border);
}
.ac-loading-card > div:nth-child(2), #ac-confirm-permanent-title {
  font-family: var(--ac-font-display);
  letter-spacing: -0.02em;
}
@media (max-width: 560px) {
  .ac-header-wrap { padding-inline: 16px; }
  .ac-scroll-body { padding-inline: 16px; }
  .ac-header { gap: 12px; }
  .ac-card { padding: 13px; }
  .ac-input { min-width: 160px; }
}
@media (prefers-reduced-motion: reduce) {
  .ac-card, .ac-btn, .ac-input, .ac-select { transition: none !important; }
  .ac-spin, .ac-spin-reverse { animation: none !important; }
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

function formatTimeAgo(ms: number | null | undefined, lang: Lang): string {
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

function agentLabel(agent: string): string {
  return AGENT_LABELS[agent] ?? agent;
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
  alert: [
    { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z' },
    { d: 'M12 9v4' },
    { d: 'M12 17h.01' },
  ],
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

let cachedPanelState: {
  data: OverviewPayload;
  scannedAt: number;
  exemptHours: number;
  selectedIds: Set<string>;
} | null = null;

function CleanerPanel() {
  const [lang, setLang] = useState<Lang>(readStoredLang);
  const [data, setData] = useState<OverviewPayload | null>(cachedPanelState?.data ?? null);
  const [scannedAt, setScannedAt] = useState<number | null>(cachedPanelState?.scannedAt ?? null);
  const [, setTimeTick] = useState(0);
  const [loading, setLoading] = useState(!cachedPanelState);
  const [busy, setBusy] = useState(false);
  const [confirmPermanent, setConfirmPermanent] = useState(false);
  const [tab, setTab] = useState<'scan' | 'mcp' | 'doctor' | 'trash'>('scan');
  const [recFilter, setRecFilter] = useState<'all' | Recommendation>('all');
  const [agentFilter, setAgentFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [exemptHours, setExemptHours] = useState<number>(cachedPanelState?.exemptHours ?? 24);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => cachedPanelState?.selectedIds ?? new Set(),
  );
  const [expandedBatchIds, setExpandedBatchIds] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);

  const t = DICT[lang];

  useEffect(() => {
    if (data && scannedAt !== null) {
      cachedPanelState = { data, scannedAt, exemptHours, selectedIds };
    }
  }, [data, scannedAt, exemptHours, selectedIds]);

  const load = useCallback(
    async (hours = exemptHours, curLang = lang, preserveSelection = false, force = false) => {
      setLoading(true);
      try {
        const ov = await apiJson<OverviewPayload>(
          `/agent-cleaner/api/overview?hours=${hours}&lang=${curLang}${force ? '&force=1' : ''}`,
        );
        const now = typeof ov.scannedAt === 'number' ? ov.scannedAt : Date.now();
        let nextSel = selectedIds;
        if (!preserveSelection) {
          nextSel = new Set<string>();
          for (const ag of ov.agents) {
            for (const it of ag.items) {
              if (it.recommendation === 'recommended') nextSel.add(it.id);
            }
          }
          setSelectedIds(nextSel);
        }
        setData(ov);
        setScannedAt(now);
        cachedPanelState = { data: ov, scannedAt: now, exemptHours: hours, selectedIds: nextSel };
      } catch (err) {
        setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
      } finally {
        setLoading(false);
      }
    },
    [exemptHours, lang, selectedIds],
  );

  useEffect(() => {
    if (!cachedPanelState) {
      void load(exemptHours, lang, false, false);
    }
    const timer = window.setInterval(() => setTimeTick((n) => n + 1), 60_000);
    return () => window.clearInterval(timer);
    // Mount-only: avoid rescanning on language switches or tab remounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const toggleBatchDetails = (batchId: string) => {
    setExpandedBatchIds((prev) => {
      const next = new Set(prev);
      if (next.has(batchId)) next.delete(batchId);
      else next.add(batchId);
      return next;
    });
  };

  const refreshTrashOnly = async (fallbackBatch?: TrashBatch) => {
    try {
      const trash = await apiJson<TrashBatch[]>('/agent-cleaner/api/trash');
      setData((prev) => (prev ? { ...prev, trash } : prev));
    } catch {
      if (fallbackBatch) {
        setData((prev) => (prev ? { ...prev, trash: [fallbackBatch, ...prev.trash] } : prev));
      }
    }
  };

  const applyCleanLocally = (res: any, reqSelectedIds?: string[]): ScanItem[] => {
    const errs: string[] = Array.isArray(res?.errors) ? res.errors.map(String) : [];
    const itemsList: ScanItem[] = Array.isArray(res?.items) ? res.items : [];
    const succeededIds = new Set<string>();
    const succeededItems: ScanItem[] = [];

    if (itemsList.length > 0) {
      for (const it of itemsList) {
        const failed = errs.some((err) => err === it.path || err.startsWith(`${it.path}:`));
        if (!failed) {
          succeededIds.add(it.id);
          succeededItems.push(it);
        }
      }
    } else if (errs.length === 0 && Array.isArray(reqSelectedIds)) {
      for (const id of reqSelectedIds) succeededIds.add(id);
    }

    if (succeededIds.size === 0) return succeededItems;

    setData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        agents: prev.agents.map((ag) => {
          let removedBytes = 0;
          const remaining = ag.items.filter((it) => {
            if (succeededIds.has(it.id)) {
              removedBytes += it.sizeBytes || 0;
              return false;
            }
            return true;
          });
          if (remaining.length === ag.items.length) return ag;
          return {
            ...ag,
            items: remaining,
            totalBytes: Math.max(0, (ag.totalBytes || 0) - removedBytes),
            diskUsageBytes: Math.max(0, (ag.diskUsageBytes || 0) - removedBytes),
          };
        }),
      };
    });
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of succeededIds) next.delete(id);
      return next;
    });
    return succeededItems;
  };

  const runAction = async (label: string, url: string, body: unknown = {}) => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await apiJson<any>(url, { method: 'POST', body: JSON.stringify(body) });
      const bodyObj = (body && typeof body === 'object' ? body : {}) as Record<string, any>;
      const isPermanentReq = Boolean(bodyObj.permanent);
      // Fallback when host process still runs cached index.js without --permanent support:
      // immediately purge the just-created trash batch so permanent deletion still takes effect.
      if (isPermanentReq && typeof res?.batchId === 'string' && res.batchId) {
        await apiJson('/agent-cleaner/api/purge', {
          method: 'POST',
          body: JSON.stringify({ batchId: res.batchId }),
        });
        res.batchId = null;
      }
      if (res?.batchId && typeof res?.restored === 'number') {
        const failCount = Array.isArray(res.failed) ? res.failed.length : 0;
        setNotice({
          kind: failCount > 0 && res.restored === 0 ? 'error' : 'info',
          text:
            lang === 'zh'
              ? `原路还原完成（批次 ${String(res.batchId).slice(0, 8)}）：成功 ${res.restored} 项${failCount > 0 ? `，失败 ${failCount} 项 (${res.failed[0]})` : ''}`
              : `Restore complete (${String(res.batchId).slice(0, 8)}): restored ${res.restored} item(s)${failCount > 0 ? `, ${failCount} failed (${res.failed[0]})` : ''}`,
        });
        if (res.restored > 0) {
          await load(exemptHours, lang, false, true);
        }
      } else if (res?.batchId) {
        const reqIds = Array.isArray(bodyObj.selectedIds) ? bodyObj.selectedIds.map(String) : undefined;
        const removed = applyCleanLocally(res, reqIds);
        setNotice({
          kind: 'info',
          text:
            lang === 'zh'
              ? `${label}成功：已移入回收站 ${res.cleanedCount ?? 0} 项（释放 ${formatBytes(res.freedBytes ?? 0)}），还原批次：${res.batchId}`
              : `${label} succeeded: moved ${res.cleanedCount ?? 0} item(s) (${formatBytes(res.freedBytes ?? 0)}), batchId: ${res.batchId}`,
        });
        await refreshTrashOnly({
          batchId: res.batchId,
          timestamp: Date.now(),
          totalBytes: res.freedBytes ?? 0,
          items: removed.map((it) => ({
            id: it.id,
            agent: it.agent,
            originalPath: it.path,
            sizeBytes: it.sizeBytes,
          })),
        });
      } else if (typeof res?.cleanedCount === 'number') {
        const errs = Array.isArray(res.errors) ? res.errors : [];
        const hasErr = errs.length > 0;
        const reqIds = Array.isArray(bodyObj.selectedIds) ? bodyObj.selectedIds.map(String) : undefined;
        applyCleanLocally(res, reqIds);
        setNotice({
          kind: hasErr && res.cleanedCount === 0 ? 'error' : 'info',
          text: isPermanentReq
            ? lang === 'zh'
              ? `已彻底删除 ${res.cleanedCount} 项（释放 ${formatBytes(res.freedBytes ?? 0)}）${hasErr ? `（${errs.length} 项失败：${errs[0]}）` : ''}`
              : `Permanently deleted ${res.cleanedCount} item(s) (${formatBytes(res.freedBytes ?? 0)})${hasErr ? ` (${errs.length} failed: ${errs[0]})` : ''}`
            : lang === 'zh'
              ? `${label}完成：已处理 ${res.cleanedCount} 项（释放 ${formatBytes(res.freedBytes ?? 0)}）${hasErr ? `（${errs.length} 项失败：${errs[0]}）` : ''}`
              : `${label} complete: processed ${res.cleanedCount} item(s) (${formatBytes(res.freedBytes ?? 0)})${hasErr ? ` (${errs.length} failed: ${errs[0]})` : ''}`,
        });
      } else if (typeof res?.fixedCount === 'number') {
        const backups = Array.isArray(res.backupPaths) ? res.backupPaths.length : 0;
        if (Array.isArray(res.reports)) {
          setData((prev) => (prev ? { ...prev, doctors: res.reports } : prev));
        }
        setNotice({
          kind: 'info',
          text:
            lang === 'zh'
              ? `配置自愈完成：共修复 ${res.fixedCount} 个问题，已自动备份 ${backups} 份原配置`
              : `Config heal complete: fixed ${res.fixedCount} issue(s), backed up ${backups} file(s)`,
        });
      } else if (Array.isArray(res?.killResults)) {
        const total = res.killResults.length;
        const killedPids = new Set<number>(
          res.killResults.filter((k: any) => k?.success && typeof k.pid === 'number').map((k: any) => k.pid),
        );
        if (killedPids.size > 0) {
          setData((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              mcpAudit: {
                ...prev.mcpAudit,
                audit: {
                  ...prev.mcpAudit.audit,
                  orphanProcesses: prev.mcpAudit.audit.orphanProcesses.filter(
                    (p) => !killedPids.has(p.pid),
                  ),
                },
              },
            };
          });
        }
        setNotice({
          kind: total > 0 && killedPids.size === 0 ? 'error' : 'info',
          text:
            lang === 'zh'
              ? `孤儿 MCP 查杀完成：已终止 ${killedPids.size} / ${total} 个进程`
              : `Orphan MCP cleanup: terminated ${killedPids.size} / ${total} process(es)`,
        });
      } else if (typeof res?.purgedBatches === 'number') {
        setData((prev) => (prev ? { ...prev, trash: [] } : prev));
        setNotice({
          kind: 'info',
          text:
            lang === 'zh'
              ? `已永久清空全部 ${res.purgedBatches} 个回收站批次`
              : `Permanently purged all ${res.purgedBatches} trash batch(es)`,
        });
      } else if (typeof res?.purged === 'string') {
        const purgedId = res.purged;
        setData((prev) =>
          prev ? { ...prev, trash: prev.trash.filter((b) => b.batchId !== purgedId) } : prev,
        );
        setNotice({
          kind: 'info',
          text:
            lang === 'zh'
              ? `已永久删除回收站批次 ${purgedId.slice(0, 8)}`
              : `Permanently purged trash batch ${purgedId.slice(0, 8)}`,
        });
      } else {
        setNotice({ kind: 'info', text: `${label}: OK` });
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
  const diskBreakdownAgents = useMemo(
    () =>
      agents
        .filter((a) => (a.diskUsageBytes || 0) > 0)
        .sort(
          (a, b) =>
            (b.diskUsageBytes || 0) - (a.diskUsageBytes || 0) ||
            (b.totalBytes || 0) - (a.totalBytes || 0) ||
            a.agent.localeCompare(b.agent),
        ),
    [agents],
  );
  const totalReclaim = agents.reduce((s, a) => s + (a.totalBytes || 0), 0);
  const recItems = allItems.filter((i) => i.recommendation === 'recommended');
  const recBytes = recItems.reduce((s, i) => s + i.sizeBytes, 0);
  const optCount = allItems.filter((i) => i.recommendation === 'optional').length;
  const exemptCount = allItems.filter((i) => i.recommendation === 'exempt').length;
  const audit = data?.mcpAudit?.audit;
  const orphans = audit?.orphanProcesses ?? [];
  const deadLinks = audit?.deadLinks ?? [];
  const duplicates = audit?.duplicates ?? [];
  const coldCaches = audit?.coldCaches ?? [];
  const trashBatches = data?.trash ?? [];
  const trashTotalBytes = trashBatches.reduce((s, b) => s + (b.totalBytes || 0), 0);
  const issuesCount = (data?.doctors ?? []).reduce((s, d) => s + d.issues.length, 0);

  return React.createElement(
    'div',
    { className: 'ac-dsh-root' },
    React.createElement('style', null, SCOPED_CSS),
    React.createElement('div', { className: 'ac-drag-strip', 'aria-hidden': 'true' }),

    // Pinned Header (blank spaces draggable; controls marked no-drag)
    React.createElement(
      'div',
      { className: 'ac-header-wrap' },
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
                disabled: loading || busy,
                onChange: (e: any) => {
                  const h = Number(e.target.value);
                  setExemptHours(h);
                  void load(h, lang, false, true);
                },
              },
              React.createElement('option', { value: 0 }, t.guardOff),
              React.createElement('option', { value: 12 }, t.h12),
              React.createElement('option', { value: 24 }, t.h24),
              React.createElement('option', { value: 48 }, t.h48),
              React.createElement('option', { value: 168 }, t.d7),
            ),
          ),
          scannedAt !== null &&
            React.createElement(
              'span',
              {
                style: {
                  fontSize: 11,
                  color: 'var(--ac-text-muted)',
                  whiteSpace: 'nowrap',
                },
              },
              t.lastScanned(formatTimeAgo(scannedAt, lang)),
            ),
          React.createElement(
            'button',
            {
              className: 'ac-btn ac-btn-ghost',
              disabled: loading || busy,
              onClick: () => void load(exemptHours, lang, false, true),
            },
            React.createElement(SvgIcon, {
              size: 14,
              paths: ICONS.refresh,
              className: loading ? 'ac-spin' : undefined,
            }),
            loading ? t.scanning : t.rescan,
          ),
        ),
      ),
    ),

    React.createElement(
      'div',
      { className: 'ac-body-wrap' },
      loading &&
        React.createElement(
          'div',
          { className: 'ac-loading-overlay', role: 'status', 'aria-live': 'polite' },
          React.createElement(
            'div',
            { className: 'ac-loading-card' },
            React.createElement(
              'div',
              { className: 'ac-radar' },
              React.createElement('div', { className: 'ac-radar-outer ac-spin' }),
              React.createElement('div', { className: 'ac-radar-inner ac-spin-reverse' }),
              React.createElement(
                'div',
                { className: 'ac-radar-core' },
                React.createElement(SvgIcon, { size: 18, paths: ICONS.broom }),
              ),
            ),
            React.createElement(
              'div',
              {
                style: {
                  marginTop: 14,
                  fontSize: 14,
                  fontWeight: 600,
                  color: 'var(--ac-text-primary)',
                },
              },
              data ? t.rescanningTitle : t.scanningTitle,
            ),
            React.createElement(
              'div',
              {
                style: {
                  marginTop: 6,
                  fontSize: 12,
                  lineHeight: 1.5,
                  color: 'var(--ac-text-secondary)',
                },
              },
              t.scanningSubtitle,
            ),
          ),
        ),

      React.createElement(
        'div',
        { className: 'ac-scroll-body' },

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
          React.createElement('div', { style: { fontSize: 11, color: 'var(--ac-text-muted)' } }, t.diskSpace),
          React.createElement(
            'div',
            {
              className: 'ac-num ac-display',
              style: {
                fontSize: 24,
                fontWeight: 600,
                marginTop: 6,
                color:
                  data?.disk && data.disk.totalBytes > 0 && data.disk.availableBytes / data.disk.totalBytes < 0.1
                    ? 'var(--ac-warn-text, var(--ac-accent-strong))'
                    : undefined,
              },
            },
            data?.disk ? formatBytes(data.disk.availableBytes) : '--',
          ),
          data?.disk && data.disk.totalBytes > 0 &&
            React.createElement(
              'div',
              { style: { fontSize: 11, color: 'var(--ac-text-muted)', marginTop: 2 } },
              t.diskSpaceHint(
                formatBytes(data.disk.totalBytes),
                Math.round((1 - data.disk.availableBytes / data.disk.totalBytes) * 100),
              ),
            ),
        ),
        React.createElement(
          'div',
          { className: 'ac-card' },
          React.createElement('div', { style: { fontSize: 11, color: 'var(--ac-text-muted)' } }, t.totalDisk),
          React.createElement(
            'div',
            { className: 'ac-num ac-display', style: { fontSize: 24, fontWeight: 600, marginTop: 6 } },
            data ? formatBytes(totalDisk) : '--',
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
              className: 'ac-num ac-display',
              style: { fontSize: 24, fontWeight: 600, marginTop: 6, color: 'var(--ac-success-text)' },
            },
            data ? formatBytes(recBytes) : '--',
          ),
        ),
        React.createElement(
          'div',
          { className: 'ac-card' },
          React.createElement('div', { style: { fontSize: 11, color: 'var(--ac-text-muted)' } }, t.reclaimCard),
          React.createElement(
            'div',
            {
              className: 'ac-num ac-display',
              style: { fontSize: 24, fontWeight: 600, marginTop: 6, color: 'var(--ac-accent)' },
            },
            data ? formatBytes(totalReclaim) : '--',
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
              style:
                k === 'trash' && tab !== k
                  ? { background: 'var(--ac-accent-soft)', borderColor: 'var(--ac-accent-border)' }
                  : undefined,
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
                diskBreakdownAgents.map((a, idx) =>
                  React.createElement('button', {
                    key: a.agent,
                    type: 'button',
                    title: `${agentLabel(a.agent)}: ${formatBytes(a.diskUsageBytes)}`,
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
                diskBreakdownAgents.map((a, idx) =>
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
              { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
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
              React.createElement(
                'button',
                {
                  className: 'ac-btn ac-btn-danger',
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
                        `[${c.source}] ${c.path.split('/').pop()} (${c.lastAccessDays}d)`,
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
                      gap: 6,
                      fontSize: 12,
                      marginTop: 6,
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
                );
              }),
            ),
          ),
        ),

      tab === 'trash' &&
        React.createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          trashBatches.length > 0 &&
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
                { className: 'ac-num', style: { fontSize: 12, color: 'var(--ac-text-secondary)' } },
                t.trashSummary(trashBatches.length, formatBytes(trashTotalBytes)),
              ),
              React.createElement(
                'button',
                {
                  className: 'ac-btn ac-btn-ghost',
                  disabled: busy,
                  style: {
                    borderColor: 'var(--ac-danger-border)',
                    color: 'var(--ac-danger-text)',
                  },
                  onClick: () =>
                    void runAction(t.labelPurge, '/agent-cleaner/api/purge', { all: true }),
                },
                React.createElement(SvgIcon, { size: 13, paths: ICONS.trash }),
                t.purgeAll,
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
        ),
      ),
    ),
    confirmPermanent &&
      React.createElement(
        'div',
        {
          className: 'ac-modal-overlay',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'ac-confirm-permanent-title',
          onClick: () => setConfirmPermanent(false),
        },
        React.createElement(
          'div',
          {
            className: 'ac-modal-card',
            onClick: (e: any) => e.stopPropagation(),
          },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'flex-start', gap: 12 } },
            React.createElement(
              'div',
              {
                style: {
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  background: 'var(--ac-danger-bg)',
                  color: 'var(--ac-danger-text)',
                  border: '1px solid var(--ac-danger-border)',
                },
              },
              React.createElement(SvgIcon, { size: 18, paths: ICONS.alert }),
            ),
            React.createElement(
              'div',
              { style: { flex: 1, minWidth: 0 } },
              React.createElement(
                'div',
                {
                  id: 'ac-confirm-permanent-title',
                  style: { fontSize: 14, fontWeight: 600, color: 'var(--ac-text-primary)' },
                },
                t.confirmPermanentTitle,
              ),
              React.createElement(
                'div',
                {
                  style: {
                    marginTop: 6,
                    fontSize: 12,
                    lineHeight: 1.55,
                    color: 'var(--ac-text-secondary)',
                  },
                },
                t.confirmPermanentDesc(selectedItems.length, formatBytes(selectedBytes)),
              ),
            ),
          ),
          React.createElement(
            'div',
            {
              style: {
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 8,
                marginTop: 18,
              },
            },
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'ac-btn ac-btn-ghost',
                onClick: () => setConfirmPermanent(false),
              },
              t.cancel,
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'ac-btn ac-btn-danger-solid',
                onClick: () => {
                  setConfirmPermanent(false);
                  void runAction(t.labelPermanentDelete, '/agent-cleaner/api/clean', {
                    exemptHours,
                    lang,
                    dryRun: false,
                    permanent: true,
                    selectedIds: selectedItems.map((i) => i.id),
                  });
                },
              },
              t.confirmDelete,
            ),
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
