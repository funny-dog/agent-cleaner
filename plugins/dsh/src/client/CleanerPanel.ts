import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { DICT, readStoredLang, writeStoredLang } from './i18n.js';
import { SCOPED_CSS } from './styles.js';
import { DoctorTab } from './tabs/DoctorTab.js';
import { McpTab } from './tabs/McpTab.js';
import { ScanTab } from './tabs/ScanTab.js';
import { SettingsTab } from './tabs/SettingsTab.js';
import { TrashTab } from './tabs/TrashTab.js';
import type {
  BackupEntry,
  CleanerConfig,
  Lang,
  OverviewPayload,
  Recommendation,
  ScanItem,
  ScanProgress,
  TabKey,
  TrashBatch,
} from './types.js';
import { agentLabel, apiJson, formatBytes, formatTimeAgo, ICONS, SvgIcon } from './utils.js';

let cachedPanelState: {
  data: OverviewPayload;
  scannedAt: number;
  exemptHours: number;
  selectedIds: Set<string>;
  config: CleanerConfig | null;
  backups: BackupEntry[];
} | null = null;

export function CleanerPanel() {
  const [lang, setLang] = useState<Lang>(readStoredLang);
  const [data, setData] = useState<OverviewPayload | null>(cachedPanelState?.data ?? null);
  const [config, setConfig] = useState<CleanerConfig | null>(cachedPanelState?.config ?? null);
  const [backups, setBackups] = useState<BackupEntry[]>(cachedPanelState?.backups ?? []);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [scannedAt, setScannedAt] = useState<number | null>(cachedPanelState?.scannedAt ?? null);
  const [, setTimeTick] = useState(0);
  const [loading, setLoading] = useState(!cachedPanelState);
  const [busy, setBusy] = useState(false);
  const [confirmPermanent, setConfirmPermanent] = useState(false);
  const [tab, setTab] = useState<TabKey>('scan');
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
      cachedPanelState = { data, scannedAt, exemptHours, selectedIds, config, backups };
    }
  }, [data, scannedAt, exemptHours, selectedIds, config, backups]);

  const refreshConfig = useCallback(async () => {
    try {
      const cfg = await apiJson<CleanerConfig>('/agent-cleaner/api/config');
      setConfig(cfg);
    } catch {
      // ignore if backend does not expose config yet
    }
  }, []);

  const refreshBackups = useCallback(async () => {
    try {
      const list = await apiJson<BackupEntry[]>('/agent-cleaner/api/backups');
      setBackups(Array.isArray(list) ? list : []);
    } catch {
      // ignore if backend does not expose backups yet
    }
  }, []);

  const load = useCallback(
    async (hours = exemptHours, curLang = lang, preserveSelection = false, force = false) => {
      setLoading(true);
      try {
        const [ov, cfgRes, bakRes] = await Promise.allSettled([
          apiJson<OverviewPayload>(
            `/agent-cleaner/api/overview?hours=${hours}&lang=${curLang}${force ? '&force=1' : ''}`,
          ),
          apiJson<CleanerConfig>('/agent-cleaner/api/config'),
          apiJson<BackupEntry[]>('/agent-cleaner/api/backups'),
        ]);
        if (ov.status !== 'fulfilled') {
          throw ov.reason;
        }
        const ovVal = ov.value;
        const nextCfg = cfgRes.status === 'fulfilled' ? cfgRes.value : config;
        const nextBaks =
          bakRes.status === 'fulfilled' && Array.isArray(bakRes.value) ? bakRes.value : backups;
        if (cfgRes.status === 'fulfilled') setConfig(nextCfg);
        if (bakRes.status === 'fulfilled') setBackups(nextBaks);

        const now = typeof ovVal.scannedAt === 'number' ? ovVal.scannedAt : Date.now();
        let nextSel = selectedIds;
        if (!preserveSelection) {
          nextSel = new Set<string>();
          for (const ag of ovVal.agents) {
            for (const it of ag.items) {
              if (it.recommendation === 'recommended') nextSel.add(it.id);
            }
          }
          setSelectedIds(nextSel);
        }
        setData(ovVal);
        setScannedAt(now);
        cachedPanelState = {
          data: ovVal,
          scannedAt: now,
          exemptHours: hours,
          selectedIds: nextSel,
          config: nextCfg,
          backups: nextBaks,
        };
      } catch (err) {
        setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
      } finally {
        setLoading(false);
      }
    },
    [exemptHours, lang, selectedIds, config, backups],
  );

  useEffect(() => {
    if (!loading) {
      setScanProgress(null);
      return;
    }

    let closed = false;
    let pollTimer: number | null = null;
    let es: EventSource | null = null;

    const startPolling = () => {
      if (closed || pollTimer !== null) return;
      const poll = async () => {
        if (closed) return;
        try {
          const prog = await apiJson<ScanProgress>('/agent-cleaner/api/progress');
          if (!closed && prog && typeof prog.completed === 'number') {
            setScanProgress(prog);
          }
        } catch {
          // ignore transient progress fetch errors
        }
      };
      void poll();
      pollTimer = window.setInterval(() => void poll(), 350);
    };

    if (typeof EventSource !== 'undefined') {
      try {
        es = new EventSource('/agent-cleaner/api/progress?stream=1');
        es.onmessage = (evt) => {
          if (closed) return;
          try {
            const parsed = JSON.parse(evt.data) as ScanProgress;
            if (parsed && typeof parsed.completed === 'number') {
              setScanProgress(parsed);
            }
          } catch {
            // ignore malformed progress chunk
          }
        };
        es.onerror = () => {
          if (es) {
            es.close();
            es = null;
          }
          startPolling();
        };
      } catch {
        startPolling();
      }
    } else {
      startPolling();
    }

    return () => {
      closed = true;
      if (es) es.close();
      if (pollTimer !== null) window.clearInterval(pollTimer);
    };
  }, [loading]);

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
        const backupsCount = Array.isArray(res.backupPaths) ? res.backupPaths.length : 0;
        if (Array.isArray(res.reports)) {
          setData((prev) => (prev ? { ...prev, doctors: res.reports } : prev));
        }
        void refreshBackups();
        setNotice({
          kind: 'info',
          text:
            lang === 'zh'
              ? `配置自愈完成：共修复 ${res.fixedCount} 个问题，已自动备份 ${backupsCount} 份原配置`
              : `Config heal complete: fixed ${res.fixedCount} issue(s), backed up ${backupsCount} file(s)`,
        });
      } else if (typeof res?.restored === 'boolean' && typeof res?.originalPath === 'string') {
        await Promise.all([load(exemptHours, lang, false, true), refreshBackups()]);
        setNotice({
          kind: 'info',
          text:
            lang === 'zh'
              ? `已回滚配置文件：${res.originalPath}`
              : `Rolled back config file: ${res.originalPath}`,
        });
      } else if (typeof res?.prunedCount === 'number') {
        await refreshBackups();
        setNotice({
          kind: 'info',
          text:
            lang === 'zh'
              ? `已清理 ${res.prunedCount} 份旧配置备份（释放 ${formatBytes(res.freedBytes ?? 0)}）`
              : `Pruned ${res.prunedCount} old backup(s) (${formatBytes(res.freedBytes ?? 0)})`,
        });
      } else if (typeof res?.prunedBatches === 'number') {
        await refreshTrashOnly();
        setNotice({
          kind: 'info',
          text:
            lang === 'zh'
              ? `已清理 ${res.prunedBatches} 个过期/超额回收站批次（释放 ${formatBytes(res.freedBytes ?? 0)}）`
              : `Pruned ${res.prunedBatches} expired/over-quota trash batch(es) (${formatBytes(res.freedBytes ?? 0)})`,
        });
      } else if (
        typeof res?.exempt_hours === 'number' &&
        Array.isArray(res?.ignored_paths)
      ) {
        const nextCfg = res as CleanerConfig;
        setConfig(nextCfg);
        setExemptHours(nextCfg.exempt_hours);
        await load(nextCfg.exempt_hours, lang, true, true);
        setNotice({
          kind: 'info',
          text:
            lang === 'zh'
              ? `${label}成功，已同步更新全局策略与扫描视图`
              : `${label} succeeded and refreshed scan view`,
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
  const conflicts = audit?.conflicts ?? [];
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
              scanProgress && scanProgress.total > 0
                ? t.progressStatus(
                    agentLabel(scanProgress.agent || '...'),
                    scanProgress.completed,
                    scanProgress.total,
                    formatBytes(scanProgress.currentBytes || 0),
                  )
                : t.scanningSubtitle,
            ),
            React.createElement(
              'div',
              { className: 'ac-progress-track' },
              React.createElement('div', {
                className: 'ac-progress-fill',
                style: {
                  width:
                    scanProgress && scanProgress.total > 0
                      ? `${Math.min(100, Math.round((scanProgress.completed / scanProgress.total) * 100))}%`
                      : '12%',
                },
              }),
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
          (['scan', 'mcp', 'doctor', 'trash', 'settings'] as const).map((k) =>
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
                    : k === 'trash'
                      ? t.tabTrash(data?.trash?.length ?? 0)
                      : t.tabSettings,
            ),
          ),
        ),

        tab === 'scan' &&
          React.createElement(ScanTab, {
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
            recItemsCount: recItems.length,
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
            ignoredPaths: config?.ignored_paths ?? [],
            runAction,
          }),

        tab === 'mcp' &&
          React.createElement(McpTab, {
            t,
            busy,
            orphans,
            deadLinks,
            duplicates,
            conflicts,
            coldCaches,
            runAction,
          }),

        tab === 'doctor' &&
          React.createElement(DoctorTab, {
            t,
            lang,
            busy,
            issuesCount,
            doctors: data?.doctors ?? [],
            backups,
            runAction,
          }),

        tab === 'trash' &&
          React.createElement(TrashTab, {
            t,
            lang,
            busy,
            config,
            trashBatches,
            trashTotalBytes,
            expandedBatchIds,
            toggleBatchDetails,
            runAction,
          }),

        tab === 'settings' &&
          React.createElement(SettingsTab, {
            t,
            busy,
            config,
            runAction,
          }),
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
