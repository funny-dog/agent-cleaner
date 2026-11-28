use anyhow::{bail, Context, Result};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Ensure `target` is strictly contained within `allowed_root` to prevent path traversal.
pub fn assert_safe_child(allowed_root: &Path, target: &Path) -> Result<()> {
    let norm_root = normalize_lexical(allowed_root);
    let norm_target = normalize_lexical(target);
    #[cfg(windows)]
    {
        let root_str = norm_root
            .to_string_lossy()
            .replace('\\', "/")
            .to_ascii_lowercase();
        let target_str = norm_target
            .to_string_lossy()
            .replace('\\', "/")
            .to_ascii_lowercase();
        let prefix = if root_str.ends_with('/') {
            root_str.clone()
        } else {
            format!("{root_str}/")
        };
        if !target_str.starts_with(&prefix) || target_str == root_str {
            bail!(
                "Path traversal detected: {:?} is not strictly inside {:?}",
                norm_target,
                norm_root
            );
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        if !norm_target.starts_with(&norm_root) || norm_target == norm_root {
            bail!(
                "Path traversal detected: {:?} is not strictly inside {:?}",
                norm_target,
                norm_root
            );
        }
        Ok(())
    }
}

fn normalize_lexical(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    let stripped: std::borrow::Cow<'_, str> = if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        std::borrow::Cow::Owned(format!(r"\\{rest}"))
    } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
        std::borrow::Cow::Borrowed(rest)
    } else {
        raw
    };
    let mut out = PathBuf::new();
    for comp in Path::new(stripped.as_ref()).components() {
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

/// Detect whether a path resides on an external/removable mountpoint or Windows drive root.
pub fn extract_external_mountpoint(path: &Path) -> Option<PathBuf> {
    let s = path.to_string_lossy();
    // macOS /Volumes/<vol> and Linux /mnt/<vol>
    for prefix in ["/Volumes/", "/mnt/"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            if let Some(vol) = rest.split('/').next().filter(|v| !v.is_empty()) {
                return Some(PathBuf::from(format!("{prefix}{vol}")));
            }
        }
    }
    // Linux udisks2 /run/media/<user>/<vol> and /media/<user>/<vol> (or /media/<vol>)
    for prefix in ["/run/media/", "/media/"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            let mut segs = rest.split('/').filter(|v| !v.is_empty());
            if let Some(first) = segs.next() {
                if prefix == "/run/media/" {
                    if let Some(vol) = segs.next() {
                        return Some(PathBuf::from(format!("{prefix}{first}/{vol}")));
                    }
                }
                return Some(PathBuf::from(format!("{prefix}{first}")));
            }
        }
    }
    // Windows drive root (`D:\...` or `D:/...`) or UNC share (`\\server\share`)
    let bytes = s.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        let drive = (bytes[0] as char).to_ascii_uppercase();
        return Some(PathBuf::from(format!("{drive}:\\")));
    }
    if let Some(rest) = s.strip_prefix("\\\\") {
        let mut parts = rest.split('\\').filter(|v| !v.is_empty());
        if let (Some(server), Some(share)) = (parts.next(), parts.next()) {
            return Some(PathBuf::from(format!("\\\\{server}\\{share}")));
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
    #[cfg(unix)]
    if matches!(err.raw_os_error(), Some(18)) {
        return true;
    }
    #[cfg(windows)]
    if matches!(err.raw_os_error(), Some(17)) {
        return true;
    }
    err.kind() == std::io::ErrorKind::CrossesDevices
}

pub fn copy_recursive(src: &Path, dest: &Path) -> Result<()> {
    let meta =
        fs::symlink_metadata(src).with_context(|| format!("failed to stat source {:?}", src))?;
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
            if fs::metadata(src).map(|m| m.is_dir()).unwrap_or(false) {
                fs::create_dir_all(dest)?;
                for entry in fs::read_dir(src)? {
                    let entry = entry?;
                    copy_recursive(&entry.path(), &dest.join(entry.file_name()))?;
                }
            } else if src.exists() {
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::copy(src, dest)?;
            }
        }
    } else {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dest)?;
    }
    Ok(())
}

#[cfg(windows)]
#[allow(clippy::permissions_set_readonly_false)]
fn clear_readonly_recursive(path: &Path) {
    let mut stack = vec![path.to_path_buf()];
    while let Some(cur) = stack.pop() {
        let Ok(meta) = fs::symlink_metadata(&cur) else {
            continue;
        };
        let mut perms = meta.permissions();
        if perms.readonly() {
            perms.set_readonly(false);
            let _ = fs::set_permissions(&cur, perms);
        }
        if meta.is_dir() && !meta.file_type().is_symlink() {
            if let Ok(entries) = fs::read_dir(&cur) {
                for entry in entries.flatten() {
                    stack.push(entry.path());
                }
            }
        }
    }
}

pub fn remove_path(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path)?;
    #[cfg(windows)]
    {
        let attempt = || -> std::io::Result<()> {
            if meta.file_type().is_symlink() {
                if path.is_dir() {
                    fs::remove_dir(path)
                } else {
                    fs::remove_file(path)
                }
            } else if meta.is_dir() {
                fs::remove_dir_all(path)
            } else {
                fs::remove_file(path)
            }
        };
        match attempt() {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
                clear_readonly_recursive(path);
                attempt()?;
                Ok(())
            }
            Err(err) => Err(err.into()),
        }
    }
    #[cfg(not(windows))]
    {
        if meta.is_dir() {
            fs::remove_dir_all(path)?;
        } else {
            fs::remove_file(path)?;
        }
        Ok(())
    }
}
