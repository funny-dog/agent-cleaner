use super::{
    platform_cache_dirs, platform_log_dirs, platform_support_dirs, push_dir_item, AgentTarget,
    DESKTOP_CACHE_SUBDIRS,
};
use crate::fs_safe::get_dir_size;
use crate::types::{CleanerContext, ItemStatus, Language, ScanCategory, ScanItem, ScanResult};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

type CleanableEntry = (PathBuf, ScanCategory, String, String, ItemStatus);

/// Shared Electron/Tauri desktop cache subdirs under `Library/Application Support/<App>`.
fn push_desktop_caches(
    out: &mut Vec<CleanableEntry>,
    support_dir: &Path,
    zh_app: &str,
    en_app: &str,
) {
    for (sub, cat, zh_kind, en_kind) in DESKTOP_CACHE_SUBDIRS {
        out.push((
            support_dir.join(sub),
            cat.clone(),
            format!("{zh_app} {zh_kind}"),
            format!("{en_app} {en_kind}"),
            ItemStatus::Active,
        ));
    }
}

fn push_platform_desktop_app(
    usage: &mut Vec<PathBuf>,
    cleanable: &mut Vec<CleanableEntry>,
    ctx: &CleanerContext,
    app_name: &str,
    zh_app: &str,
    en_app: &str,
) {
    for dir in platform_support_dirs(ctx, app_name) {
        push_desktop_caches(cleanable, &dir, zh_app, en_app);
        usage.push(dir);
    }
    for dir in platform_cache_dirs(ctx, app_name) {
        cleanable.push(entry(
            dir.clone(),
            ScanCategory::Cache,
            format!("{zh_app} 应用缓存"),
            format!("{en_app} application cache"),
            ItemStatus::Active,
        ));
        usage.push(dir);
    }
    for dir in platform_log_dirs(ctx, app_name) {
        cleanable.push(entry(
            dir.clone(),
            ScanCategory::Log,
            format!("{zh_app} 系统日志"),
            format!("{en_app} system logs"),
            ItemStatus::Active,
        ));
        usage.push(dir);
    }
}

fn entry(
    path: PathBuf,
    category: ScanCategory,
    zh: impl Into<String>,
    en: impl Into<String>,
    status: ItemStatus,
) -> CleanableEntry {
    (path, category, zh.into(), en.into(), status)
}

/// Declarative table-driven scanner for ecosystem AI agents.
fn scan_table(
    agent: &str,
    usage_dirs: &[PathBuf],
    cleanable_dirs: &[CleanableEntry],
    ctx: &CleanerContext,
    exempt_hours: u64,
    lang: Language,
) -> ScanResult {
    let now_ms = ctx.now();
    let any_exists = usage_dirs.iter().any(|d| d.exists());
    if !any_exists {
        return ScanResult {
            agent: agent.to_string(),
            items: Vec::new(),
            total_bytes: 0,
            disk_usage_bytes: 0,
            scanned_at: now_ms,
        };
    }

    let mut seen_cleanable = HashSet::new();
    let mut items: Vec<ScanItem> = Vec::new();
    for (dir, category, zh, en, status) in cleanable_dirs {
        if !seen_cleanable.insert(dir.clone()) {
            continue;
        }
        push_dir_item(
            &mut items,
            agent,
            dir,
            category.clone(),
            lang.tr(zh, en),
            status.clone(),
            true,
            exempt_hours,
            now_ms,
            lang,
        );
    }

    let mut seen_usage = HashSet::new();
    let disk_usage_bytes = usage_dirs
        .iter()
        .filter(|d| seen_usage.insert((*d).clone()))
        .map(|d| get_dir_size(d))
        .sum();
    let total_bytes = items.iter().map(|i| i.size_bytes).sum();

    ScanResult {
        agent: agent.to_string(),
        items,
        total_bytes,
        disk_usage_bytes,
        scanned_at: now_ms,
    }
}

trait EcosystemTarget: Sync + Send {
    fn target_id(&self) -> &'static str;
    fn spec(&self, ctx: &CleanerContext) -> (Vec<PathBuf>, Vec<CleanableEntry>);
}

impl<T: EcosystemTarget> AgentTarget for T {
    fn id(&self) -> &'static str {
        self.target_id()
    }

    fn claimed_dirs(&self, ctx: &CleanerContext) -> Vec<PathBuf> {
        self.spec(ctx).0
    }

    fn scan(&self, ctx: &CleanerContext, exempt_hours: u64, lang: Language) -> ScanResult {
        let (usage_dirs, cleanable) = self.spec(ctx);
        scan_table(
            self.target_id(),
            &usage_dirs,
            &cleanable,
            ctx,
            exempt_hours,
            lang,
        )
    }
}

