use super::{push_dir_item, AgentTarget};
use crate::fs_safe::{get_dir_size, safe_mtime_ms};
use crate::recommendation::make_item;
use crate::types::{CleanerContext, ItemStatus, Language, ScanCategory, ScanItem, ScanResult};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

pub struct DshTarget;

fn read_declared_deps(package_json: &Path, node_modules_dir: &Path) -> HashSet<String> {
    let mut deps = HashSet::new();
    if let Ok(raw) = fs::read_to_string(package_json) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
            for key in ["dependencies", "devDependencies", "peerDependencies"] {
                if let Some(obj) = val.get(key).and_then(|v| v.as_object()) {
                    for name in obj.keys() {
                        deps.insert(name.clone());
                    }
                }
            }
        }
    }

    // Also respect pnpm's hoistedDependencies recorded in node_modules/.modules.yaml
    if let Ok(raw_yaml) = fs::read_to_string(node_modules_dir.join(".modules.yaml")) {
        if let Ok(yaml_val) = serde_yml::from_str::<serde_json::Value>(&raw_yaml) {
            for section in ["hoistedDependencies", "dependencies"] {
                if let Some(obj) = yaml_val.get(section).and_then(|v| v.as_object()) {
                    for key in obj.keys() {
                        // Keys look like "/pkg/1.0.0" or "/@scope/pkg/1.0.0" or "pkg"
                        let trimmed = key.trim_start_matches('/');
                        let pkg_name = if let Some(rest) = trimmed.strip_prefix('@') {
                            let mut parts = rest.splitn(3, '/');
                            match (parts.next(), parts.next()) {
                                (Some(scope), Some(name)) => format!("@{scope}/{name}"),
                                _ => continue,
                            }
                        } else {
                            trimmed.split('/').next().unwrap_or("").to_string()
                        };
                        if !pkg_name.is_empty() {
                            deps.insert(pkg_name);
                        }
                    }
                }
            }
        }
    }
    deps
}

fn collect_actual_modules(node_modules_dir: &Path) -> Vec<String> {
    let mut modules = Vec::new();
    let Ok(entries) = fs::read_dir(node_modules_dir) else {
        return modules;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if !ft.is_dir() || ft.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if name.starts_with('@') {
            if let Ok(scoped) = fs::read_dir(entry.path()) {
                for sub in scoped.flatten() {
                    if sub
                        .file_type()
                        .map(|t| t.is_dir() && !t.is_symlink())
                        .unwrap_or(false)
                    {
                        modules.push(format!("{name}/{}", sub.file_name().to_string_lossy()));
                    }
                }
            }
        } else {
            modules.push(name);
        }
    }
    modules
}

