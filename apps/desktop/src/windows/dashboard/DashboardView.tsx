import { useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  Activity,
  ArchiveRestore,
  CheckCircle2,
  Cpu,
  Globe,
  HardDrive,
  HeartPulse,
  Lock,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import {
  commands,
  type DiskSpace,
  type OverviewReport,
  type ScanItem,
  type TrashManifest,
} from '../../bindings';
import { agentLabel, formatBytes, formatTimeAgo, isDiskLow } from '../../utils/format';
import { DICT, readStoredLang, writeStoredLang, type Lang } from '../../utils/i18n';

type Tab = 'cleanup' | 'mcp' | 'doctor' | 'trash';

const AGENT_COLORS = [
  'bg-agent-clay',
  'bg-agent-olive',
  'bg-agent-ochre',
  'bg-agent-sage',
  'bg-agent-taupe',
];

export function DashboardView() {
  const [lang, setLang] = useState<Lang>(readStoredLang);
  const [tab, setTab] = useState<Tab>('cleanup');
  const [overview, setOverview] = useState<OverviewReport | null>(null);
  const [trashBatches, setTrashBatches] = useState<TrashManifest[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string>('all');
  const [recFilter, setRecFilter] = useState<'all' | 'recommended' | 'optional' | 'exempt'>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [exemptHours, setExemptHours] = useState<number>(24);
  const [disk, setDisk] = useState<DiskSpace | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [busy, setBusy] = useState<boolean>(false);
  const [confirmPermanent, setConfirmPermanent] = useState<boolean>(false);
  const [, setTimeTick] = useState<number>(0);
  const [banner, setBanner] = useState<{ kind: 'info' | 'success' | 'error'; text: string } | null>(
    null,
  );

  const t = DICT[lang];

  const refreshAll = async (
    hours = exemptHours,
    curLang = lang,
    preserveSelection = false,
    force = false,
  ) => {
    setLoading(true);
    try {
      void commands.getDiskSpace().then((r) => r.status === 'ok' && setDisk(r.data));
      const [ovRes, trRes] = await Promise.all([
        commands.getOverview({ exemptHours: hours, agentFilter: null, lang: curLang }, force),
        commands.listTrash(),
      ]);

      if (ovRes.status === 'ok') {
        setOverview(ovRes.data);
        if (!preserveSelection) {
          const recIds = new Set<string>();
          for (const agent of ovRes.data.agents) {
            for (const item of agent.items) {
              if (item.recommendation === 'recommended') {
                recIds.add(item.id);
              }
            }
          }
          setSelectedIds(recIds);
        }
      } else {
        setBanner({ kind: 'error', text: ovRes.error });
      }

      if (trRes.status === 'ok') {
        setTrashBatches(trRes.data);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshAll(exemptHours, lang, false, false);
    const timer = window.setInterval(() => setTimeTick((n) => n + 1), 60_000);
    const unlisten = listen<OverviewReport>('cleaner://overview-updated', (e) => {
      setOverview(e.payload);
    });
    return () => {
      window.clearInterval(timer);
      void unlisten.then((fn) => fn());
    };
    // Mount-only: avoid rescanning when toggling display language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleLanguage = () => {
    const next: Lang = lang === 'zh' ? 'en' : 'zh';
    writeStoredLang(next);
    setLang(next);
  };

  const rawItems = useMemo<ScanItem[]>(
    () => overview?.agents.flatMap((a) => a.items) ?? [],
    [overview],
  );

  const allItems = useMemo<ScanItem[]>(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = rawItems
      .filter((i) => (selectedAgent === 'all' ? true : i.agent === selectedAgent))
      .filter((i) => (recFilter === 'all' ? true : i.recommendation === recFilter))
      .filter((i) =>
        q
          ? i.path.toLowerCase().includes(q) ||
            i.description.toLowerCase().includes(q) ||
            i.agent.toLowerCase().includes(q) ||
            i.recommendationReason.toLowerCase().includes(q)
          : true,
      );

    const rank = (r: ScanItem['recommendation']) =>
      r === 'recommended' ? 0 : r === 'optional' ? 1 : 2;

    return [...filtered].sort(
      (a, b) => rank(a.recommendation) - rank(b.recommendation) || (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0),
    );
  }, [rawItems, selectedAgent, recFilter, searchQuery]);

  const selectedBytes = useMemo(
    () =>
      rawItems
        .filter((i) => selectedIds.has(i.id))
        .reduce((acc, i) => acc + (i.sizeBytes ?? 0), 0),
    [rawItems, selectedIds],
  );

  const toggleItem = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleClean = async (permanent = false) => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBusy(true);
    setBanner(null);
    try {
      const res = await commands.clean({
        exemptHours,
        dryRun: false,
        agentFilter: null,
        selectedIds: ids,
        onlyRecommended: false,
        lang,
        permanent,
      });
      if (res.status === 'ok') {
        const errs = res.data.errors;
        const hasErr = errs.length > 0;
        const succeededIds = new Set<string>();
        for (const it of res.data.items) {
          const failed = errs.some((e) => e === it.path || e.startsWith(`${it.path}:`));
          if (!failed) succeededIds.add(it.id);
        }

        let nextTrashCount: number | null = null;
        if (!permanent && res.data.batchId) {
          const trRes = await commands.listTrash();
          if (trRes.status === 'ok') {
            setTrashBatches(trRes.data);
            nextTrashCount = trRes.data.length;
          }
        }

        if (succeededIds.size > 0) {
          setOverview((prev) => {
            if (!prev) return prev;
            const nextAgents = prev.agents.map((ag) => {
              let removedBytes = 0;
              const remaining = ag.items.filter((it) => {
                if (succeededIds.has(it.id)) {
                  removedBytes += it.sizeBytes ?? 0;
                  return false;
                }
                return true;
              });
              if (remaining.length === ag.items.length) return ag;
              return {
                ...ag,
                items: remaining,
                totalBytes: Math.max(0, (ag.totalBytes ?? 0) - removedBytes),
                diskUsageBytes: Math.max(0, (ag.diskUsageBytes ?? 0) - removedBytes),
              };
            });
            const totalDiskUsageBytes = nextAgents.reduce((s, a) => s + (a.diskUsageBytes ?? 0), 0);
            const totalReclaimableBytes = nextAgents.reduce((s, a) => s + (a.totalBytes ?? 0), 0);
            const recommendedBytes = nextAgents
              .flatMap((a) => a.items)
              .filter((i) => i.recommendation === 'recommended')
              .reduce((s, i) => s + (i.sizeBytes ?? 0), 0);
            return {
              ...prev,
              agents: nextAgents,
              summary: {
                ...prev.summary,
                totalDiskUsageBytes,
                totalReclaimableBytes,
                recommendedBytes,
                trashBatchCount:
                  nextTrashCount ??
                  (prev.summary.trashBatchCount + (!permanent && res.data.batchId ? 1 : 0)),
              },
            };
          });
          setSelectedIds((prev) => {
            const next = new Set(prev);
            for (const id of succeededIds) next.delete(id);
            return next;
          });
        }

        setBanner({
          kind: hasErr && res.data.cleanedCount === 0 ? 'error' : hasErr ? 'info' : 'success',
          text: permanent
            ? lang === 'zh'
              ? `已彻底删除 ${res.data.cleanedCount} 项（释放 ${formatBytes(res.data.freedBytes)}）${hasErr ? `（${errs.length} 项失败：${errs[0]}）` : ''}`
              : `Permanently deleted ${res.data.cleanedCount} item(s) (${formatBytes(res.data.freedBytes)})${hasErr ? ` (${errs.length} failed: ${errs[0]})` : ''}`
            : lang === 'zh'
              ? `已移入回收站 ${res.data.cleanedCount} 项（释放 ${formatBytes(res.data.freedBytes)}），回滚批次：${res.data.batchId ?? 'N/A'}`
              : `Moved ${res.data.cleanedCount} item(s) to trash (${formatBytes(res.data.freedBytes)}), batchId: ${res.data.batchId ?? 'N/A'}`,
        });
      } else {
        setBanner({ kind: 'error', text: res.error });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDoctorFix = async () => {
    setBusy(true);
    try {
      const res = await commands.fixDoctors();
      if (res.status === 'ok') {
        const reports = res.data.reports;
        const issueCount = reports.reduce((s, d) => s + d.issues.length, 0);
        setOverview((prev) =>
          prev
            ? {
                ...prev,
                doctors: reports,
                summary: { ...prev.summary, doctorIssueCount: issueCount },
              }
            : prev,
        );
        setBanner({
          kind: 'success',
          text:
            lang === 'zh'
              ? `配置修复完成：共修复 ${res.data.fixedCount} 个问题，已自动备份 ${res.data.backupPaths.length} 份原配置`
              : `Config heal complete: fixed ${res.data.fixedCount} issue(s), backed up ${res.data.backupPaths.length} file(s)`,
        });
      } else {
        setBanner({ kind: 'error', text: res.error });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleKillOrphan = async (pid: number) => {
    setBusy(true);
    try {
      const res = await commands.killOrphanMcp(pid);
      if (res.status === 'ok') {
        if (res.data.success) {
          setOverview((prev) => {
            if (!prev) return prev;
            const remaining = prev.mcp.orphanProcesses.filter((p) => p.pid !== pid);
            return {
              ...prev,
              mcp: { ...prev.mcp, orphanProcesses: remaining },
              summary: { ...prev.summary, orphanMcpCount: remaining.length },
            };
          });
        }
        setBanner({
          kind: res.data.success ? 'success' : 'error',
          text:
            lang === 'zh'
              ? `进程 PID ${pid} 处理结果：${res.data.method} (${res.data.success ? '已终止' : '仍存活'})`
              : `PID ${pid}: ${res.data.method} (${res.data.success ? 'terminated' : 'still alive'})`,
        });
      } else {
        setBanner({ kind: 'error', text: res.error });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleRestoreBatch = async (batchId: string) => {
    setBusy(true);
    try {
      const res = await commands.restoreTrashBatch(batchId);
      if (res.status === 'ok') {
        setBanner({
          kind: res.data.failed.length ? 'info' : 'success',
          text:
            lang === 'zh'
              ? `已从批次 ${batchId.slice(0, 8)} 还原 ${res.data.restored} 项${
                  res.data.failed.length ? `（${res.data.failed.length} 项失败：${res.data.failed[0]}）` : ''
                }`
              : `Restored ${res.data.restored} item(s) from ${batchId.slice(0, 8)}`,
        });
        if (res.data.restored > 0) {
          await refreshAll(exemptHours, lang, false, true);
        } else {
          const trRes = await commands.listTrash();
          if (trRes.status === 'ok') setTrashBatches(trRes.data);
        }
      } else {
        setBanner({ kind: 'error', text: res.error });
      }
    } finally {
      setBusy(false);
    }
  };

  const handlePurgeBatch = async (batchId: string) => {
    setBusy(true);
    try {
      const res = await commands.purgeTrashBatch(batchId);
      if (res.status === 'ok') {
        setTrashBatches((prev) => {
          const next = prev.filter((b) => b.batchId !== batchId);
          setOverview((ov) =>
            ov ? { ...ov, summary: { ...ov.summary, trashBatchCount: next.length } } : ov,
          );
          return next;
        });
        setBanner({
          kind: 'info',
          text:
            lang === 'zh'
              ? `已永久清除批次 ${batchId.slice(0, 8)}`
              : `Purged batch ${batchId.slice(0, 8)}`,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const handlePurgeAll = async () => {
    setBusy(true);
    try {
      const res = await commands.purgeAllTrash();
      if (res.status === 'ok') {
        setTrashBatches([]);
        setOverview((ov) =>
          ov ? { ...ov, summary: { ...ov.summary, trashBatchCount: 0 } } : ov,
        );
        setBanner({
          kind: 'info',
          text:
            lang === 'zh'
              ? `已清空全部 ${res.data} 个回收站批次`
              : `Purged all ${res.data} trash batch(es)`,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const summary = overview?.summary;
  const totalDisk = Math.max(1, summary?.totalDiskUsageBytes ?? 1);
  const diskBreakdownAgents = useMemo(
    () =>
      (overview?.agents ?? [])
        .filter((a) => (a.diskUsageBytes ?? 0) > 0)
        .sort(
          (a, b) =>
            (b.diskUsageBytes ?? 0) - (a.diskUsageBytes ?? 0) ||
            (b.totalBytes ?? 0) - (a.totalBytes ?? 0) ||
            a.agent.localeCompare(b.agent),
        ),
    [overview],
  );
  const recCount = rawItems.filter((i) => i.recommendation === 'recommended').length;
  const optCount = rawItems.filter((i) => i.recommendation === 'optional').length;
  const exemptCount = rawItems.filter((i) => i.recommendation === 'exempt').length;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-canvas text-ink">
      <header
        data-tauri-drag-region
        className="flex flex-wrap items-center justify-between gap-4 border-b border-line bg-surface/90 px-6 py-4 backdrop-blur select-none"
      >
        <div data-tauri-drag-region className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-[14px] bg-accent-soft text-accent ring-1 ring-accent/20">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <h1 className="font-display text-[22px] font-medium leading-none tracking-[-0.02em]">
              Agent Cleaner
            </h1>
            <p className="mt-1.5 text-xs text-muted">{t.subtitle}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={toggleLanguage}
            className="btn btn-ghost"
            title={lang === 'zh' ? 'Switch to English' : '切换为中文'}
          >
            <Globe className="h-3.5 w-3.5 text-accent" />
            <span>{lang === 'zh' ? '中文 / EN' : 'EN / 中文'}</span>
          </button>

          <label className="field">
            <span>{t.guardLabel}</span>
            <select
              value={exemptHours}
              disabled={loading || busy}
              onChange={(e) => {
                const h = Number(e.target.value);
                setExemptHours(h);
                void refreshAll(h, lang, false, true);
              }}
              className="font-medium text-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value={0}>{t.guardOff}</option>
              <option value={12}>{t.h12}</option>
              <option value={24}>{t.h24}</option>
              <option value={48}>{t.h48}</option>
              <option value={168}>{t.d7}</option>
            </select>
          </label>

          {summary?.scannedAt && (
            <span className="px-1 text-[11px] whitespace-nowrap text-subtle tabular-nums">
              {t.lastScanned(formatTimeAgo(summary.scannedAt, lang))}
            </span>
          )}

          <button
            onClick={() => void refreshAll(exemptHours, lang, false, true)}
            disabled={loading || busy}
            className="btn btn-secondary"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>{loading ? t.scanning : t.rescan}</span>
          </button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {loading && (
          <div
            role="status"
            aria-live="polite"
            className="absolute inset-0 z-20 flex items-center justify-center bg-canvas/80 px-6 backdrop-blur-[3px]"
          >
            <div className="panel flex w-full max-w-sm flex-col items-center px-8 py-7 text-center">
              <div className="relative flex h-20 w-20 items-center justify-center">
                <div className="absolute inset-0 animate-spin rounded-full border-[3px] border-accent/15 border-t-accent" />
                <div
                  className="absolute inset-2.5 animate-spin rounded-full border-2 border-agent-ochre/15 border-b-agent-ochre"
                  style={{ animationDirection: 'reverse', animationDuration: '1.25s' }}
                />
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-accent ring-1 ring-accent/20">
                  <Sparkles className="h-5 w-5" />
                </div>
              </div>
              <p className="mt-4 font-display text-xl font-medium tracking-tight">
                {overview ? t.rescanningTitle : t.scanningTitle}
              </p>
              <p className="mt-1.5 text-xs leading-relaxed text-muted">
                {t.scanningSubtitle}
              </p>
            </div>
          </div>
        )}

      <div className="mx-auto grid w-full max-w-[1440px] grid-cols-2 gap-4 px-6 pt-5 lg:grid-cols-5">
        <div className="panel p-5">
          <div className="flex items-center justify-between text-xs font-medium text-muted">
            <span>{t.diskSpace}</span>
            <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-canvas text-muted">
              <HardDrive className="h-4 w-4" />
            </span>
          </div>
          <div
            className={`mt-3 text-[28px] font-medium tracking-[-0.03em] tabular-nums ${
              isDiskLow(disk) ? 'text-warning' : 'text-ink'
            }`}
          >
            {disk ? formatBytes(disk.availableBytes) : '--'}
          </div>
          <div className="mt-1 text-[11px] text-subtle">
            {disk?.totalBytes && disk.availableBytes != null
              ? t.diskSpaceHint(
                  formatBytes(disk.totalBytes),
                  Math.round((1 - disk.availableBytes / disk.totalBytes) * 100),
                )
              : ''}
          </div>
        </div>

        <div className="panel p-5">
          <div className="flex items-center justify-between text-xs font-medium text-muted">
            <span>{t.totalDisk}</span>
            <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-canvas text-muted">
              <HardDrive className="h-4 w-4" />
            </span>
          </div>
          <div className="mt-3 text-[28px] font-medium tracking-[-0.03em] text-ink tabular-nums">
            {summary ? formatBytes(summary.totalDiskUsageBytes) : '--'}
          </div>
          <div className="mt-1 text-[11px] text-subtle">
            {t.ecosystemCount(overview?.agents.length ?? 0)}
          </div>
        </div>

        <div className="panel border-accent/20 p-5">
          <div className="flex items-center justify-between text-xs font-medium text-muted">
            <span>{t.recClean}</span>
            <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-accent-soft text-accent">
              <Sparkles className="h-4 w-4" />
            </span>
          </div>
          <div className="mt-3 text-[28px] font-medium tracking-[-0.03em] text-accent-strong tabular-nums">
            {summary ? formatBytes(summary.recommendedBytes) : '--'}
          </div>
          <div className="mt-1 text-[11px] text-subtle">{t.recItemsCount(recCount)}</div>
        </div>

        <div className="panel p-5">
          <div className="flex items-center justify-between text-xs font-medium text-muted">
            <span>{t.orphanMcp}</span>
            <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-canvas text-muted">
              <Cpu className="h-4 w-4" />
            </span>
          </div>
          <div
            className={`mt-3 text-[28px] font-medium tracking-[-0.03em] tabular-nums ${
              (summary?.orphanMcpCount ?? 0) > 0 ? 'text-warning' : 'text-success'
            }`}
          >
            {summary ? summary.orphanMcpCount : '--'}
          </div>
          <div className="mt-1 text-[11px] text-subtle">{t.orphanMcpHint}</div>
        </div>

        <div className="panel p-5">
          <div className="flex items-center justify-between text-xs font-medium text-muted">
            <span>{t.issuesAndTrash}</span>
            <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-canvas text-muted">
              <HeartPulse className="h-4 w-4" />
            </span>
          </div>
          <div className="mt-3 text-[28px] font-medium tracking-[-0.03em] text-ink tabular-nums">
            {summary ? `${summary.doctorIssueCount} / ${trashBatches.length}` : '--'}
          </div>
          <div className="mt-1 text-[11px] text-subtle">{t.trashHint}</div>
        </div>
      </div>

      <nav className="mx-auto flex w-full max-w-[1440px] items-center gap-1 px-6 pt-4">
        {[
          { id: 'cleanup' as const, label: t.tabCleanup(rawItems.length), icon: Trash2 },
          {
            id: 'mcp' as const,
            label: t.tabMcp(overview?.mcp.orphanProcesses.length ?? 0),
            icon: Activity,
          },
          {
            id: 'doctor' as const,
            label: t.tabDoctor(summary?.doctorIssueCount ?? 0),
            icon: Wrench,
          },
          {
            id: 'trash' as const,
            label: t.tabTrash(trashBatches.length),
            icon: ArchiveRestore,
          },
        ].map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-2 rounded-[10px] px-4 py-2 text-[13px] font-medium transition-all duration-150 ${
              tab === id
                ? 'bg-surface text-ink shadow-sm ring-1 ring-line'
                : 'text-muted hover:bg-line-soft/70 hover:text-ink'
            }`}
          >
            <Icon className={`h-3.5 w-3.5 ${tab === id ? 'text-accent' : ''}`} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {banner && (
        <div
          role="alert"
          aria-live="polite"
          className={`mx-auto mt-3 flex w-[calc(100%_-_3rem)] max-w-[1392px] items-center justify-between rounded-xl border px-4 py-2.5 text-xs ${
            banner.kind === 'error'
              ? 'border-danger/25 bg-danger-soft text-danger'
              : banner.kind === 'success'
                ? 'border-success/25 bg-success-soft text-success'
                : 'border-accent/25 bg-accent-soft text-accent-strong'
          }`}
        >
          <span>{banner.text}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            aria-label="Close"
            className="icon-btn -mr-1 h-7 w-7"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Main Content */}
      <main className="mx-auto min-h-0 w-full max-w-[1440px] flex-1 overflow-y-auto px-6 py-5">
        {tab === 'cleanup' && (
          <div className="space-y-4">
            {overview && overview.agents.length > 0 && (
              <div className="panel p-5">
                <div className="mb-3 flex items-center justify-between text-xs">
                  <span className="font-medium text-body">{t.breakdownTitle}</span>
                  <span className="text-muted tabular-nums">
                    {t.totalLabel(formatBytes(summary?.totalDiskUsageBytes))}
                  </span>
                </div>
                <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-line-soft">
                  {diskBreakdownAgents.map((a, idx) => {
                    const pct = Math.max(
                      1.5,
                      ((a.diskUsageBytes ?? 0) / totalDisk) * 100,
                    );
                    return (
                      <button
                        key={a.agent}
                        type="button"
                        onClick={() =>
                          setSelectedAgent((prev) => (prev === a.agent ? 'all' : a.agent))
                        }
                        title={`${agentLabel(a.agent)}: ${formatBytes(a.diskUsageBytes)}`}
                        className={`${AGENT_COLORS[idx % AGENT_COLORS.length]} h-full cursor-pointer transition-opacity duration-200 hover:opacity-80 ${
                          selectedAgent !== 'all' && selectedAgent !== a.agent ? 'opacity-25' : ''
                        }`}
                        style={{ width: `${pct}%` }}
                      />
                    );
                  })}
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-muted">
                  {diskBreakdownAgents.slice(0, 7).map((a, idx) => (
                    <button
                      key={a.agent}
                      type="button"
                      onClick={() =>
                        setSelectedAgent((prev) => (prev === a.agent ? 'all' : a.agent))
                      }
                      className={`flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 transition-colors ${
                        selectedAgent === a.agent
                          ? 'bg-accent-soft text-accent-strong'
                          : 'hover:bg-line-soft hover:text-ink'
                      }`}
                    >
                      <span
                        className={`h-2 w-2 rounded-full ${AGENT_COLORS[idx % AGENT_COLORS.length]}`}
                      />
                      <span>{agentLabel(a.agent)}</span>
                      <span className="text-subtle tabular-nums">
                        {formatBytes(a.diskUsageBytes)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="panel flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex rounded-[10px] border border-line bg-canvas p-1">
                  {(
                    [
                      ['all', t.filterAll(rawItems.length)],
                      ['recommended', t.filterRec(recCount)],
                      ['optional', t.filterOpt(optCount)],
                      ['exempt', t.filterExempt(exemptCount)],
                    ] as const
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={recFilter === k}
                      onClick={() => setRecFilter(k)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                        recFilter === k
                          ? 'bg-surface text-ink shadow-sm ring-1 ring-line'
                          : 'text-muted hover:text-ink'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <label className="field w-56">
                  <Search className="h-3.5 w-3.5 shrink-0 text-subtle" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={t.searchPlaceholder}
                    aria-label={t.searchPlaceholder}
                    className="w-full bg-transparent"
                  />
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() =>
                    setSelectedIds(
                      new Set(
                        rawItems
                          .filter((i) => i.recommendation === 'recommended')
                          .map((i) => i.id),
                      ),
                    )
                  }
                  className="btn btn-ghost"
                >
                  {t.selectRec}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setSelectedIds((prev) => {
                      const next = new Set(prev);
                      for (const it of allItems) next.add(it.id);
                      return next;
                    })
                  }
                  className="btn btn-ghost"
                >
                  {t.selectVisible}
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set())}
                  className="btn btn-ghost"
                >
                  {t.clearSel}
                </button>
                <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
                <button
                  type="button"
                  onClick={() => void handleClean(false)}
                  disabled={busy || selectedIds.size === 0}
                  className="btn btn-primary"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span className="tabular-nums">
                    {t.moveToTrash(selectedIds.size, formatBytes(selectedBytes))}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmPermanent(true)}
                  disabled={busy || selectedIds.size === 0}
                  className="btn btn-danger"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>{t.deletePermanently}</span>
                </button>
              </div>
            </div>

            {(overview || !loading) && (
              <div className="panel overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] text-left text-xs">
                    <thead className="border-b border-line bg-canvas/70 text-muted">
                      <tr>
                        <th className="w-12 px-4 py-3 font-medium">{t.colSelect}</th>
                        <th className="px-3 py-3 font-medium">{t.colAgent}</th>
                        <th className="px-3 py-3 font-medium">{t.colDesc}</th>
                        <th className="px-3 py-3 font-medium">{t.colLevel}</th>
                        <th className="px-4 py-3 text-right font-medium">{t.colSize}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line-soft">
                      {allItems.map((item) => {
                        const isExempt = item.recommendation === 'exempt';
                        const checked = selectedIds.has(item.id);
                        return (
                          <tr
                            key={item.id}
                            onClick={() => toggleItem(item.id)}
                            className={`cursor-pointer transition-colors duration-150 hover:bg-canvas/60 ${
                              checked ? 'bg-accent-soft/45' : ''
                            } ${isExempt && !checked ? 'opacity-60' : ''}`}
                          >
                            <td className="px-4 py-3.5" onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={checked}
                                aria-label={item.description}
                                onChange={() => toggleItem(item.id)}
                                className="checkbox"
                              />
                            </td>
                            <td className="px-3 py-3.5 font-medium whitespace-nowrap text-body">
                              {agentLabel(item.agent)}
                            </td>
                            <td className="max-w-lg px-3 py-3.5">
                              <div className="font-medium text-ink">{item.description}</div>
                              <div className="mt-1 text-[11px] leading-relaxed text-muted">
                                {item.recommendationReason}
                              </div>
                              <div className="mt-1 truncate font-mono text-[11px] text-subtle">
                                {item.path}
                              </div>
                            </td>
                            <td className="px-3 py-3.5 whitespace-nowrap">
                              {item.recommendation === 'recommended' && (
                                <span className="badge badge-rec">{t.badgeRec}</span>
                              )}
                              {item.recommendation === 'optional' && (
                                <span className="badge badge-opt">{t.badgeOpt}</span>
                              )}
                              {item.recommendation === 'exempt' && (
                                <span className="badge badge-exempt">
                                  <Lock className="h-2.5 w-2.5" />
                                  {t.badgeExempt}
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-3.5 text-right font-medium whitespace-nowrap text-body tabular-nums">
                              {formatBytes(item.sizeBytes)}
                            </td>
                          </tr>
                        );
                      })}
                      {!loading && allItems.length === 0 && (
                        <tr>
                          <td colSpan={5} className="py-14 text-center text-muted">
                            {t.noItems}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'mcp' && overview && (
          <div className="space-y-5">
            <div className="panel p-6">
              <h2 className="font-display text-2xl font-medium tracking-[-0.02em]">{t.mcpTitle}</h2>
              <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-muted">{t.mcpDesc}</p>
              <div className="mt-5 space-y-2.5">
                {overview.mcp.orphanProcesses.map((proc) => (
                  <div
                    key={proc.pid}
                    className="flex items-center justify-between rounded-xl border border-warning/25 bg-warning-soft/70 px-4 py-3 text-xs"
                  >
                    <div className="min-w-0 pr-4">
                      <div className="font-semibold text-warning tabular-nums">
                        PID {proc.pid} · {proc.matchedName ?? 'MCP Stdio Process'} (
                        {Math.round((proc.rssKb ?? 0) / 1024)} MB)
                      </div>
                      <div className="mt-1 truncate font-mono text-[11px] text-muted">
                        {proc.command}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleKillOrphan(proc.pid)}
                      disabled={busy}
                      className="btn btn-warning shrink-0"
                    >
                      {t.killSafe}
                    </button>
                  </div>
                ))}
                {overview.mcp.orphanProcesses.length === 0 && (
                  <div className="flex items-center gap-2 rounded-xl bg-success-soft px-4 py-3 text-xs text-success">
                    <CheckCircle2 className="h-4 w-4" />
                    <span>{t.noOrphans}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <div className="panel p-6">
                <h3 className="font-display text-xl font-medium tracking-[-0.01em]">
                  {t.deadLinks(overview.mcp.deadLinks.length)}
                </h3>
                <div className="mt-4 space-y-2.5 text-xs">
                  {overview.mcp.deadLinks.map((d, idx) => (
                    <div key={idx} className="rounded-xl border border-line bg-canvas/70 p-3">
                      <span className="font-semibold text-danger">
                        [{d.agent}] {d.name}
                      </span>
                      <div className="mt-1 truncate font-mono text-[11px] text-subtle">
                        {d.command}
                      </div>
                    </div>
                  ))}
                  {overview.mcp.deadLinks.length === 0 && (
                    <p className="text-muted">{t.noDeadLinks}</p>
                  )}
                </div>
              </div>

              <div className="panel p-6">
                <h3 className="font-display text-xl font-medium tracking-[-0.01em]">
                  {t.coldCaches(overview.mcp.coldCaches.length)}
                </h3>
                <div className="mt-4 max-h-52 space-y-2 overflow-y-auto text-xs">
                  {overview.mcp.coldCaches.map((c) => (
                    <div
                      key={c.path}
                      className="flex items-center justify-between rounded-xl border border-line bg-canvas/70 px-3 py-2.5"
                    >
                      <span className="truncate font-mono text-[11px] text-body">
                        [{c.source}] {c.path.split('/').pop()} ({c.lastAccessDays}d)
                      </span>
                      <span className="ml-3 shrink-0 text-muted tabular-nums">
                        {formatBytes(c.sizeBytes)}
                      </span>
                    </div>
                  ))}
                  {overview.mcp.coldCaches.length === 0 && (
                    <p className="text-muted">{t.noColdCaches}</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === 'doctor' && overview && (
          <div className="space-y-5">
            <div className="panel flex flex-wrap items-center justify-between gap-4 p-5">
              <p className="max-w-3xl text-xs leading-relaxed text-muted">{t.doctorDesc}</p>
              <button
                type="button"
                onClick={() => void handleDoctorFix()}
                disabled={busy || (summary?.doctorIssueCount ?? 0) === 0}
                className="btn btn-primary shrink-0"
              >
                <Wrench className="h-3.5 w-3.5" />
                <span>{t.doctorFixBtn}</span>
              </button>
            </div>

            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              {overview.doctors.map((doc) => (
                <div
                  key={`${doc.agent}:${doc.path}`}
                  className="panel p-5"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-display text-xl font-medium tracking-[-0.01em]">
                      {agentLabel(doc.agent)}
                    </span>
                    {doc.healthy ? (
                      <span className="badge badge-rec">
                        <CheckCircle2 className="h-3 w-3" /> {t.healthy}
                      </span>
                    ) : (
                      <span className="badge badge-opt">
                        <ShieldAlert className="h-3 w-3" /> {t.issueCount(doc.issues.length)}
                      </span>
                    )}
                  </div>
                  <div className="mt-2 truncate font-mono text-[11px] text-subtle">
                    {doc.path}
                  </div>
                  {doc.issues.length > 0 && (
                    <div className="mt-4 space-y-2">
                      {doc.issues.map((issue) => (
                        <div
                          key={issue.id}
                          className="rounded-xl border border-warning/20 bg-warning-soft/70 px-3 py-2 text-xs leading-relaxed text-warning"
                        >
                          {issue.message}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'trash' && (
          <div className="space-y-5">
            <div className="panel flex flex-wrap items-center justify-between gap-4 p-5">
              <p className="max-w-3xl text-xs leading-relaxed text-muted">{t.trashDesc}</p>
              <button
                type="button"
                onClick={() => void handlePurgeAll()}
                disabled={busy || trashBatches.length === 0}
                className="btn btn-danger shrink-0"
              >
                {t.purgeAll}
              </button>
            </div>

            <div className="space-y-3">
              {trashBatches.map((batch) => (
                <div
                  key={batch.batchId}
                  className="panel p-5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-accent-strong">
                        {batch.batchId.slice(0, 8)}
                      </span>
                      <span className="text-xs text-muted tabular-nums">
                        · {formatTimeAgo(batch.timestamp, lang)} · {batch.items.length} ·{' '}
                        {formatBytes(batch.totalBytes)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleRestoreBatch(batch.batchId)}
                        disabled={busy}
                        className="btn btn-secondary"
                      >
                        <ArchiveRestore className="h-3.5 w-3.5 text-success" />
                        <span>{t.restoreBatch}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void handlePurgeBatch(batch.batchId)}
                        disabled={busy}
                        className="btn btn-danger"
                      >
                        {t.purgeBatch}
                      </button>
                    </div>
                  </div>
                  <div className="mt-4 max-h-28 space-y-1.5 overflow-y-auto border-t border-line-soft pt-3 font-mono text-[11px] text-subtle">
                    {batch.items.map((it) => (
                      <div key={it.id} className="truncate">
                        [{it.agent}] {it.originalPath} ({formatBytes(it.sizeBytes)})
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {trashBatches.length === 0 && (
                <div className="panel flex flex-col items-center px-6 py-14 text-center text-muted">
                  <ArchiveRestore className="mb-3 h-6 w-6 text-subtle" />
                  <span className="text-xs">{t.trashEmpty}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
      </div>

      {confirmPermanent && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-permanent-title"
          onClick={() => setConfirmPermanent(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/35 px-4 backdrop-blur-xs"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl border border-danger/25 bg-surface p-6 shadow-raised"
          >
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-danger-soft text-danger ring-1 ring-danger/15">
                <ShieldAlert className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h2
                  id="confirm-permanent-title"
                  className="font-display text-2xl font-medium tracking-[-0.02em]"
                >
                  {t.confirmPermanentTitle}
                </h2>
                <p className="mt-2 text-xs leading-relaxed text-muted">
                  {t.confirmPermanentDesc(selectedIds.size, formatBytes(selectedBytes))}
                </p>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2.5">
              <button
                type="button"
                autoFocus
                onClick={() => setConfirmPermanent(false)}
                className="btn btn-secondary"
              >
                {t.cancel}
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmPermanent(false);
                  void handleClean(true);
                }}
                className="btn btn-danger"
              >
                {t.confirmDelete}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