pub struct GeminiTarget;
impl EcosystemTarget for GeminiTarget {
    fn target_id(&self) -> &'static str {
        "gemini"
    }
    fn spec(&self, ctx: &CleanerContext) -> (Vec<PathBuf>, Vec<CleanableEntry>) {
        let gemini = ctx.home_dir.join(".gemini");
        let ag_dir = gemini.join("antigravity");
        let ag_cli = gemini.join("antigravity-cli");
        let ag_browser = gemini.join("antigravity-browser-profile");
        let antigravity = ctx.home_dir.join(".antigravity");
        let ag_cockpit = ctx.home_dir.join(".antigravity_cockpit");
        let support = ctx.home_dir.join("Library/Application Support");
        let ag_support = support.join("Antigravity");
        let gemini_support = support.join("com.google.GeminiMacOS");
        let gemini_launcher_support = support.join("com.google.GeminiMacOS.launcher");
        let caches = ctx.home_dir.join("Library/Caches");
        let ag_cache = caches.join("com.google.antigravity");
        let ag_shipit = caches.join("com.google.antigravity.ShipIt");
        let ag_cache_short = caches.join("antigravity");
        let gemini_mac_cache = caches.join("com.google.geminimacos");
        let gemini_launcher_cache = caches.join("com.google.geminimacos.launcher");
        let xdg_ag_cache = ctx.home_dir.join(".cache/antigravity");
        let ag_logs = ctx.home_dir.join("Library/Logs/Antigravity");

        let mut cleanable = vec![
            entry(
                gemini.join("tmp"),
                ScanCategory::Tmp,
                "Gemini / Antigravity 临时工作文件",
                "Gemini / Antigravity scratch & temp files",
                ItemStatus::Active,
            ),
            entry(
                gemini.join("tasks"),
                ScanCategory::Archive,
                "Antigravity 后台任务与历史会话归档",
                "Antigravity background tasks & session logs",
                ItemStatus::Active,
            ),
            entry(
                ag_cache.clone(),
                ScanCategory::Cache,
                "Antigravity macOS 系统应用缓存",
                "Antigravity macOS Caches",
                ItemStatus::Active,
            ),
            entry(
                ag_cache_short.clone(),
                ScanCategory::Cache,
                "Antigravity 本地缓存",
                "Antigravity local cache",
                ItemStatus::Active,
            ),
            entry(
                ag_shipit.clone(),
                ScanCategory::Updater,
                "Antigravity 自动更新安装包残留",
                "Antigravity ShipIt updater cache",
                ItemStatus::Cold,
            ),
            entry(
                gemini_mac_cache.clone(),
                ScanCategory::Cache,
                "Gemini macOS 桌面应用缓存",
                "Gemini macOS Caches",
                ItemStatus::Active,
            ),
            entry(
                gemini_launcher_cache.clone(),
                ScanCategory::Cache,
                "Gemini 启动器缓存",
                "Gemini launcher Caches",
                ItemStatus::Active,
            ),
            entry(
                xdg_ag_cache.clone(),
                ScanCategory::Cache,
                "Antigravity XDG 缓存目录",
                "Antigravity XDG cache directory",
                ItemStatus::Active,
            ),
            entry(
                ag_logs.clone(),
                ScanCategory::Log,
                "Antigravity macOS 系统运行日志",
                "Antigravity macOS Library logs",
                ItemStatus::Active,
            ),
        ];

        for (root, zh_prefix, en_prefix) in [
            (&ag_dir, "Antigravity", "Antigravity"),
            (&ag_cli, "Antigravity CLI", "Antigravity CLI"),
        ] {
            cleanable.push(entry(
                root.join("log"),
                ScanCategory::Log,
                format!("{zh_prefix} 运行日志"),
                format!("{en_prefix} runtime logs"),
                ItemStatus::Active,
            ));
            cleanable.push(entry(
                root.join("scratch"),
                ScanCategory::Tmp,
                format!("{zh_prefix} 临时工作区文件"),
                format!("{en_prefix} scratch files"),
                ItemStatus::Active,
            ));
            cleanable.push(entry(
                root.join("brain"),
                ScanCategory::Archive,
                format!("{zh_prefix} 历史 Brain 与产物归档"),
                format!("{en_prefix} historical brain & artifact archive"),
                ItemStatus::Cold,
            ));
            cleanable.push(entry(
                root.join("conversations"),
                ScanCategory::Archive,
                format!("{zh_prefix} 历史会话数据库归档"),
                format!("{en_prefix} historical conversation archive"),
                ItemStatus::Cold,
            ));
        }

        for (sub, zh, en) in [
            (
                "Default/Cache",
                "Antigravity 内置浏览器 HTTP 缓存",
                "Antigravity internal webview HTTP cache",
            ),
            (
                "Default/Code Cache",
                "Antigravity 内置浏览器 JS 字节码缓存",
                "Antigravity internal webview JS code cache",
            ),
            (
                "Default/GPUCache",
                "Antigravity 内置浏览器 GPU 缓存",
                "Antigravity internal webview GPU cache",
            ),
            (
                "Default/DawnWebGPUCache",
                "Antigravity 内置浏览器 WebGPU 缓存",
                "Antigravity internal webview DawnWebGPU cache",
            ),
            (
                "Default/DawnGraphiteCache",
                "Antigravity 内置浏览器 Graphite 缓存",
                "Antigravity internal webview DawnGraphite cache",
            ),
            (
                "Default/Service Worker/CacheStorage",
                "Antigravity 内置浏览器 Service Worker 缓存",
                "Antigravity internal webview Service Worker cache",
            ),
            (
                "GrShaderCache",
                "Antigravity 内置浏览器 GrShader 缓存",
                "Antigravity internal webview GrShader cache",
            ),
            (
                "ShaderCache",
                "Antigravity 内置浏览器 Shader 缓存",
                "Antigravity internal webview Shader cache",
            ),
            (
                "GraphiteDawnCache",
                "Antigravity 内置浏览器 GraphiteDawn 缓存",
                "Antigravity internal webview GraphiteDawn cache",
            ),
        ] {
            cleanable.push(entry(
                ag_browser.join(sub),
                ScanCategory::Cache,
                zh,
                en,
                ItemStatus::Active,
            ));
        }

        push_desktop_caches(&mut cleanable, &ag_support, "Antigravity", "Antigravity");
        push_desktop_caches(
            &mut cleanable,
            &gemini_support,
            "Gemini macOS",
            "Gemini macOS",
        );
        push_desktop_caches(
            &mut cleanable,
            &gemini_launcher_support,
            "Gemini Launcher",
            "Gemini Launcher",
        );

        let mut usage = vec![
            gemini,
            antigravity,
            ag_cockpit,
            ag_support,
            gemini_support,
            gemini_launcher_support,
            ag_cache,
            ag_shipit,
            ag_cache_short,
            gemini_mac_cache,
            gemini_launcher_cache,
            xdg_ag_cache,
            ag_logs,
        ];
        push_platform_desktop_app(
            &mut usage,
            &mut cleanable,
            ctx,
            "Antigravity",
            "Antigravity",
            "Antigravity",
        );
        (usage, cleanable)
    }
}

