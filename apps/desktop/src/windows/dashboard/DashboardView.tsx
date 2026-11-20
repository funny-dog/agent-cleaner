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
  type OverviewReport,
  type ScanItem,
  type TrashManifest,
} from '../../bindings';
import { agentLabel, formatBytes, formatTimeAgo } from '../../utils/format';
import { DICT, readStoredLang, writeStoredLang, type Lang } from '../../utils/i18n';

type Tab = 'cleanup' | 'mcp' | 'doctor' | 'trash';

const AGENT_COLORS = [
  'bg-cyan-500',
  'bg-blue-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-indigo-500',
  'bg-rose-500',
  'bg-teal-500',
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
    <div className="flex h-screen flex-col bg-[#060a13] bg-[radial-gradient(ellipse_at_top,_rgba(59,130,246,0.08),_transparent_55%)] text-slate-100">
      {/* Header (draggable in Tauri) */}
      <header
        data-tauri-drag-region
        className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800/80 bg-[#080d19]/90 px-6 py-4 backdrop-blur select-none"
      >
        <div data-tauri-drag-region className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500/20 to-blue-600/20 text-cyan-400 ring-1 ring-cyan-500/35">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-base font-semibold tracking-tight text-slate-50">Agent Cleaner</h1>
            <p className="text-xs text-slate-400">{t.subtitle}</p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={toggleLanguage}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-800 bg-[#0b1120] px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:border-slate-700 hover:bg-slate-800/80 focus-visible:outline-2 focus-visible:outline-cyan-500"
            title={lang === 'zh' ? 'Switch to English' : '切换为中文'}
          >
            <Globe className="h-3.5 w-3.5 text-cyan-400" />
            <span>{lang === 'zh' ? '中文 / EN' : 'EN / 中文'}</span>
          </button>

          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-800 bg-[#0b1120] px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-slate-700">
            <span className="text-slate-400">{t.guardLabel}</span>
            <select
              value={exemptHours}
              disabled={loading || busy}
              onChange={(e) => {
                const h = Number(e.target.value);
                setExemptHours(h);
                void refreshAll(h, lang, false, true);
              }}
              className="cursor-pointer bg-transparent font-medium text-cyan-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value={0}>{t.guardOff}</option>
              <option value={12}>{t.h12}</option>
              <option value={24}>{t.h24}</option>
              <option value={48}>{t.h48}</option>
              <option value={168}>{t.d7}</option>
            </select>
          </label>

          {summary?.scannedAt && (
            <span className="text-[11px] whitespace-nowrap text-slate-400">
              {t.lastScanned(formatTimeAgo(summary.scannedAt, lang))}
            </span>
          )}

          <button
            onClick={() => void refreshAll(exemptHours, lang, false, true)}
            disabled={loading || busy}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-800 bg-[#0b1120] px-3.5 py-1.5 text-xs font-medium text-slate-200 transition-colors duration-200 hover:border-slate-700 hover:bg-slate-800/80 focus-visible:outline-2 focus-visible:outline-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>{loading ? t.scanning : t.rescan}</span>
          </button>
        </div>
      </header>

      {/* Workspace Body (relative host for centered scanning overlay) */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {loading && (
          <div
            role="status"
            aria-live="polite"
            className="absolute inset-0 z-20 flex items-center justify-center bg-[#060a13]/75 px-6 backdrop-blur-[3px]"
          >
            <div className="flex w-full max-w-sm flex-col items-center rounded-2xl border border-cyan-500/25 bg-[#0b1120]/95 px-8 py-7 text-center shadow-2xl shadow-cyan-950/30">
              <div className="relative flex h-20 w-20 items-center justify-center">
                <div className="absolute inset-0 animate-spin rounded-full border-[3px] border-cyan-500/15 border-t-cyan-400" />
                <div
                  className="absolute inset-2.5 animate-spin rounded-full border-2 border-blue-500/15 border-b-blue-400"
                  style={{ animationDirection: 'reverse', animationDuration: '1.25s' }}
                />
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-cyan-500/10 text-cyan-400 ring-1 ring-cyan-500/30">
                  <Sparkles className="h-5 w-5" />
                </div>
              </div>
              <p className="mt-4 text-sm font-semibold tracking-tight text-slate-100">
                {overview ? t.rescanningTitle : t.scanningTitle}
              </p>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                {t.scanningSubtitle}
              </p>
            </div>
          </div>
        )}

      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-4 px-6 pt-5 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-800/80 bg-[#0b1120]/90 p-4 transition-colors duration-200 hover:border-slate-700">
          <div className="flex items-center justify-between text-xs font-medium text-slate-400">
            <span>{t.totalDisk}</span>
            <HardDrive className="h-4 w-4 text-blue-400" />
          </div>
          <div className="mt-2 font-mono text-2xl font-bold tracking-tight text-slate-50 tabular-nums">
            {summary ? formatBytes(summary.totalDiskUsageBytes) : '--'}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            {t.ecosystemCount(overview?.agents.length ?? 0)}
          </div>
        </div>

        <div className="rounded-xl border border-emerald-500/20 bg-[#0b1120]/90 p-4 transition-colors duration-200 hover:border-emerald-500/40">
          <div className="flex items-center justify-between text-xs font-medium text-slate-400">
            <span>{t.recClean}</span>
            <Sparkles className="h-4 w-4 text-emerald-400" />
          </div>
          <div className="mt-2 font-mono text-2xl font-bold tracking-tight text-emerald-400 tabular-nums">
            {summary ? formatBytes(summary.recommendedBytes) : '--'}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">{t.recItemsCount(recCount)}</div>
        </div>

        <div className="rounded-xl border border-slate-800/80 bg-[#0b1120]/90 p-4 transition-colors duration-200 hover:border-slate-700">
          <div className="flex items-center justify-between text-xs font-medium text-slate-400">
            <span>{t.orphanMcp}</span>
            <Cpu className="h-4 w-4 text-amber-400" />
          </div>
          <div
            className={`mt-2 font-mono text-2xl font-bold tracking-tight tabular-nums ${
              (summary?.orphanMcpCount ?? 0) > 0 ? 'text-amber-400' : 'text-emerald-400'
            }`}
          >
            {summary ? summary.orphanMcpCount : '--'}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">{t.orphanMcpHint}</div>
        </div>

        <div className="rounded-xl border border-slate-800/80 bg-[#0b1120]/90 p-4 transition-colors duration-200 hover:border-slate-700">
          <div className="flex items-center justify-between text-xs font-medium text-slate-400">
            <span>{t.issuesAndTrash}</span>
            <HeartPulse className="h-4 w-4 text-cyan-400" />
          </div>
          <div className="mt-2 font-mono text-2xl font-bold tracking-tight text-slate-50 tabular-nums">
            {summary ? `${summary.doctorIssueCount} / ${trashBatches.length}` : '--'}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">{t.trashHint}</div>
        </div>
      </div>

      {/* Navigation Tabs */}
      <nav className="flex items-center gap-2 px-6 pt-4">
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
            onClick={() => setTab(id)}
            className={`flex cursor-pointer items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-medium transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-cyan-500 ${
              tab === id
                ? 'bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-500/35'
                : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {/* Feedback Banner */}
      {banner && (
        <div
          role="alert"
          aria-live="polite"
          className={`mx-6 mt-3 flex items-center justify-between rounded-xl border px-4 py-2.5 text-xs ${
            banner.kind === 'error'
              ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
              : banner.kind === 'success'
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                : 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200'
          }`}
        >
          <span>{banner.text}</span>
          <button
            onClick={() => setBanner(null)}
            aria-label="Close"
            className="cursor-pointer rounded p-0.5 opacity-70 transition hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto px-6 py-4">
        {tab === 'cleanup' && (
          <div className="space-y-4">
            {overview && overview.agents.length > 0 && (
              <div className="rounded-xl border border-slate-800/80 bg-[#0b1120]/90 p-4">
                <div className="mb-2.5 flex items-center justify-between text-xs">
                  <span className="font-medium text-slate-300">{t.breakdownTitle}</span>
                  <span className="font-mono text-slate-400 tabular-nums">
                    {t.totalLabel(formatBytes(summary?.totalDiskUsageBytes))}
                  </span>
                </div>
                <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-800/80">
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
                        className={`${AGENT_COLORS[idx % AGENT_COLORS.length]} h-full cursor-pointer transition-opacity duration-200 hover:opacity-85 ${
                          selectedAgent !== 'all' && selectedAgent !== a.agent ? 'opacity-30' : ''
                        }`}
                        style={{ width: `${pct}%` }}
                      />
                    );
                  })}
                </div>
                <div className="mt-2.5 flex flex-wrap gap-3 text-[11px] text-slate-400">
                  {diskBreakdownAgents.slice(0, 7).map((a, idx) => (
                    <button
                      key={a.agent}
                      type="button"
                      onClick={() =>
                        setSelectedAgent((prev) => (prev === a.agent ? 'all' : a.agent))
                      }
                      className={`flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-0.5 transition-colors ${
                        selectedAgent === a.agent
                          ? 'bg-slate-800 text-slate-100'
                          : 'hover:text-slate-200'
                      }`}
                    >
                      <span
                        className={`h-2 w-2 rounded-full ${AGENT_COLORS[idx % AGENT_COLORS.length]}`}
                      />
                      <span>{agentLabel(a.agent)}</span>
                      <span className="font-mono text-slate-500 tabular-nums">
                        {formatBytes(a.diskUsageBytes)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800/80 bg-[#0b1120]/90 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex rounded-lg border border-slate-800 bg-slate-950/60 p-0.5 text-xs">
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
                      onClick={() => setRecFilter(k)}
                      className={`cursor-pointer rounded-md px-2.5 py-1 transition-colors duration-200 ${
                        recFilter === k
                          ? 'bg-cyan-500/20 font-semibold text-cyan-300'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={t.searchPlaceholder}
                    className="w-48 rounded-lg border border-slate-800 bg-slate-950/60 py-1.5 pl-8 pr-3 text-xs text-slate-200 placeholder:text-slate-500 focus:border-cyan-500/50 focus:outline-none"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() =>
                    setSelectedIds(
                      new Set(
                        rawItems
                          .filter((i) => i.recommendation === 'recommended')
                          .map((i) => i.id),
                      ),
                    )
                  }
                  className="cursor-pointer rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-300 transition-colors hover:bg-slate-800"
                >
                  {t.selectRec}
                </button>
                <button
                  onClick={() =>
                    setSelectedIds((prev) => {
                      const next = new Set(prev);
                      for (const it of allItems) next.add(it.id);
                      return next;
                    })
                  }
                  className="cursor-pointer rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-300 transition-colors hover:bg-slate-800"
                >
                  {t.selectVisible}
                </button>
                <button
                  onClick={() => setSelectedIds(new Set())}
                  className="cursor-pointer rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-400 transition-colors hover:bg-slate-800"
                >
                  {t.clearSel}
                </button>
                <button
                  onClick={() => void handleClean(false)}
                  disabled={busy || selectedIds.size === 0}
                  className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-cyan-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-cyan-400 focus-visible:outline-2 focus-visible:outline-cyan-300 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span className="tabular-nums">
                    {t.moveToTrash(selectedIds.size, formatBytes(selectedBytes))}
                  </span>
                </button>
                <button
                  onClick={() => setConfirmPermanent(true)}
                  disabled={busy || selectedIds.size === 0}
                  className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/15 px-3.5 py-1.5 text-xs font-semibold text-rose-300 transition-colors hover:bg-rose-500/25 focus-visible:outline-2 focus-visible:outline-rose-400 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>{t.deletePermanently}</span>
                </button>
              </div>
            </div>

            {/* Items Table */}
            {(overview || !loading) && (
            <div className="overflow-x-auto rounded-xl border border-slate-800/80 bg-[#0b1120]/80">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-800 bg-slate-900/90 text-slate-400">
                  <tr>
                    <th className="w-10 px-4 py-2.5">{t.colSelect}</th>
                    <th className="px-3 py-2.5">{t.colAgent}</th>
                    <th className="px-3 py-2.5">{t.colDesc}</th>
                    <th className="px-3 py-2.5">{t.colLevel}</th>
                    <th className="px-4 py-2.5 text-right">{t.colSize}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {allItems.map((item) => {
                    const isExempt = item.recommendation === 'exempt';
                    const checked = selectedIds.has(item.id);
                    return (
                      <tr
                        key={item.id}
                        onClick={() => toggleItem(item.id)}
                        className={`cursor-pointer transition-colors duration-150 hover:bg-slate-900/75 ${
                          checked ? 'bg-cyan-500/[0.04]' : ''
                        } ${isExempt && !checked ? 'opacity-65' : ''}`}
                      >
                        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={checked}
                            aria-label={item.description}
                            onChange={() => toggleItem(item.id)}
                            className="h-3.5 w-3.5 cursor-pointer rounded border-slate-700 bg-slate-900 accent-cyan-500"
                          />
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap font-medium text-slate-200">
                          {agentLabel(item.agent)}
                        </td>
                        <td className="max-w-lg px-3 py-3">
                          <div className="font-medium text-slate-100">{item.description}</div>
                          <div className="mt-0.5 text-[11px] text-slate-400">
                            {item.recommendationReason}
                          </div>
                          <div className="mt-0.5 truncate font-mono text-[11px] text-slate-500">
                            {item.path}
                          </div>
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap">
                          {item.recommendation === 'recommended' && (
                            <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-medium text-emerald-300 ring-1 ring-emerald-500/25">
                              {t.badgeRec}
                            </span>
                          )}
                          {item.recommendation === 'optional' && (
                            <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-medium text-amber-300 ring-1 ring-amber-500/25">
                              {t.badgeOpt}
                            </span>
                          )}
                          {item.recommendation === 'exempt' && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-slate-800 px-2.5 py-0.5 text-[11px] text-slate-400">
                              <Lock className="h-2.5 w-2.5" />
                              {t.badgeExempt}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-medium text-slate-200 tabular-nums whitespace-nowrap">
                          {formatBytes(item.sizeBytes)}
                        </td>
                      </tr>
                    );
                  })}
                  {!loading && allItems.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-12 text-center text-slate-500">
                        {t.noItems}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            )}
          </div>
        )}

        {tab === 'mcp' && overview && (
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-800/80 bg-[#0b1120]/90 p-5">
              <h2 className="text-sm font-semibold text-slate-100">{t.mcpTitle}</h2>
              <p className="mt-0.5 text-xs text-slate-400">{t.mcpDesc}</p>
              <div className="mt-3 space-y-2">
                {overview.mcp.orphanProcesses.map((proc) => (
                  <div
                    key={proc.pid}
                    className="flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/5 px-3.5 py-2.5 text-xs"
                  >
                    <div className="min-w-0 pr-4">
                      <div className="font-semibold text-amber-300 tabular-nums">
                        PID {proc.pid} · {proc.matchedName ?? 'MCP Stdio Process'} (
                        {Math.round((proc.rssKb ?? 0) / 1024)} MB)
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-slate-400">
                        {proc.command}
                      </div>
                    </div>
                    <button
                      onClick={() => void handleKillOrphan(proc.pid)}
                      disabled={busy}
                      className="shrink-0 cursor-pointer rounded-lg bg-amber-500 px-3 py-1.5 font-semibold text-slate-950 transition-colors hover:bg-amber-400"
                    >
                      {t.killSafe}
                    </button>
                  </div>
                ))}
                {overview.mcp.orphanProcesses.length === 0 && (
                  <div className="flex items-center gap-2 text-xs text-emerald-400">
                    <CheckCircle2 className="h-4 w-4" />
                    <span>{t.noOrphans}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="rounded-xl border border-slate-800/80 bg-[#0b1120]/90 p-5">
                <h3 className="text-sm font-semibold text-slate-100">
                  {t.deadLinks(overview.mcp.deadLinks.length)}
                </h3>
                <div className="mt-3 space-y-2 text-xs">
                  {overview.mcp.deadLinks.map((d, idx) => (
                    <div key={idx} className="rounded-lg border border-slate-800/70 bg-slate-950/60 p-2.5">
                      <span className="font-semibold text-rose-300">
                        [{d.agent}] {d.name}
                      </span>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-slate-500">
                        {d.command}
                      </div>
                    </div>
                  ))}
                  {overview.mcp.deadLinks.length === 0 && (
                    <p className="text-slate-500">{t.noDeadLinks}</p>
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-slate-800/80 bg-[#0b1120]/90 p-5">
                <h3 className="text-sm font-semibold text-slate-100">
                  {t.coldCaches(overview.mcp.coldCaches.length)}
                </h3>
                <div className="mt-3 max-h-52 space-y-1.5 overflow-y-auto text-xs">
                  {overview.mcp.coldCaches.map((c) => (
                    <div
                      key={c.path}
                      className="flex items-center justify-between rounded-lg border border-slate-800/70 bg-slate-950/60 px-3 py-2"
                    >
                      <span className="truncate font-mono text-[11px] text-slate-300">
                        [{c.source}] {c.path.split('/').pop()} ({c.lastAccessDays}d)
                      </span>
                      <span className="ml-2 shrink-0 font-mono text-slate-400 tabular-nums">
                        {formatBytes(c.sizeBytes)}
                      </span>
                    </div>
                  ))}
                  {overview.mcp.coldCaches.length === 0 && (
                    <p className="text-slate-500">{t.noColdCaches}</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === 'doctor' && overview && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-slate-400">{t.doctorDesc}</p>
              <button
                onClick={() => void handleDoctorFix()}
                disabled={busy || (summary?.doctorIssueCount ?? 0) === 0}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-cyan-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Wrench className="h-3.5 w-3.5" />
                <span>{t.doctorFixBtn}</span>
              </button>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {overview.doctors.map((doc) => (
                <div
                  key={`${doc.agent}:${doc.path}`}
                  className="rounded-xl border border-slate-800/80 bg-[#0b1120]/90 p-5"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-slate-100">
                      {agentLabel(doc.agent)}
                    </span>
                    {doc.healthy ? (
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
                        <CheckCircle2 className="h-3.5 w-3.5" /> {t.healthy}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-amber-400">
                        <ShieldAlert className="h-3.5 w-3.5" /> {t.issueCount(doc.issues.length)}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 truncate font-mono text-[11px] text-slate-500">
                    {doc.path}
                  </div>
                  {doc.issues.length > 0 && (
                    <div className="mt-3 space-y-1.5">
                      {doc.issues.map((issue) => (
                        <div
                          key={issue.id}
                          className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-200"
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
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-slate-400">{t.trashDesc}</p>
              <button
                onClick={() => void handlePurgeAll()}
                disabled={busy || trashBatches.length === 0}
                className="cursor-pointer rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-300 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t.purgeAll}
              </button>
            </div>

            <div className="space-y-3">
              {trashBatches.map((batch) => (
                <div
                  key={batch.batchId}
                  className="rounded-xl border border-slate-800/80 bg-[#0b1120]/90 p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <span className="font-mono text-cyan-400">
                        {batch.batchId.slice(0, 8)}
                      </span>
                      <span className="text-xs font-normal text-slate-400 tabular-nums">
                        · {formatTimeAgo(batch.timestamp, lang)} · {batch.items.length} ·{' '}
                        {formatBytes(batch.totalBytes)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => void handleRestoreBatch(batch.batchId)}
                        disabled={busy}
                        className="flex cursor-pointer items-center gap-1 rounded-lg bg-emerald-500/20 px-3 py-1.5 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-500/30"
                      >
                        <ArchiveRestore className="h-3.5 w-3.5" />
                        <span>{t.restoreBatch}</span>
                      </button>
                      <button
                        onClick={() => void handlePurgeBatch(batch.batchId)}
                        disabled={busy}
                        className="cursor-pointer rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-400 transition-colors hover:border-rose-500/40 hover:text-rose-300"
                      >
                        {t.purgeBatch}
                      </button>
                    </div>
                  </div>
                  <div className="mt-2.5 max-h-28 space-y-1 overflow-y-auto text-[11px] font-mono text-slate-500">
                    {batch.items.map((it) => (
                      <div key={it.id} className="truncate">
                        [{it.agent}] {it.originalPath} ({formatBytes(it.sizeBytes)})
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {trashBatches.length === 0 && (
                <div className="rounded-xl border border-slate-800/80 bg-[#0b1120]/60 py-12 text-center text-xs text-slate-500">
                  {t.trashEmpty}
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#060a13]/75 px-4 backdrop-blur-xs"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl border border-rose-500/35 bg-[#0b1120] p-6 shadow-2xl shadow-rose-950/30"
          >
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-rose-500/15 text-rose-400 ring-1 ring-rose-500/30">
                <ShieldAlert className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h2
                  id="confirm-permanent-title"
                  className="text-sm font-semibold text-slate-100"
                >
                  {t.confirmPermanentTitle}
                </h2>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-300">
                  {t.confirmPermanentDesc(selectedIds.size, formatBytes(selectedBytes))}
                </p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setConfirmPermanent(false)}
                className="cursor-pointer rounded-lg border border-slate-700 bg-slate-900 px-3.5 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-slate-500"
              >
                {t.cancel}
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmPermanent(false);
                  void handleClean(true);
                }}
                className="cursor-pointer rounded-lg bg-rose-600 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-rose-500 focus-visible:outline-2 focus-visible:outline-rose-400"
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
