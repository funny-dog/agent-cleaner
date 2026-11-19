use super::{push_dir_item, AgentTarget};
use crate::fs_safe::{
    extract_external_mountpoint, get_dir_size, get_file_size, is_mountpoint_accessible,
    safe_mtime_ms,
};
use crate::recommendation::make_item;
use crate::types::{CleanerContext, ItemStatus, Language, ScanCategory, ScanItem, ScanResult};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

pub struct DshTarget;

fn extract_pkg_from_node_modules_loc(loc: &str) -> Option<String> {
    let rel = loc
        .rsplit_once("node_modules/")
        .map(|(_, tail)| tail)
        .unwrap_or(loc)
        .trim_matches('/');
    if rel.is_empty() {
        return None;
    }
    if let Some(rest) = rel.strip_prefix('@') {
        let mut parts = rest.splitn(3, '/');
        match (parts.next(), parts.next()) {
            (Some(scope), Some(name)) if !scope.is_empty() && !name.is_empty() => {
                Some(format!("@{scope}/{name}"))
            }
            _ => None,
        }
    } else {
        rel.split('/')
            .next()
            .filter(|s| !s.is_empty())
            .map(ToString::to_string)
    }
}

fn extract_pkg_from_hoisted_location_key(key: &str) -> Option<String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return None;
    }
    let pkg = if let Some(rest) = trimmed.strip_prefix('@') {
        match rest.find('@') {
            Some(idx) => &trimmed[..1 + idx],
            None => trimmed,
        }
    } else {
        match trimmed.find('@') {
            Some(idx) => &trimmed[..idx],
            None => trimmed,
        }
    };
    if pkg.is_empty() || pkg.contains("..") {
        None
    } else {
        Some(pkg.to_string())
    }
}

fn collect_pkg_json_deps(pkg_json_path: &Path, include_dev: bool, include_bundles: bool) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(raw) = fs::read_to_string(pkg_json_path) else {
        return out;
    };
    let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return out;
    };

    let sections: &[&str] = if include_dev {
        &[
            "dependencies",
            "devDependencies",
            "peerDependencies",
            "optionalDependencies",
        ]
    } else {
        &["dependencies", "peerDependencies", "optionalDependencies"]
    };

    for key in sections {
        if let Some(obj) = val.get(*key).and_then(|v| v.as_object()) {
            for name in obj.keys() {
                out.push(name.clone());
            }
        }
    }

    if include_bundles {
        if let Some(bundles) = val
            .get("dsh")
            .and_then(|d| d.get("profile"))
            .and_then(|p| p.get("bundles"))
            .and_then(|b| b.as_array())
        {
            for item in bundles {
                if let Some(name) = item.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                    out.push(name.to_string());
                }
            }
        }
    }

    out
}