pub struct WorkbuddyTarget;
impl EcosystemTarget for WorkbuddyTarget {
    fn target_id(&self) -> &'static str {
        "workbuddy"
    }
    fn spec(&self, ctx: &CleanerContext) -> (Vec<PathBuf>, Vec<CleanableEntry>) {
        let wb = ctx.home_dir.join(".workbuddy");
        let wb_ai = ctx.home_dir.join(".workbuddy-ai");
        let support = ctx.home_dir.join("Library/Application Support");
        let wb_support = support.join("WorkBuddy");
        let wb_ai_support = support.join("WorkBuddy AI");
        let wb_mac_support = support.join("com.tencent.workbuddy.mac");
        let caches = ctx.home_dir.join("Library/Caches");
        let wb_migration = caches.join("com.tencent.workbuddy.mac.BundleMigration");
        let wb_mac_cache = caches.join("com.tencent.workbuddy.mac");
        let wb_ai_migration = caches.join("com.workbuddy.workbuddy-ai.BundleMigration");

        let mut cleanable = vec![
            entry(
                wb_mac_cache.clone(),
                ScanCategory::Cache,
                "WorkBuddy macOS 应用缓存",
                "WorkBuddy macOS Caches",
                ItemStatus::Active,
            ),
            entry(
                wb_migration.clone(),
                ScanCategory::Updater,
                "WorkBuddy 版本迁移安装包残留",
                "WorkBuddy macOS BundleMigration updater residue",
                ItemStatus::Cold,
            ),
            entry(
                wb_ai_migration.clone(),
                ScanCategory::Updater,
                "WorkBuddy AI 版本迁移安装包残留",
                "WorkBuddy AI macOS BundleMigration updater residue",
                ItemStatus::Cold,
            ),
        ];

        for (root, label) in [(&wb, "WorkBuddy"), (&wb_ai, "WorkBuddy AI")] {
            for (sub, cat, zh_kind, en_kind) in [
                (
                    "traces",
                    ScanCategory::Log,
                    "遥测与执行追踪日志",
                    "telemetry & execution traces",
                ),
                (
                    "logs",
                    ScanCategory::Log,
                    "应用运行日志",
                    "runtime application logs",
                ),
                ("audit-log", ScanCategory::Log, "审计日志", "audit logs"),
                ("cache", ScanCategory::Cache, "常规缓存", "general cache"),
                (
                    "tmp",
                    ScanCategory::Tmp,
                    "临时工作目录",
                    "temporary working directory",
                ),
                (
                    "clipboard-images",
                    ScanCategory::Cache,
                    "剪贴板图片缓存",
                    "clipboard image cache",
                ),
                (
                    "file-history",
                    ScanCategory::Cache,
                    "编辑器文件历史缓存",
                    "editor file history cache",
                ),
                (
                    "file-tree-manifests",
                    ScanCategory::Cache,
                    "工作区目录树清单缓存",
                    "workspace tree manifest cache",
                ),
                (
                    "connectors-marketplace",
                    ScanCategory::Cache,
                    "市场扩展目录缓存",
                    "marketplace cached catalogs",
                ),
            ] {
                cleanable.push(entry(
                    root.join(sub),
                    cat,
                    format!("{label} {zh_kind}"),
                    format!("{label} {en_kind}"),
                    ItemStatus::Active,
                ));
            }
        }

        push_desktop_caches(&mut cleanable, &wb_support, "WorkBuddy", "WorkBuddy");
        push_desktop_caches(
            &mut cleanable,
            &wb_ai_support,
            "WorkBuddy AI",
            "WorkBuddy AI",
        );
        push_desktop_caches(
            &mut cleanable,
            &wb_mac_support,
            "WorkBuddy macOS",
            "WorkBuddy macOS",
        );

        let mut usage = vec![
            wb,
            wb_ai,
            wb_support,
            wb_ai_support,
            wb_mac_support,
            wb_mac_cache,
            wb_migration,
            wb_ai_migration,
        ];
        push_platform_desktop_app(
            &mut usage,
            &mut cleanable,
            ctx,
            "WorkBuddy",
            "WorkBuddy",
            "WorkBuddy",
        );
        push_platform_desktop_app(
            &mut usage,
            &mut cleanable,
            ctx,
            "WorkBuddy AI",
            "WorkBuddy AI",
            "WorkBuddy AI",
        );
        (usage, cleanable)
    }
}

