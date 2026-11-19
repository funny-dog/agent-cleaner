use super::AgentTarget;
use crate::fs_safe::{get_dir_size, get_file_size, safe_atime_ms, safe_mtime_ms};
use crate::recommendation::make_item;
use crate::types::{
    CleanerContext, ColdCacheEntry, ItemStatus, Language, ScanCategory, ScanItem, ScanResult,
};
use std::fs;
use std::path::{Path, PathBuf};

pub const COLD_THRESHOLD_DAYS: u64 = 14;
const MS_PER_DAY: u64 = 86_400_000;

pub struct ColdCacheTarget;

pub(crate) struct ColdCacheFinding {
    pub source: String,
    pub label: String,
    pub path: PathBuf,
    pub size_bytes: u64,
    pub atime_ms: u64,
    pub age_days: u64,
}

fn entry_size(path: &Path) -> u64 {
    if path.is_dir() {
        get_dir_size(path)
    } else {
        get_file_size(path)
    }
}

fn is_uv_bucket_dir(name: &str) -> bool {
    let Some((_, ver)) = name.rsplit_once("-v") else {
        return false;
    };
    !ver.is_empty() && ver.bytes().all(|b| b.is_ascii_digit())
}

fn maybe_push_cold_entry(
    path: &Path,
    source: &str,
    label: String,
    out: &mut Vec<ColdCacheFinding>,
    now_ms: u64,
) {
    let atime_ms = safe_atime_ms(path, now_ms);
    let age_days = now_ms.saturating_sub(atime_ms) / MS_PER_DAY;
    if age_days >= COLD_THRESHOLD_DAYS {
        let size_bytes = entry_size(path);
        if size_bytes > 0 {
            out.push(ColdCacheFinding {
                source: source.to_string(),
                label,
                path: path.to_path_buf(),
                size_bytes,
                atime_ms,
                age_days,
            });
        }
    }
}

fn scan_flat_cold_dir(dir: &Path, source: &str, out: &mut Vec<ColdCacheFinding>, now_ms: u64) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".DS_Store" {
            continue;
        }
        maybe_push_cold_entry(&entry.path(), source, name, out, now_ms);
    }
}

fn scan_uv_cold_dir(
    uv_dir: &Path,
    out: &mut Vec<ColdCacheFinding>,
    tmp_out: Option<&mut Vec<(PathBuf, String, u64, u64)>>,
    now_ms: u64,
) {
    let Ok(entries) = fs::read_dir(uv_dir) else {
        return;
    };
    let mut tmp_out = tmp_out;
    for entry in entries.flatten() {
        let full_path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".DS_Store" || name == ".gitignore" || name == ".lock" || name == "CACHEDIR.TAG" {
            continue;
        }
        if name.starts_with(".tmp") {
            if let Some(ref mut tmps) = tmp_out {
                let size = entry_size(&full_path);
                if size > 0 {
                    let mtime_ms = safe_mtime_ms(&full_path, now_ms);
                    tmps.push((full_path, name, size, mtime_ms));
                }
            }
            continue;
        }

        let is_real_dir = entry
            .file_type()
            .map(|ft| ft.is_dir() && !ft.is_symlink())
            .unwrap_or(false);
        if is_real_dir && is_uv_bucket_dir(&name) {
            if let Ok(bucket_entries) = fs::read_dir(&full_path) {
                for sub in bucket_entries.flatten() {
                    let sub_name = sub.file_name().to_string_lossy().to_string();
                    if sub_name == ".DS_Store" {
                        continue;
                    }
                    maybe_push_cold_entry(
                        &sub.path(),
                        "uv",
                        format!("{name}/{sub_name}"),
                        out,
                        now_ms,
                    );
                }
            }
        } else {
            maybe_push_cold_entry(&full_path, "uv", name, out, now_ms);
        }
    }
}

fn scan_puppeteer_cold_dir(dir: &Path, out: &mut Vec<ColdCacheFinding>, now_ms: u64) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let full_path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".DS_Store" {
            continue;
        }
        let is_real_dir = entry
            .file_type()
            .map(|ft| ft.is_dir() && !ft.is_symlink())
            .unwrap_or(false);
        if is_real_dir {
            let mut has_children = false;
            if let Ok(sub_entries) = fs::read_dir(&full_path) {
                for sub in sub_entries.flatten() {
                    let sub_name = sub.file_name().to_string_lossy().to_string();
                    if sub_name == ".DS_Store" {
                        continue;
                    }
                    has_children = true;
                    maybe_push_cold_entry(
                        &sub.path(),
                        "puppeteer",
                        format!("{name}/{sub_name}"),
                        out,
                        now_ms,
                    );
                }
            }
            if !has_children {
                maybe_push_cold_entry(&full_path, "puppeteer", name, out, now_ms);
            }
        } else {
            maybe_push_cold_entry(&full_path, "puppeteer", name, out, now_ms);
        }
    }
}