impl AgentTarget for DshTarget {
    fn id(&self) -> &'static str {
        "dsh"
    }

    fn claimed_dirs(&self, ctx: &CleanerContext) -> Vec<PathBuf> {
        vec![
            ctx.home_dir.join(".dsh"),
            ctx.home_dir.join("Library/Application Support/@deepseek-ai"),
            ctx.home_dir.join("Library/Application Support/com.deepseek.dsh"),
            ctx.home_dir.join("Library/Caches/@deepseek-aidsh-desktop-updater"),
            ctx.home_dir.join("Library/Caches/com.deepseek.dsh"),
            ctx.home_dir.join("Library/Caches/com.deepseek.dsh.ShipIt"),
        ]
    }

    fn scan(&self, ctx: &CleanerContext, exempt_hours: u64, lang: Language) -> ScanResult {
        let now_ms = ctx.now();
        let dsh_dir = ctx.home_dir.join(".dsh");
        let profiles_dir = dsh_dir.join("profiles");
        let mut items: Vec<ScanItem> = Vec::new();

        if let Ok(profiles) = fs::read_dir(&profiles_dir) {
            for entry in profiles.flatten() {
                let profile_dir = entry.path();
                if !profile_dir.is_dir() {
                    continue;
                }
                let node_modules = profile_dir.join("node_modules");
                if !node_modules.exists() {
                    continue;
                }
                let profile_name = entry.file_name().to_string_lossy().to_string();
                let declared = read_declared_deps(&profile_dir.join("package.json"), &node_modules);
                for module_name in collect_actual_modules(&node_modules) {
                    if declared.contains(&module_name) {
                        continue;
                    }
                    let module_path = node_modules.join(&module_name);
                    let size = get_dir_size(&module_path);
                    let mtime = safe_mtime_ms(&module_path, now_ms);
                    let desc = match lang {
                        Language::Zh => format!(
                            "DSH 配置 \"{profile_name}\" 中未声明的残留包: {module_name} (可能是安装中断残留)"
                        ),
                        Language::En => format!(
                            "Undeclared module in profile \"{profile_name}\": {module_name} (interrupted install residue)"
                        ),
                    };
                    items.push(make_item(
                        "dsh",
                        ScanCategory::NodeModules,
                        module_path.to_string_lossy().to_string(),
                        size,
                        mtime,
                        desc,
                        ItemStatus::Orphan,
                        exempt_hours,
                        now_ms,
                        lang,
                    ));
                }
            }
        }

        let updater_dir = ctx
            .home_dir
            .join("Library/Caches/@deepseek-aidsh-desktop-updater");
        let app_cache_dir = ctx.home_dir.join("Library/Caches/com.deepseek.dsh");
        let shipit_dir = ctx.home_dir.join("Library/Caches/com.deepseek.dsh.ShipIt");
        let app_support_bundle = ctx
            .home_dir
            .join("Library/Application Support/com.deepseek.dsh");

        for (dir, category, zh, en, status) in [
            (
                updater_dir.clone(),
                ScanCategory::Updater,
                "DeepSeek Harness 桌面端更新安装包缓存残留",
                "DeepSeek Harness desktop auto-updater downloaded packages cache",
                ItemStatus::Cold,
            ),
            (
                shipit_dir.clone(),
                ScanCategory::Updater,
                "DeepSeek Harness ShipIt 更新安装包残留",
                "DeepSeek Harness ShipIt updater cache",
                ItemStatus::Cold,
            ),
            (
                app_cache_dir.clone(),
                ScanCategory::Cache,
                "DeepSeek Harness macOS 应用缓存",
                "DeepSeek Harness macOS Caches",
                ItemStatus::Active,
            ),
            (
                dsh_dir.join("logs"),
                ScanCategory::Log,
                "DeepSeek Harness 运行日志",
                "DeepSeek Harness runtime logs",
                ItemStatus::Active,
            ),
            (
                dsh_dir.join("cache"),
                ScanCategory::Cache,
                "DeepSeek Harness 临时缓存",
                "DeepSeek Harness temporary cache",
                ItemStatus::Active,
            ),
            (
                dsh_dir.join("backups"),
                ScanCategory::Backup,
                "DeepSeek Harness 历史配置备份",
                "DeepSeek Harness configuration backups",
                ItemStatus::Cold,
            ),
        ] {
            push_dir_item(
                &mut items,
                "dsh",
                &dir,
                category,
                lang.tr(zh, en),
                status,
                true,
                exempt_hours,
                now_ms,
                lang,
            );
        }

        let disk_usage_bytes = get_dir_size(&dsh_dir)
            + get_dir_size(&ctx.home_dir.join("Library/Application Support/@deepseek-ai"))
            + get_dir_size(&app_support_bundle)
            + get_dir_size(&app_cache_dir)
            + get_dir_size(&shipit_dir)
            + get_dir_size(&updater_dir);
        let total_bytes = items.iter().map(|i| i.size_bytes).sum();

        ScanResult {
            agent: "dsh".to_string(),
            items,
            total_bytes,
            disk_usage_bytes,
            scanned_at: now_ms,
        }
    }
}