pub struct QoderTarget;
impl EcosystemTarget for QoderTarget {
    fn target_id(&self) -> &'static str {
        "qoder"
    }
    fn spec(&self, ctx: &CleanerContext) -> (Vec<PathBuf>, Vec<CleanableEntry>) {
        let qoder = ctx.home_dir.join(".qoder");
        let qoder_cn = ctx.home_dir.join(".qoder-cn");
        let qoder_sec = ctx.home_dir.join(".qodersec");
        let qoder_cli = ctx.home_dir.join(".qoder-cli");
        let caches = ctx.home_dir.join("Library/Caches");
        let support = ctx.home_dir.join("Library/Application Support");
        let upd = caches.join("qoder-updater");
        let upd_cn = caches.join("qoder-cn-updater");
        let app_cache = caches.join("com.qoder.app");
        let app_shipit = caches.join("com.qoder.app.ShipIt");
        let cn_cache = caches.join("com.qodercn.app");
        let cn_shipit = caches.join("com.qodercn.app.ShipIt");
        let installer = support.join("com.qoder.installer");
        let stable_support = support.join("com.qoder.app.stable");
        let cn_stable_support = support.join("com.qodercn.app.stable");

        let mut cleanable = vec![
            entry(
                upd.clone(),
                ScanCategory::Updater,
                "Qoder 自动更新安装包缓存",
                "Qoder desktop updater package cache",
                ItemStatus::Cold,
            ),
            entry(
                upd_cn.clone(),
                ScanCategory::Updater,
                "Qoder CN 自动更新安装包缓存",
                "Qoder CN desktop updater package cache",
                ItemStatus::Cold,
            ),
            entry(
                app_cache.clone(),
                ScanCategory::Cache,
                "Qoder macOS 应用缓存",
                "Qoder macOS Caches",
                ItemStatus::Active,
            ),
            entry(
                app_shipit.clone(),
                ScanCategory::Updater,
                "Qoder ShipIt 更新安装包残留",
                "Qoder ShipIt updater cache",
                ItemStatus::Cold,
            ),
            entry(
                cn_cache.clone(),
                ScanCategory::Cache,
                "Qoder CN macOS 应用缓存",
                "Qoder CN macOS Caches",
                ItemStatus::Active,
            ),
            entry(
                cn_shipit.clone(),
                ScanCategory::Updater,
                "Qoder CN ShipIt 更新安装包残留",
                "Qoder CN ShipIt updater cache",
                ItemStatus::Cold,
            ),
            entry(
                installer.clone(),
                ScanCategory::Updater,
                "Qoder 安装器残留缓存",
                "Qoder installer cache",
                ItemStatus::Cold,
            ),
        ];

        for (root, label) in [
            (&qoder, "Qoder"),
            (&qoder_cn, "Qoder CN"),
            (&qoder_cli, "Qoder CLI"),
        ] {
            for (sub, cat, zh_kind, en_kind) in [
                (
                    "logs",
                    ScanCategory::Log,
                    "应用运行日志",
                    "application logs",
                ),
                (
                    "tmp",
                    ScanCategory::Tmp,
                    "临时碎片文件",
                    "scratch temporary files",
                ),
                ("cache", ScanCategory::Cache, "运行时缓存", "runtime cache"),
                (
                    "shell-snapshots",
                    ScanCategory::Cache,
                    "终端快照缓存",
                    "terminal snapshots",
                ),
                (
                    "file-history",
                    ScanCategory::Cache,
                    "本地文件修改历史缓存",
                    "local file history",
                ),
            ] {
                cleanable.push(entry(
                    root.join(sub),
                    cat,
                    format!("{label} {zh_kind}"),
                    format!("{label} {en_kind}"),
                    ItemStatus::Active,
                ));
            }
        }

        push_desktop_caches(&mut cleanable, &stable_support, "Qoder", "Qoder");
        push_desktop_caches(&mut cleanable, &cn_stable_support, "Qoder CN", "Qoder CN");

        let mut usage = vec![
            qoder,
            qoder_cn,
            qoder_sec,
            qoder_cli,
            upd,
            upd_cn,
            app_cache,
            app_shipit,
            cn_cache,
            cn_shipit,
            installer,
            stable_support,
            cn_stable_support,
        ];
        push_platform_desktop_app(&mut usage, &mut cleanable, ctx, "Qoder", "Qoder", "Qoder");
        push_platform_desktop_app(
            &mut usage,
            &mut cleanable,
            ctx,
            "Qoder CN",
            "Qoder CN",
            "Qoder CN",
        );
        (usage, cleanable)
    }
}

pub struct KimiTarget;
impl EcosystemTarget for KimiTarget {
    fn target_id(&self) -> &'static str {
        "kimi"
    }
    fn spec(&self, ctx: &CleanerContext) -> (Vec<PathBuf>, Vec<CleanableEntry>) {
        let kimi = ctx.home_dir.join(".kimi");
        let kimi_code = ctx.home_dir.join(".kimi-code");
        let kimi_work = ctx.home_dir.join(".kimi-work");
        let kimi_webbridge = ctx.home_dir.join(".kimi-webbridge");
        let kimi_desktop = ctx
            .home_dir
            .join("Library/Application Support/kimi-desktop");
        let kimi_code_cache = ctx.home_dir.join("Library/Caches/kimi-code");

        let mut cleanable = vec![
            entry(
                kimi.join("logs"),
                ScanCategory::Log,
                "Kimi CLI 与守护进程日志",
                "Kimi CLI & daemon logs",
                ItemStatus::Active,
            ),
            entry(
                kimi.join("telemetry"),
                ScanCategory::Log,
                "Kimi 遥测日志",
                "Kimi telemetry logs",
                ItemStatus::Active,
            ),
            entry(
                kimi.join("sessions"),
                ScanCategory::Archive,
                "Kimi 历史 CLI 会话归档",
                "Kimi historical CLI sessions",
                ItemStatus::Active,
            ),
            entry(
                kimi_webbridge.join("logs"),
                ScanCategory::Log,
                "Kimi WebBridge 日志",
                "Kimi WebBridge logs",
                ItemStatus::Active,
            ),
            entry(
                kimi_code_cache.clone(),
                ScanCategory::Cache,
                "Kimi Code macOS 缓存",
                "Kimi Code macOS Caches",
                ItemStatus::Active,
            ),
        ];

        for (root, label) in [(&kimi_code, "Kimi Code"), (&kimi_work, "Kimi Work")] {
            for (sub, cat, zh_kind, en_kind, status) in [
                (
                    "logs",
                    ScanCategory::Log,
                    "运行日志",
                    "runtime logs",
                    ItemStatus::Active,
                ),
                (
                    "cache",
                    ScanCategory::Cache,
                    "本地缓存",
                    "local cache",
                    ItemStatus::Active,
                ),
                (
                    "tmp",
                    ScanCategory::Tmp,
                    "临时文件",
                    "temporary files",
                    ItemStatus::Active,
                ),
                (
                    "sessions",
                    ScanCategory::Archive,
                    "历史会话归档",
                    "historical sessions archive",
                    ItemStatus::Cold,
                ),
                (
                    "search-index",
                    ScanCategory::Cache,
                    "代码搜索索引缓存",
                    "code search index cache",
                    ItemStatus::Active,
                ),
                (
                    "updates",
                    ScanCategory::Updater,
                    "自动更新缓存",
                    "updater cache",
                    ItemStatus::Cold,
                ),
            ] {
                cleanable.push(entry(
                    root.join(sub),
                    cat,
                    format!("{label} {zh_kind}"),
                    format!("{label} {en_kind}"),
                    status,
                ));
            }
        }

        push_desktop_caches(
            &mut cleanable,
            &kimi_desktop,
            "Kimi Desktop",
            "Kimi Desktop",
        );

        let mut usage = vec![
            kimi,
            kimi_code,
            kimi_work,
            kimi_webbridge,
            kimi_desktop,
            kimi_code_cache,
        ];
        push_platform_desktop_app(
            &mut usage,
            &mut cleanable,
            ctx,
            "kimi-desktop",
            "Kimi Desktop",
            "Kimi Desktop",
        );
        (usage, cleanable)
    }
}