fn read_declared_deps(package_json: &Path, node_modules_dir: &Path) -> HashSet<String> {
    let mut deps = HashSet::new();
    for name in collect_pkg_json_deps(package_json, true, true) {
        deps.insert(name);
    }

    // Parse pnpm `.modules.yaml` (supports both v4 hoistedDependencies/dependencies and v5 hoistedLocations/injectedDeps)
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

            for section in ["hoistedLocations", "injectedDeps"] {
                if let Some(obj) = yaml_val.get(section).and_then(|v| v.as_object()) {
                    for (key, val) in obj {
                        if let Some(arr) = val.as_array() {
                            for loc in arr {
                                if let Some(loc_str) = loc.as_str() {
                                    if let Some(pkg) = extract_pkg_from_node_modules_loc(loc_str) {
                                        deps.insert(pkg);
                                    }
                                }
                            }
                        }
                        if section == "hoistedLocations" {
                            if let Some(pkg) = extract_pkg_from_hoisted_location_key(key) {
                                deps.insert(pkg);
                            }
                        }
                    }
                }
            }
        }
    }

    // Transitive dependency closure BFS across installed packages in `node_modules`
    let mut queue: VecDeque<String> = deps.iter().cloned().collect();
    while let Some(pkg) = queue.pop_front() {
        let pkg_json = node_modules_dir.join(&pkg).join("package.json");
        for dep_name in collect_pkg_json_deps(&pkg_json, false, false) {
            if deps.insert(dep_name.clone()) {
                queue.push_back(dep_name);
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

fn encode_dsh_workspace_path(ws_path: &str) -> String {
    let trimmed = ws_path.trim_matches(['/', '\\']);
    format!("--{}--", trimmed.replace(['/', '\\'], "-"))
}

fn is_encoded_external_unmounted(dir_name: &str, known_paths: Option<&[String]>) -> bool {
    if let Some(paths) = known_paths {
        for p in paths {
            if let Some(mp) = extract_external_mountpoint(Path::new(p)) {
                if !is_mountpoint_accessible(&mp) {
                    return true;
                }
            }
        }
        return false;
    }

    for (prefix, root) in [("--Volumes-", "/Volumes"), ("--mnt-", "/mnt")] {
        if let Some(rest) = dir_name.strip_prefix(prefix) {
            if let Ok(entries) = fs::read_dir(root) {
                for entry in entries.flatten() {
                    let vol = entry.file_name().to_string_lossy().to_string();
                    if (rest == format!("{vol}--") || rest.starts_with(&format!("{vol}-")))
                        && is_mountpoint_accessible(&entry.path())
                    {
                        return false;
                    }
                }
            }
            return true;
        }
    }

    false
}

fn scan_dsh_sessions(
    dsh_dir: &Path,
    items: &mut Vec<ScanItem>,
    exempt_hours: u64,
    now_ms: u64,
    lang: Language,
) {
    let sessions_dir = dsh_dir.join("sessions");
    if !sessions_dir.is_dir() {
        return;
    }

    let mut archived_ids: HashSet<String> = HashSet::new();
    let mut encoded_workspaces: HashMap<String, Vec<String>> = HashMap::new();
    let mut all_active_sessions: HashSet<String> = HashSet::new();
    let mut has_workspaces_table = false;

    let workspace_json_path = dsh_dir.join("storages/workspace.json");
    if let Ok(raw) = fs::read_to_string(&workspace_json_path) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(arr) = val
                .get("global")
                .and_then(|g| g.get("archivedSessionIds"))
                .and_then(|v| v.as_array())
            {
                for id in arr.iter().filter_map(|v| v.as_str()) {
                    archived_ids.insert(id.to_string());
                }
            }

            if let Some(workspaces) = val
                .get("tables")
                .and_then(|t| t.get("workspaces"))
                .and_then(|w| w.as_object())
            {
                has_workspaces_table = true;
                for ws_val in workspaces.values() {
                    if let Some(ws_path) = ws_val
                        .get("path")
                        .and_then(|p| p.as_str())
                        .filter(|s| !s.is_empty())
                    {
                        let encoded = encode_dsh_workspace_path(ws_path);
                        encoded_workspaces
                            .entry(encoded)
                            .or_default()
                            .push(ws_path.to_string());
                    }
                    if let Some(sess_arr) = ws_val.get("sessionIds").and_then(|s| s.as_array()) {
                        for sid in sess_arr.iter().filter_map(|v| v.as_str()) {
                            all_active_sessions.insert(sid.to_string());
                        }
                    }
                }
            }
        }
    }

    let Ok(entries) = fs::read_dir(&sessions_dir) else {
        return;
    };

    for entry in entries.flatten() {
        let ws_session_dir = entry.path();
        if !ws_session_dir.is_dir() {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().to_string();
        let known_paths = encoded_workspaces.get(&dir_name).map(|v| v.as_slice());

        if is_encoded_external_unmounted(&dir_name, known_paths) {
            continue;
        }

        if let Some(paths) = known_paths {
            let all_missing = paths.iter().all(|p| {
                matches!(
                    fs::metadata(p),
                    Err(ref e) if e.kind() == std::io::ErrorKind::NotFound
                )
            });
            if all_missing {
                let size = get_dir_size(&ws_session_dir);
                if size > 0 {
                    let mtime = safe_mtime_ms(&ws_session_dir, now_ms);
                    let missing_label = paths.join(", ");
                    let desc = match lang {
                        Language::Zh => format!(
                            "DSH 孤儿工作区会话 — 原项目目录已不存在: {missing_label}"
                        ),
                        Language::En => format!(
                            "Orphan DSH workspace sessions — project dir missing: {missing_label}"
                        ),
                    };
                    items.push(make_item(
                        "dsh",
                        ScanCategory::OrphanSession,
                        ws_session_dir.to_string_lossy().to_string(),
                        size,
                        mtime,
                        desc,
                        ItemStatus::Orphan,
                        exempt_hours,
                        now_ms,
                        lang,
                    ));
                }
                continue;
            }

            if let Ok(sub_entries) = fs::read_dir(&ws_session_dir) {
                for sub in sub_entries.flatten() {
                    let sess_dir = sub.path();
                    if !sess_dir.is_dir() {
                        continue;
                    }
                    let sess_name = sub.file_name().to_string_lossy().to_string();
                    if sess_name.starts_with("session-") && archived_ids.contains(&sess_name) {
                        let size = get_dir_size(&sess_dir);
                        if size == 0 {
                            continue;
                        }
                        let mtime = safe_mtime_ms(&sess_dir, now_ms);
                        let desc = match lang {
                            Language::Zh => format!("DSH 已归档历史会话: {sess_name}"),
                            Language::En => format!("DSH archived session: {sess_name}"),
                        };
                        items.push(make_item(
                            "dsh",
                            ScanCategory::Archive,
                            sess_dir.to_string_lossy().to_string(),
                            size,
                            mtime,
                            desc,
                            ItemStatus::Cold,
                            exempt_hours,
                            now_ms,
                            lang,
                        ));
                    }
                }
            }
        } else if has_workspaces_table {
            let mut any_active_session = false;
            if let Ok(sub_entries) = fs::read_dir(&ws_session_dir) {
                for sub in sub_entries.flatten() {
                    if sub.path().is_dir() {
                        let sess_name = sub.file_name().to_string_lossy().to_string();
                        if all_active_sessions.contains(&sess_name) {
                            any_active_session = true;
                            break;
                        }
                    }
                }
            }
            let is_tmp_ws =
                dir_name == "--private-tmp--" || dir_name.starts_with("--private-tmp-");
            if is_tmp_ws || !any_active_session {
                let size = get_dir_size(&ws_session_dir);
                if size > 0 {
                    let mtime = safe_mtime_ms(&ws_session_dir, now_ms);
                    let desc = lang.tr(
                        "DSH 孤儿工作区会话（工作区已移除）",
                        "Orphan DSH workspace sessions (workspace removed)",
                    );
                    items.push(make_item(
                        "dsh",
                        ScanCategory::OrphanSession,
                        ws_session_dir.to_string_lossy().to_string(),
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
    }
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
            ctx.home_dir.join("Library/Logs/DeepSeek Harness"),
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
                let profile_name = entry.file_name().to_string_lossy().to_string();

                let market_desc = match lang {
                    Language::Zh => format!("DSH 配置 \"{profile_name}\" 插件市场缓存"),
                    Language::En => format!("DSH profile \"{profile_name}\" marketplace cache"),
                };
                push_dir_item(
                    &mut items,
                    "dsh",
                    &profile_dir.join(".dsh-market"),
                    ScanCategory::Cache,
                    &market_desc,
                    ItemStatus::Active,
                    true,
                    exempt_hours,
                    now_ms,
                    lang,
                );

                for bak_name in ["cordis.patch.yml.bak", "package.json.bak"] {
                    let bak_path = profile_dir.join(bak_name);
                    if bak_path.is_file() {
                        let size = get_file_size(&bak_path);
                        if size > 0 {
                            let mtime = safe_mtime_ms(&bak_path, now_ms);
                            let desc = match lang {
                                Language::Zh => {
                                    format!("DSH 配置 \"{profile_name}\" 备份文件: {bak_name}")
                                }
                                Language::En => {
                                    format!("DSH profile \"{profile_name}\" backup file: {bak_name}")
                                }
                            };
                            items.push(make_item(
                                "dsh",
                                ScanCategory::Backup,
                                bak_path.to_string_lossy().to_string(),
                                size,
                                mtime,
                                desc,
                                ItemStatus::Cold,
                                exempt_hours,
                                now_ms,
                                lang,
                            ));
                        }
                    }
                }

                let node_modules = profile_dir.join("node_modules");
                if !node_modules.exists() {
                    continue;
                }
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

        scan_dsh_sessions(&dsh_dir, &mut items, exempt_hours, now_ms, lang);

        let updater_dir = ctx
            .home_dir
            .join("Library/Caches/@deepseek-aidsh-desktop-updater");
        let app_cache_dir = ctx.home_dir.join("Library/Caches/com.deepseek.dsh");
        let shipit_dir = ctx.home_dir.join("Library/Caches/com.deepseek.dsh.ShipIt");
        let app_support_bundle = ctx
            .home_dir
            .join("Library/Application Support/com.deepseek.dsh");
        let app_support_desktop = ctx
            .home_dir
            .join("Library/Application Support/@deepseek-ai/dsh-desktop");

        for support_root in [&app_support_desktop, &app_support_bundle] {
            for (sub, category, zh, en) in [
                ("Cache", ScanCategory::Cache, "DeepSeek Harness 桌面端 HTTP 缓存", "DeepSeek Harness desktop HTTP cache"),
                ("Code Cache", ScanCategory::Cache, "DeepSeek Harness 桌面端 JS 字节码缓存", "DeepSeek Harness desktop JS code cache"),
                ("GPUCache", ScanCategory::Cache, "DeepSeek Harness 桌面端 GPU 渲染缓存", "DeepSeek Harness desktop GPU cache"),
                ("GraphiteDawnCache", ScanCategory::Cache, "DeepSeek Harness 桌面端 GraphiteDawn 图形缓存", "DeepSeek Harness desktop GraphiteDawn cache"),
                ("DawnWebGPUCache", ScanCategory::Cache, "DeepSeek Harness 桌面端 DawnWebGPU 图形缓存", "DeepSeek Harness desktop DawnWebGPU cache"),
                ("DawnGraphiteCache", ScanCategory::Cache, "DeepSeek Harness 桌面端 DawnGraphite 图形缓存", "DeepSeek Harness desktop DawnGraphite cache"),
                ("Crashpad", ScanCategory::Log, "DeepSeek Harness 桌面端崩溃转储日志", "DeepSeek Harness desktop crashpad logs"),
                ("logs", ScanCategory::Log, "DeepSeek Harness 桌面端运行日志", "DeepSeek Harness desktop runtime logs"),
            ] {
                push_dir_item(
                    &mut items,
                    "dsh",
                    &support_root.join(sub),
                    category,
                    lang.tr(zh, en),
                    ItemStatus::Active,
                    true,
                    exempt_hours,
                    now_ms,
                    lang,
                );
            }
        }

        let dsh_logs_library = ctx.home_dir.join("Library/Logs/DeepSeek Harness");

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
            (
                dsh_dir.join("storages/session_projcache"),
                ScanCategory::Cache,
                "DeepSeek Harness 会话项目索引缓存",
                "DeepSeek Harness session project cache",
                ItemStatus::Active,
            ),
            (
                dsh_dir.join("attachments"),
                ScanCategory::Archive,
                "DeepSeek Harness 历史会话附件缓存",
                "DeepSeek Harness session attachments archive",
                ItemStatus::Cold,
            ),
            (
                dsh_logs_library.clone(),
                ScanCategory::Log,
                "DeepSeek Harness macOS 系统运行日志",
                "DeepSeek Harness macOS Library logs",
                ItemStatus::Active,
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
            + get_dir_size(&updater_dir)
            + get_dir_size(&dsh_logs_library);
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
