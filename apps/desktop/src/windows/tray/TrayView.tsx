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
import { commands, type OverviewReport } from '../../bindings';
import { agentLabel, formatBytes } from '../../utils/format';
import { DICT, readStoredLang, writeStoredLang, type Lang } from '../../utils/i18n';

export function TrayView() {
  const [lang, setLang] = useState<Lang>(readStoredLang);
  const [overview, setOverview] = useState<OverviewReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const t = DICT[lang];

  const load = async (curLang = lang) => {
    setLoading(true);
    try {
      const res = await commands.getOverview({
        exemptHours: 24,
        agentFilter: null,
        lang: curLang,
      });
      if (res.status === 'ok') setOverview(res.data);
      else setNotice(res.error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(lang);
    const unlisten = listen<OverviewReport>('cleaner://overview-updated', (e) => {
      setOverview(e.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [lang]);

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
    <div className="flex h-screen flex-col justify-between border border-slate-800/90 bg-[#060a13] bg-[radial-gradient(ellipse_at_top_right,_rgba(6,182,212,0.12),_transparent_55%)] p-4 text-slate-100 select-none">
      <div>
        <div
          data-tauri-drag-region
          className="flex items-center justify-between border-b border-slate-800/80 pb-3"
        >
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500/20 to-blue-600/20 text-cyan-400 ring-1 ring-cyan-500/30">
              <Sparkles className="h-4 w-4" />
            </div>
            <div>
              <h1 className="text-sm font-semibold tracking-tight leading-tight">Agent Cleaner</h1>
              <p className="text-[11px] text-slate-400">{t.traySubtitle}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={toggleLanguage}
              className="flex cursor-pointer items-center gap-1 rounded-lg border border-slate-800/80 bg-slate-900/80 px-2 py-1 text-[11px] text-slate-300 transition-colors hover:border-slate-700 hover:text-slate-100"
              title={lang === 'zh' ? 'Switch to English' : '切换为中文'}
            >
              <Globe className="h-3 w-3" />
              <span>{lang === 'zh' ? 'EN' : '中'}</span>
            </button>
            <button
              onClick={() => void load(lang)}
              disabled={loading || busy}
              aria-label={t.rescan}
              className="cursor-pointer rounded-lg border border-slate-800/80 bg-slate-900/80 p-1.5 text-slate-400 transition-colors duration-200 hover:border-slate-700 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-cyan-500 disabled:opacity-50"
              title={t.rescan}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2.5">
          <div className="rounded-xl border border-slate-800/80 bg-[#0b1120] p-3">
            <div className="text-[11px] font-medium text-slate-400">{t.recClean}</div>
            <div className="mt-1 font-mono text-lg font-bold text-cyan-400 tabular-nums">
              {summary ? formatBytes(summary.recommendedBytes) : '--'}
            </div>
          </div>
          <div className="rounded-xl border border-slate-800/80 bg-[#0b1120] p-3">
            <div className="text-[11px] font-medium text-slate-400">{t.orphanMcp}</div>
            <div
              className={`mt-1 font-mono text-lg font-bold tabular-nums ${
                (summary?.orphanMcpCount ?? 0) > 0 ? 'text-amber-400' : 'text-emerald-400'
              }`}
            >
              {summary ? `${summary.orphanMcpCount}` : '--'}
            </div>
          </div>
        </div>

        <div className="mt-3 max-h-44 space-y-2 overflow-y-auto pr-1">
          {(overview?.agents ?? []).slice(0, 5).map((a) => {
            const pct = Math.min(100, Math.round(((a.totalBytes ?? 0) / maxAgentBytes) * 100));
            return (
              <div
                key={a.agent}
                className="rounded-lg border border-slate-800/60 bg-[#0b1120]/90 px-2.5 py-2 text-xs"
              >
                <div className="flex items-center justify-between">
                  <span className="truncate font-medium text-slate-200">{agentLabel(a.agent)}</span>
                  <span className="font-mono text-slate-300 tabular-nums">
                    {formatBytes(a.totalBytes)}
                  </span>
                </div>
                <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-slate-800/90">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-blue-500 transition-all duration-300"
                    style={{ width: `${Math.max(4, pct)}%` }}
                  />
                </div>
              </div>
            );
          })}
          {!loading && (!overview || overview.agents.length === 0) && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 p-2.5 text-xs text-emerald-300">
              <ShieldCheck className="h-4 w-4 shrink-0" />
              <span>{t.trayCleanEnv}</span>
            </div>
          )}
        </div>

        {notice && (
          <div
            role="status"
            aria-live="polite"
            className="mt-2.5 rounded-lg border border-cyan-500/35 bg-cyan-500/10 px-2.5 py-1.5 text-[11px] text-cyan-200"
          >
            {notice}
          </div>
        )}
      </div>

      <div className="space-y-2 pt-2">
        <div className="flex gap-2">
          <button
            onClick={() => void handleQuickClean()}
            disabled={busy || (summary?.recommendedBytes ?? 0) === 0}
            className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-cyan-500 px-3 py-2 text-xs font-semibold text-slate-950 transition-colors duration-200 hover:bg-cyan-400 focus-visible:outline-2 focus-visible:outline-cyan-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>{t.trayQuickClean}</span>
          </button>
          {(summary?.orphanMcpCount ?? 0) > 0 && (
            <button
              onClick={() => void handleKillOrphans()}
              disabled={busy}
              className="flex cursor-pointer items-center justify-center gap-1 rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-xs font-medium text-amber-300 transition-colors duration-200 hover:bg-amber-500/25 focus-visible:outline-2 focus-visible:outline-amber-400"
            >
              <Activity className="h-3.5 w-3.5" />
              <span>{t.trayKillOrphans}</span>
            </button>
          )}
        </div>

        <button
          onClick={() => void handleOpenDashboard()}
          className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-slate-800 bg-[#0b1120] px-3 py-2 text-xs font-medium text-slate-200 transition-colors duration-200 hover:border-slate-700 hover:bg-slate-800/80 focus-visible:outline-2 focus-visible:outline-cyan-500"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          <span>{t.trayOpenDash}</span>
        </button>
      </div>
    </div>
  );
}