pub struct KiroTarget;
impl EcosystemTarget for KiroTarget {
    fn target_id(&self) -> &'static str {
        "kiro"
    }
    fn spec(&self, ctx: &CleanerContext) -> (Vec<PathBuf>, Vec<CleanableEntry>) {
        let kiro = ctx.home_dir.join(".kiro");
        let kiro_shared = ctx.home_dir.join(".kiro-shared");
        let kiro_cli = ctx.home_dir.join("Library/Application Support/kiro-cli");
        let kirocrew = ctx
            .home_dir
            .join("Library/Application Support/kirocrew-desktop");
        let kirocrew_logs = ctx.home_dir.join("Library/Logs/kirocrew-desktop");

        let mut cleanable = vec![
            entry(
                kiro_cli.join("logs"),
                ScanCategory::Log,
                "Kiro CLI 运行日志",
                "Kiro CLI runtime logs",
                ItemStatus::Active,
            ),
            entry(
                kiro_cli.join("cache"),
                ScanCategory::Cache,
                "Kiro CLI 缓存",
                "Kiro CLI cache",
                ItemStatus::Active,
            ),
            entry(
                kirocrew_logs.clone(),
                ScanCategory::Log,
                "KiroCrew Desktop 系统运行日志",
                "KiroCrew Desktop macOS Library logs",
                ItemStatus::Active,
            ),
        ];

        for (root, label) in [(&kiro, "Kiro"), (&kiro_shared, "Kiro Shared")] {
            for (sub, cat, zh_kind, en_kind) in [
                ("logs", ScanCategory::Log, "运行日志", "runtime logs"),
                ("cache", ScanCategory::Cache, "本地缓存", "local cache"),
                ("tmp", ScanCategory::Tmp, "临时文件", "temporary files"),
            ] {
                cleanable.push(entry(
                    root.join(sub),
                    cat,
                    format!("{label} {zh_kind}"),
                    format!("{label} {en_kind}"),
                    ItemStatus::Active,
                ));
            }
        }

        push_desktop_caches(
            &mut cleanable,
            &kirocrew,
            "KiroCrew Desktop",
            "KiroCrew Desktop",
        );

        let mut usage = vec![kiro, kiro_shared, kiro_cli, kirocrew, kirocrew_logs];
        push_platform_desktop_app(
            &mut usage,
            &mut cleanable,
            ctx,
            "kirocrew-desktop",
            "KiroCrew Desktop",
            "KiroCrew Desktop",
        );
        push_platform_desktop_app(&mut usage, &mut cleanable, ctx, "Kiro", "Kiro", "Kiro");
        (usage, cleanable)
    }
}

pub struct OllamaTarget;
impl EcosystemTarget for OllamaTarget {
    fn target_id(&self) -> &'static str {
        "ollama"
    }
    fn spec(&self, ctx: &CleanerContext) -> (Vec<PathBuf>, Vec<CleanableEntry>) {
        let ollama = ctx.home_dir.join(".ollama");
        let ollama_logs = ctx.home_dir.join("Library/Logs/Ollama");
        let ollama_support = ctx.home_dir.join("Library/Application Support/Ollama");
        let mut cleanable = vec![
            entry(
                ollama.join("cache"),
                ScanCategory::Cache,
                "Ollama 模型下载与暂存缓存",
                "Ollama model download and staging cache",
                ItemStatus::Active,
            ),
            entry(
                ollama_logs.clone(),
                ScanCategory::Log,
                "Ollama macOS 系统运行日志",
                "Ollama macOS Library logs",
                ItemStatus::Active,
            ),
        ];
        push_desktop_caches(&mut cleanable, &ollama_support, "Ollama", "Ollama");
        let mut usage = vec![ollama, ollama_logs, ollama_support];
        push_platform_desktop_app(
            &mut usage,
            &mut cleanable,
            ctx,
            "Ollama",
            "Ollama",
            "Ollama",
        );
        (usage, cleanable)
    }
}

pub struct AiderTarget;
impl EcosystemTarget for AiderTarget {
    fn target_id(&self) -> &'static str {
        "aider"
    }
    fn spec(&self, ctx: &CleanerContext) -> (Vec<PathBuf>, Vec<CleanableEntry>) {
        let aider = ctx.home_dir.join(".aider");
        let cleanable = vec![entry(
            aider.join("caches"),
            ScanCategory::Cache,
            "Aider 仓库标签与 AST 索引缓存",
            "Aider repository tags and AST cache",
            ItemStatus::Active,
        )];
        (vec![aider], cleanable)
    }
}

