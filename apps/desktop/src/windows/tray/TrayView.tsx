import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  Activity,
  ExternalLink,
  Globe,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { commands, type DiskSpace, type OverviewReport } from '../../bindings';
import { agentLabel, formatBytes, isDiskLow } from '../../utils/format';
import { DICT, readStoredLang, writeStoredLang, type Lang } from '../../utils/i18n';

export function TrayView() {
  const [lang, setLang] = useState<Lang>(readStoredLang);
  const [overview, setOverview] = useState<OverviewReport | null>(null);
  const [disk, setDisk] = useState<DiskSpace | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const t = DICT[lang];

  const load = async (curLang = lang, force = false) => {
    setLoading(true);
    try {
      void commands.getDiskSpace().then((r) => r.status === 'ok' && setDisk(r.data));
      const res = await commands.getOverview(
        {
          exemptHours: 24,
          agentFilter: null,
          lang: curLang,
        },
        force,
      );
      if (res.status === 'ok') setOverview(res.data);
      else setNotice(res.error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(lang, false);
    const unlisten = listen<OverviewReport>('cleaner://overview-updated', (e) => {
      setOverview(e.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
    // Mount-only: reuse cached overview across language switches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleLanguage = () => {
    const next: Lang = lang === 'zh' ? 'en' : 'zh';
    writeStoredLang(next);
    setLang(next);
  };

  const handleQuickClean = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await commands.clean({
        exemptHours: 24,
        dryRun: false,
        agentFilter: null,
        selectedIds: null,
        onlyRecommended: true,
        lang,
      });
      if (res.status === 'ok') {
        setNotice(
          lang === 'zh'
            ? `已移入回收站 ${res.data.cleanedCount} 项（释放 ${formatBytes(res.data.freedBytes)}）`
            : `Moved ${res.data.cleanedCount} item(s) to trash (${formatBytes(res.data.freedBytes)})`,
        );
        await load(lang);
      } else {
        setNotice(res.error);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleKillOrphans = async () => {
    if (!overview?.mcp.orphanProcesses.length) return;
    setBusy(true);
    try {
      for (const proc of overview.mcp.orphanProcesses) {
        await commands.killOrphanMcp(proc.pid);
      }
      setNotice(
        lang === 'zh'
          ? `已清理 ${overview.mcp.orphanProcesses.length} 个孤儿 MCP 进程`
          : `Terminated ${overview.mcp.orphanProcesses.length} orphan MCP process(es)`,
      );
      await load(lang);
    } finally {
      setBusy(false);
    }
  };

  const handleOpenDashboard = async () => {
    await commands.openDashboard();
    await commands.hideTrayWindow();
  };

  const summary = overview?.summary;
  const maxAgentBytes = Math.max(
    1,
    ...(overview?.agents.map((a) => a.totalBytes ?? 0) ?? [1]),
  );

  return (
    <div className="flex h-screen flex-col justify-between border border-line bg-canvas p-4 text-ink select-none">
      <div>
        <div
          data-tauri-drag-region
          className="flex items-center justify-between border-b border-line pb-3"
        >
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-[11px] bg-accent-soft text-accent ring-1 ring-accent/20">
              <Sparkles className="h-4 w-4" />
            </div>
            <div>
              <h1 className="font-display text-[17px] font-medium leading-tight tracking-[-0.02em]">
                Agent Cleaner
              </h1>
              <p className="mt-0.5 text-[10px] text-muted">{t.traySubtitle}</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={toggleLanguage}
              className="icon-btn h-8 w-8"
              title={lang === 'zh' ? 'Switch to English' : '切换为中文'}
              aria-label={lang === 'zh' ? 'Switch to English' : '切换为中文'}
            >
              <Globe className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void load(lang, true)}
              disabled={loading || busy}
              aria-label={t.rescan}
              className="icon-btn h-8 w-8 disabled:opacity-50"
              title={t.rescan}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2.5">
          <div className="panel border-accent/20 p-3">
            <div className="text-[11px] font-medium text-muted">{t.recClean}</div>
            <div className="mt-1.5 text-xl font-medium tracking-[-0.02em] text-accent-strong tabular-nums">
              {summary ? formatBytes(summary.recommendedBytes) : '--'}
            </div>
          </div>
          <div className="panel p-3">
            <div className="text-[11px] font-medium text-muted">{t.orphanMcp}</div>
            <div
              className={`mt-1.5 text-xl font-medium tracking-[-0.02em] tabular-nums ${
                (summary?.orphanMcpCount ?? 0) > 0 ? 'text-warning' : 'text-success'
              }`}
            >
              {summary ? `${summary.orphanMcpCount}` : '--'}
            </div>
          </div>
          <div className="panel col-span-2 flex items-center justify-between p-3">
            <div className="text-[11px] font-medium text-muted">{t.diskSpace}</div>
            <div
              className={`text-base font-medium tabular-nums ${
                isDiskLow(disk) ? 'text-warning' : 'text-ink'
              }`}
            >
              {disk ? formatBytes(disk.availableBytes) : '--'}
              {disk?.totalBytes ? (
                <span className="ml-1 text-[11px] font-normal text-subtle">
                  / {formatBytes(disk.totalBytes)}
                </span>
              ) : null}
            </div>
          </div>
        </div>

        <div className="mt-3 max-h-44 space-y-2 overflow-y-auto pr-1">
          {(overview?.agents ?? []).slice(0, 5).map((a) => {
            const pct = Math.min(100, Math.round(((a.totalBytes ?? 0) / maxAgentBytes) * 100));
            return (
              <div
                key={a.agent}
                className="rounded-xl border border-line bg-surface px-3 py-2.5 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium text-body">{agentLabel(a.agent)}</span>
                  <span className="shrink-0 text-muted tabular-nums">
                    {formatBytes(a.totalBytes)}
                  </span>
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-line-soft">
                  <div
                    className="h-full rounded-full bg-accent transition-all duration-300"
                    style={{ width: `${Math.max(4, pct)}%` }}
                  />
                </div>
              </div>
            );
          })}
          {!loading && (!overview || overview.agents.length === 0) && (
            <div className="flex items-center gap-2 rounded-xl border border-success/20 bg-success-soft p-3 text-xs text-success">
              <ShieldCheck className="h-4 w-4 shrink-0" />
              <span>{t.trayCleanEnv}</span>
            </div>
          )}
        </div>

        {notice && (
          <div
            role="status"
            aria-live="polite"
            className="mt-2.5 rounded-xl border border-accent/20 bg-accent-soft px-3 py-2 text-[11px] leading-relaxed text-accent-strong"
          >
            {notice}
          </div>
        )}
      </div>

      <div className="space-y-2 pt-3">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void handleQuickClean()}
            disabled={busy || (summary?.recommendedBytes ?? 0) === 0}
            className="btn btn-primary flex-1"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>{t.trayQuickClean}</span>
          </button>
          {(summary?.orphanMcpCount ?? 0) > 0 && (
            <button
              type="button"
              onClick={() => void handleKillOrphans()}
              disabled={busy}
              className="btn btn-warning"
            >
              <Activity className="h-3.5 w-3.5" />
              <span>{t.trayKillOrphans}</span>
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={() => void handleOpenDashboard()}
          className="btn btn-secondary w-full"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          <span>{t.trayOpenDash}</span>
        </button>
      </div>
    </div>
  );
}