pub(crate) fn collect_cold_caches(ctx: &CleanerContext) -> Vec<ColdCacheEntry> {
    let now = ctx.now();
    let mut findings = Vec::new();
    scan_flat_cold_dir(&ctx.home_dir.join(".npm/_npx"), "npm/_npx", &mut findings, now);
    scan_uv_cold_dir(&ctx.home_dir.join(".cache/uv"), &mut findings, None, now);
    scan_flat_cold_dir(
        &ctx.home_dir.join("Library/Caches/pnpm/dlx"),
        "pnpm/dlx",
        &mut findings,
        now,
    );
    scan_flat_cold_dir(
        &ctx.home_dir.join(".cache/pnpm/dlx"),
        "pnpm/dlx",
        &mut findings,
        now,
    );
    scan_puppeteer_cold_dir(&ctx.home_dir.join(".cache/puppeteer"), &mut findings, now);
    scan_flat_cold_dir(
        &ctx.home_dir.join("Library/Caches/ms-playwright"),
        "ms-playwright",
        &mut findings,
        now,
    );

    findings
        .into_iter()
        .map(|f| ColdCacheEntry {
            source: f.source,
            path: f.path.to_string_lossy().to_string(),
            size_bytes: f.size_bytes,
            last_access_days: f.age_days,
        })
        .collect()
}

impl AgentTarget for ColdCacheTarget {
    fn id(&self) -> &'static str {
        "pkg-cache"
    }

    fn claimed_dirs(&self, ctx: &CleanerContext) -> Vec<PathBuf> {
        vec![
            ctx.home_dir.join(".npm/_npx"),
            ctx.home_dir.join(".cache/uv"),
            ctx.home_dir.join("Library/Caches/pnpm/dlx"),
            ctx.home_dir.join(".cache/pnpm/dlx"),
            ctx.home_dir.join(".cache/puppeteer"),
            ctx.home_dir.join("Library/Caches/ms-playwright"),
        ]
    }

    fn scan(&self, ctx: &CleanerContext, exempt_hours: u64, lang: Language) -> ScanResult {
        let now_ms = ctx.now();
        let mut items: Vec<ScanItem> = Vec::new();
        let npx_dir = ctx.home_dir.join(".npm/_npx");
        let uv_dir = ctx.home_dir.join(".cache/uv");
        let pnpm_dlx_lib = ctx.home_dir.join("Library/Caches/pnpm/dlx");
        let pnpm_dlx_xdg = ctx.home_dir.join(".cache/pnpm/dlx");
        let puppeteer_dir = ctx.home_dir.join(".cache/puppeteer");
        let playwright_dir = ctx.home_dir.join("Library/Caches/ms-playwright");

        let mut findings = Vec::new();
        let mut uv_tmps = Vec::new();

        scan_flat_cold_dir(&npx_dir, "npm/_npx", &mut findings, now_ms);
        scan_uv_cold_dir(&uv_dir, &mut findings, Some(&mut uv_tmps), now_ms);
        scan_flat_cold_dir(&pnpm_dlx_lib, "pnpm/dlx", &mut findings, now_ms);
        scan_flat_cold_dir(&pnpm_dlx_xdg, "pnpm/dlx", &mut findings, now_ms);
        scan_puppeteer_cold_dir(&puppeteer_dir, &mut findings, now_ms);
        scan_flat_cold_dir(&playwright_dir, "ms-playwright", &mut findings, now_ms);

        for f in findings {
            let desc = match lang {
                Language::Zh => format!("{} 冷缓存 ({} 天未访问): {}", f.source, f.age_days, f.label),
                Language::En => format!("Cold {} cache ({}d unused): {}", f.source, f.age_days, f.label),
            };
            items.push(make_item(
                "pkg-cache",
                ScanCategory::ColdCache,
                f.path.to_string_lossy().to_string(),
                f.size_bytes,
                f.atime_ms,
                desc,
                ItemStatus::Cold,
                exempt_hours,
                now_ms,
                lang,
            ));
        }

        for (tmp_path, name, size, mtime_ms) in uv_tmps {
            let desc = match lang {
                Language::Zh => format!("uv 安装中断残留临时目录: {name}"),
                Language::En => format!("Stale uv temporary directory: {name}"),
            };
            items.push(make_item(
                "pkg-cache",
                ScanCategory::Tmp,
                tmp_path.to_string_lossy().to_string(),
                size,
                mtime_ms,
                desc,
                ItemStatus::Orphan,
                exempt_hours,
                now_ms,
                lang,
            ));
        }

        let disk_usage_bytes = get_dir_size(&npx_dir)
            + get_dir_size(&uv_dir)
            + get_dir_size(&pnpm_dlx_lib)
            + get_dir_size(&pnpm_dlx_xdg)
            + get_dir_size(&puppeteer_dir)
            + get_dir_size(&playwright_dir);
        let total_bytes = items.iter().map(|i| i.size_bytes).sum();

        ScanResult {
            agent: "pkg-cache".to_string(),
            items,
            total_bytes,
            disk_usage_bytes,
            scanned_at: now_ms,
        }
    }
}