pub struct CursorTarget;
impl EcosystemTarget for CursorTarget {
    fn target_id(&self) -> &'static str {
        "cursor"
    }
    fn spec(&self, ctx: &CleanerContext) -> (Vec<PathBuf>, Vec<CleanableEntry>) {
        let cursor = ctx.home_dir.join(".cursor");
        let cursor_support = ctx.home_dir.join("Library/Application Support/Cursor");
        let mut cleanable = vec![
            entry(
                cursor.join("ai-tracking"),
                ScanCategory::Log,
                "Cursor 本地 AI 追踪日志",
                "Cursor local AI tracking logs",
                ItemStatus::Active,
            ),
            entry(
                cursor.join("projects"),
                ScanCategory::Cache,
                "Cursor 项目级 Agent 缓存",
                "Cursor per-project agent cache",
                ItemStatus::Active,
            ),
        ];
        push_desktop_caches(&mut cleanable, &cursor_support, "Cursor IDE", "Cursor IDE");
        let mut usage = vec![cursor, cursor_support];
        push_platform_desktop_app(
            &mut usage,
            &mut cleanable,
            ctx,
            "Cursor",
            "Cursor IDE",
            "Cursor IDE",
        );
        (usage, cleanable)
    }
}

pub struct WindsurfTarget;
impl EcosystemTarget for WindsurfTarget {
    fn target_id(&self) -> &'static str {
        "windsurf"
    }
    fn spec(&self, ctx: &CleanerContext) -> (Vec<PathBuf>, Vec<CleanableEntry>) {
        let windsurf = ctx.home_dir.join(".windsurf");
        let codeium = ctx.home_dir.join(".codeium");
        let ws_codeium = codeium.join("windsurf");
        let ws_support = ctx.home_dir.join("Library/Application Support/Windsurf");
        let mut cleanable = vec![
            entry(
                windsurf.join("logs"),
                ScanCategory::Log,
                "Windsurf 运行日志",
                "Windsurf runtime logs",
                ItemStatus::Active,
            ),
            entry(
                windsurf.join("tmp"),
                ScanCategory::Tmp,
                "Windsurf 临时文件",
                "Windsurf temporary files",
                ItemStatus::Active,
            ),
            entry(
                ws_codeium.join("logs"),
                ScanCategory::Log,
                "Codeium / Windsurf 引擎日志",
                "Codeium / Windsurf engine logs",
                ItemStatus::Active,
            ),
            entry(
                ws_codeium.join("cache"),
                ScanCategory::Cache,
                "Codeium / Windsurf 缓存",
                "Codeium / Windsurf cache",
                ItemStatus::Active,
            ),
        ];
        push_desktop_caches(&mut cleanable, &ws_support, "Windsurf", "Windsurf");
        let mut usage = vec![windsurf, codeium, ws_support];
        push_platform_desktop_app(
            &mut usage,
            &mut cleanable,
            ctx,
            "Windsurf",
            "Windsurf",
            "Windsurf",
        );
        (usage, cleanable)
    }
}

pub struct TraeTarget;
impl EcosystemTarget for TraeTarget {
    fn target_id(&self) -> &'static str {
        "trae"
    }
    fn spec(&self, ctx: &CleanerContext) -> (Vec<PathBuf>, Vec<CleanableEntry>) {
        let trae = ctx.home_dir.join(".trae");
        let trae_cn = ctx.home_dir.join(".trae-cn");
        let support = ctx.home_dir.join("Library/Application Support");
        let caches = ctx.home_dir.join("Library/Caches");
        let trae_support = support.join("Trae");
        let trae_cn_support = support.join("Trae CN");
        let trae_cache = caches.join("Trae");
        let trae_cn_cache = caches.join("Trae CN");
        let mut cleanable = vec![
            entry(
                trae_cache.clone(),
                ScanCategory::Cache,
                "Trae macOS 应用缓存",
                "Trae macOS Caches",
                ItemStatus::Active,
            ),
            entry(
                trae_cn_cache.clone(),
                ScanCategory::Cache,
                "Trae CN macOS 应用缓存",
                "Trae CN macOS Caches",
                ItemStatus::Active,
            ),
        ];
        for (root, label) in [(&trae, "Trae"), (&trae_cn, "Trae CN")] {
            for (sub, cat, zh_kind, en_kind) in [
                ("logs", ScanCategory::Log, "运行日志", "runtime logs"),
                ("tmp", ScanCategory::Tmp, "临时文件", "temporary files"),
                ("cache", ScanCategory::Cache, "本地缓存", "local cache"),
            ] {
                cleanable.push(entry(
                    root.join(sub),
                    cat,
                    format!("{label} {zh_kind}"),
                    format!("{label} {en_kind}"),
                    ItemStatus::Active,
                ));
            }
        }
        push_desktop_caches(&mut cleanable, &trae_support, "Trae", "Trae");
        push_desktop_caches(&mut cleanable, &trae_cn_support, "Trae CN", "Trae CN");
        let mut usage = vec![
            trae,
            trae_cn,
            trae_support,
            trae_cn_support,
            trae_cache,
            trae_cn_cache,
        ];
        push_platform_desktop_app(&mut usage, &mut cleanable, ctx, "Trae", "Trae", "Trae");
        push_platform_desktop_app(
            &mut usage,
            &mut cleanable,
            ctx,
            "Trae CN",
            "Trae CN",
            "Trae CN",
        );
        (usage, cleanable)
    }
}

