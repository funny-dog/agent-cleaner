use anyhow::{bail, Context, Result};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Ensure `target` is strictly contained within `allowed_root` to prevent path traversal.
pub fn assert_safe_child(allowed_root: &Path, target: &Path) -> Result<()> {
    let norm_root = normalize_lexical(allowed_root);
    let norm_target = normalize_lexical(target);
    if !norm_target.starts_with(&norm_root) || norm_target == norm_root {
        bail!(
            "Path traversal detected: {:?} is not strictly inside {:?}",
            norm_target,
            norm_root
        );
    }
    Ok(())
}

fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            c => out.push(c.as_os_str()),
        }
    }
    out
}

/// Detect whether a path resides on an external mount (/Volumes/* or /mnt/*).
pub fn extract_external_mountpoint(path: &Path) -> Option<PathBuf> {
    let s = path.to_string_lossy();
    for prefix in ["/Volumes/", "/mnt/"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            if let Some(vol) = rest.split('/').next().filter(|v| !v.is_empty()) {
                return Some(PathBuf::from(format!("{prefix}{vol}")));
            }
        }
    }
    None
}

/// Check whether a mountpoint exists and is stat-accessible.
pub fn is_mountpoint_accessible(mountpoint: &Path) -> bool {
    fs::metadata(mountpoint).is_ok()
}

/// Deterministic single-threaded directory traversal per target (avoids macOS EMFILE when
/// outer scanner runs targets in parallel). Adjusts sparse files (>16MB) to physical disk blocks.
pub fn get_dir_size(dir: &Path) -> u64 {
    if !dir.exists() {
        return 0;
    }
    if dir.is_file() {
        return get_file_size(dir);
    }

    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            let p = entry.path();
            if ft.is_symlink() {
                total += fs::symlink_metadata(&p).map(|m| m.len()).unwrap_or(0);
            } else if ft.is_dir() {
                stack.push(p);
            } else {
                total += physical_or_logical_size(&p);
            }
        }
    }
    total
}

fn physical_or_logical_size(path: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return 0;
    };
    let logical = meta.len();
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // For sparse files (e.g. VM disk images), report actual allocated blocks on disk.
        let physical = meta.blocks().saturating_mul(512);
        if logical > 16 * 1024 * 1024 && physical < logical {
            return physical;
        }
    }
    logical
}

pub fn get_file_size(path: &Path) -> u64 {
    fs::symlink_metadata(path).map(|m| m.len()).unwrap_or(0)
}

pub fn safe_mtime_ms(path: &Path, fallback_ms: u64) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(fallback_ms)
}

pub fn safe_atime_ms(path: &Path, fallback_ms: u64) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.accessed())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or_else(|| safe_mtime_ms(path, fallback_ms))
}

/// Safely move a file or directory across partitions: rename first, falling back to
/// recursive copy + verify + delete when EXDEV occurs.
pub fn safe_move(src: &Path, dest: &Path) -> Result<()> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create parent dir {:?}", parent))?;
    }

    match fs::rename(src, dest) {
        Ok(()) => Ok(()),
        Err(err) if is_cross_device_error(&err) => {
            copy_recursive(src, dest)?;
            if !dest.exists() {
                bail!("cross-device copy verification failed for {:?}", dest);
            }
            remove_path(src)?;
            Ok(())
        }
        Err(err) => Err(err).with_context(|| format!("failed to move {:?} -> {:?}", src, dest)),
    }
}

fn is_cross_device_error(err: &std::io::Error) -> bool {
    // EXDEV is errno 18 on macOS/Linux; raw_os_error check avoids extra platform crate imports.
    matches!(err.raw_os_error(), Some(18))
        || err.kind() == std::io::ErrorKind::CrossesDevices
}

pub fn copy_recursive(src: &Path, dest: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(src)
        .with_context(|| format!("failed to stat source {:?}", src))?;
    if meta.is_dir() {
        fs::create_dir_all(dest)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            let child_src = entry.path();
            let child_dest = dest.join(entry.file_name());
            copy_recursive(&child_src, &child_dest)?;
        }
    } else if meta.file_type().is_symlink() {
        let target = fs::read_link(src)?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, dest)?;
        #[cfg(windows)]
        {
            let _ = target;
            fs::copy(src, dest)?;
        }
    } else {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dest)?;
    }
    Ok(())
}

pub fn remove_path(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.is_dir() {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
    Ok(())
}