pub struct CodeBuddyTarget;
impl EcosystemTarget for CodeBuddyTarget {
    fn target_id(&self) -> &'static str {
        "codebuddy"
    }
    fn spec(&self, ctx: &CleanerContext) -> (Vec<PathBuf>, Vec<CleanableEntry>) {
        let cb = ctx.home_dir.join(".codebuddy");
        let cb_ext = ctx
            .home_dir
            .join("Library/Application Support/CodeBuddyExtension");
        let mut cleanable = vec![
            entry(
                cb.join("logs"),
                ScanCategory::Log,
                "CodeBuddy 运行日志",
                "CodeBuddy runtime logs",
                ItemStatus::Active,
            ),
            entry(
                cb.join("diagnostics"),
                ScanCategory::Log,
                "CodeBuddy 诊断日志",
                "CodeBuddy diagnostics logs",
                ItemStatus::Active,
            ),
            entry(
                cb.join("tmp"),
                ScanCategory::Tmp,
                "CodeBuddy 临时文件",
                "CodeBuddy temporary files",
                ItemStatus::Active,
            ),
        ];
        push_desktop_caches(&mut cleanable, &cb_ext, "CodeBuddy", "CodeBuddy");
        let mut usage = vec![cb, cb_ext];
        push_platform_desktop_app(
            &mut usage,
            &mut cleanable,
            ctx,
            "CodeBuddyExtension",
            "CodeBuddy",
            "CodeBuddy",
        );
        (usage, cleanable)
    }
}

pub struct ZCodeTarget;
impl EcosystemTarget for ZCodeTarget {
    fn target_id(&self) -> &'static str {
        "zcode"
    }
    fn spec(&self, ctx: &CleanerContext) -> (Vec<PathBuf>, Vec<CleanableEntry>) {
        let zcode = ctx.home_dir.join(".zcode");
        let v2 = zcode.join("v2");
        let cli = zcode.join("cli");
        let support = ctx.home_dir.join("Library/Application Support/ZCode");
        let caches = ctx.home_dir.join("Library/Caches");
        let upd = caches.join("@zcodedesktop-updater");
        let app_cache = caches.join("dev.zcode.app");
        let shipit = caches.join("dev.zcode.app.ShipIt");

        let mut cleanable = vec![
            entry(
                zcode.join("tmp"),
                ScanCategory::Tmp,
                "ZCode 临时文件目录",
                "ZCode temporary directory",
                ItemStatus::Active,
            ),
            entry(
                zcode.join("backup"),
                ScanCategory::Backup,
                "ZCode 历史备份目录",
                "ZCode historical backups",
                ItemStatus::Cold,
            ),
            entry(
                v2.join("cache"),
                ScanCategory::Cache,
                "ZCode v2 运行时缓存",
                "ZCode v2 runtime cache",
                ItemStatus::Active,
            ),
            entry(
                v2.join("logs"),
                ScanCategory::Log,
                "ZCode v2 运行日志",
                "ZCode v2 runtime logs",
                ItemStatus::Active,
            ),
            entry(
                v2.join("crash"),
                ScanCategory::Tmp,
                "ZCode v2 崩溃转储文件",
                "ZCode v2 crash dumps",
                ItemStatus::Cold,
            ),
            entry(
                v2.join("visualizations"),
                ScanCategory::Cache,
                "ZCode 可视化产物缓存",
                "ZCode visualization artifacts",
                ItemStatus::Active,
            ),
            entry(
                cli.join("log"),
                ScanCategory::Log,
                "ZCode CLI 运行日志 (log)",
                "ZCode CLI runtime logs (log)",
                ItemStatus::Active,
            ),
            entry(
                cli.join("logs"),
                ScanCategory::Log,
                "ZCode CLI 运行日志 (logs)",
                "ZCode CLI runtime logs (logs)",
                ItemStatus::Active,
            ),
            entry(
                cli.join("rollout"),
                ScanCategory::Log,
                "ZCode CLI 会话滚动日志",
                "ZCode CLI rollout session logs",
                ItemStatus::Active,
            ),
            entry(
                cli.join("artifacts"),
                ScanCategory::Cache,
                "ZCode CLI 产物缓存",
                "ZCode CLI artifact cache",
                ItemStatus::Active,
            ),
            entry(
                cli.join("cache"),
                ScanCategory::Cache,
                "ZCode CLI 运行时缓存",
                "ZCode CLI runtime cache",
                ItemStatus::Active,
            ),
            entry(
                cli.join("tmp"),
                ScanCategory::Tmp,
                "ZCode CLI 临时文件",
                "ZCode CLI temporary files",
                ItemStatus::Active,
            ),
            entry(
                upd.clone(),
                ScanCategory::Updater,
                "ZCode 自动更新安装包缓存",
                "ZCode desktop updater cache",
                ItemStatus::Cold,
            ),
            entry(
                app_cache.clone(),
                ScanCategory::Cache,
                "ZCode macOS 应用缓存",
                "ZCode macOS Caches",
                ItemStatus::Active,
            ),
            entry(
                shipit.clone(),
                ScanCategory::Updater,
                "ZCode ShipIt 更新安装包残留",
                "ZCode ShipIt updater cache",
                ItemStatus::Cold,
            ),
        ];
        push_desktop_caches(&mut cleanable, &support, "ZCode", "ZCode");
        let mut usage = vec![zcode, support, upd, app_cache, shipit];
        push_platform_desktop_app(&mut usage, &mut cleanable, ctx, "ZCode", "ZCode", "ZCode");
        (usage, cleanable)
    }
}

pub struct DevinTarget;
impl EcosystemTarget for DevinTarget {
    fn target_id(&self) -> &'static str {
        "devin"
    }
    fn spec(&self, ctx: &CleanerContext) -> (Vec<PathBuf>, Vec<CleanableEntry>) {
        let devin = ctx.home_dir.join(".devin");
        let devin_shared = ctx.home_dir.join(".devin-shared");
        let support = ctx.home_dir.join("Library/Application Support/Devin");
        let devin_cache = ctx.home_dir.join(".cache/devin");
        let devin_share = ctx.home_dir.join(".local/share/devin");
        let devin_config = ctx.home_dir.join(".config/devin");
        let mut cleanable = vec![
            entry(
                devin_cache.clone(),
                ScanCategory::Cache,
                "Devin XDG 缓存目录",
                "Devin XDG cache directory",
                ItemStatus::Active,
            ),
            entry(
                devin_share.join("logs"),
                ScanCategory::Log,
                "Devin 本地运行日志",
                "Devin local share logs",
                ItemStatus::Active,
            ),
        ];
        for (root, label) in [(&devin, "Devin"), (&devin_shared, "Devin Shared")] {
            for (sub, cat, zh_kind, en_kind) in [
                ("logs", ScanCategory::Log, "运行日志", "runtime logs"),
                ("tmp", ScanCategory::Tmp, "临时文件", "temporary files"),
                ("cache", ScanCategory::Cache, "本地缓存", "local cache"),
            ] {
                cleanable.push(entry(
                    root.join(sub),
                    cat,
                    format!("{label} {zh_kind}"),
                    format!("{label} {en_kind}"),
                    ItemStatus::Active,
                ));
            }
        }
        push_desktop_caches(&mut cleanable, &support, "Devin", "Devin");
        let mut usage = vec![
            devin,
            devin_shared,
            support,
            devin_cache,
            devin_share,
            devin_config,
        ];
        push_platform_desktop_app(&mut usage, &mut cleanable, ctx, "Devin", "Devin", "Devin");
        (usage, cleanable)
    }
}

pub struct ContinueTarget;
impl EcosystemTarget for ContinueTarget {
    fn target_id(&self) -> &'static str {
        "continue"
    }
    fn spec(&self, ctx: &CleanerContext) -> (Vec<PathBuf>, Vec<CleanableEntry>) {
        let cont = ctx.home_dir.join(".continue");
        let cleanable = vec![
            entry(
                cont.join("logs"),
                ScanCategory::Log,
                "Continue 运行日志",
                "Continue runtime logs",
                ItemStatus::Active,
            ),
            entry(
                cont.join("cache"),
                ScanCategory::Cache,
                "Continue 缓存",
                "Continue cache",
                ItemStatus::Active,
            ),
            entry(
                cont.join("index"),
                ScanCategory::Cache,
                "Continue 代码索引缓存",
                "Continue code index cache",
                ItemStatus::Active,
            ),
            entry(
                cont.join("dev_data"),
                ScanCategory::Log,
                "Continue 遥测与开发数据",
                "Continue dev/telemetry data",
                ItemStatus::Active,
            ),
        ];
        (vec![cont], cleanable)
    }
}

pub struct CopilotTarget;
impl EcosystemTarget for CopilotTarget {
    fn target_id(&self) -> &'static str {
        "copilot"
    }
    fn spec(&self, ctx: &CleanerContext) -> (Vec<PathBuf>, Vec<CleanableEntry>) {
        let copilot = ctx.home_dir.join(".copilot");
        let cleanable = vec![
            entry(
                copilot.join("logs"),
                ScanCategory::Log,
                "GitHub Copilot CLI 运行日志",
                "GitHub Copilot CLI logs",
                ItemStatus::Active,
            ),
            entry(
                copilot.join("cache"),
                ScanCategory::Cache,
                "GitHub Copilot CLI 缓存",
                "GitHub Copilot CLI cache",
                ItemStatus::Active,
            ),
            entry(
                copilot.join("tmp"),
                ScanCategory::Tmp,
                "GitHub Copilot CLI 临时文件",
                "GitHub Copilot CLI temporary files",
                ItemStatus::Active,
            ),
        ];
        (vec![copilot], cleanable)
    }
}

pub struct ZedTarget;
impl EcosystemTarget for ZedTarget {
    fn target_id(&self) -> &'static str {
        "zed"
    }
    fn spec(&self, ctx: &CleanerContext) -> (Vec<PathBuf>, Vec<CleanableEntry>) {
        let support = ctx.home_dir.join("Library/Application Support/Zed");
        let cache = ctx.home_dir.join("Library/Caches/Zed");
        let zed_logs = ctx.home_dir.join("Library/Logs/Zed");
        let zed_config = ctx.home_dir.join(".config/zed");
        let mut cleanable = vec![
            entry(
                support.join("logs"),
                ScanCategory::Log,
                "Zed 编辑器与 AI Agent 日志",
                "Zed editor & AI agent logs",
                ItemStatus::Active,
            ),
            entry(
                zed_logs.clone(),
                ScanCategory::Log,
                "Zed macOS 系统运行日志",
                "Zed macOS Library logs",
                ItemStatus::Active,
            ),
            entry(
                cache.clone(),
                ScanCategory::Cache,
                "Zed macOS 应用缓存",
                "Zed macOS Caches",
                ItemStatus::Active,
            ),
        ];
        let mut usage = vec![support, cache, zed_logs, zed_config];
        for extra_support in platform_support_dirs(ctx, "Zed") {
            cleanable.push(entry(
                extra_support.join("logs"),
                ScanCategory::Log,
                "Zed 编辑器与 AI Agent 日志",
                "Zed editor & AI agent logs",
                ItemStatus::Active,
            ));
            usage.push(extra_support);
        }
        for extra_cache in platform_cache_dirs(ctx, "Zed") {
            cleanable.push(entry(
                extra_cache.clone(),
                ScanCategory::Cache,
                "Zed 应用缓存",
                "Zed application cache",
                ItemStatus::Active,
            ));
            usage.push(extra_cache);
        }
        (usage, cleanable)
    }
}
