//! Where the running app lives, when that's somewhere it can't stay: the
//! disk image's window, or the temporary copy macOS runs an app from when
//! it's opened in Downloads before being moved (App Translocation). An
//! update can't be installed there, and a path written down for an agent
//! stops working once the disk is ejected or the app is moved.

use std::path::{Path, PathBuf};

/// Why the app can't update itself where it is, with what to do.
pub fn misplaced() -> Option<&'static str> {
    let bundle = bundle_path()?;
    misplaced_at(&bundle, read_only(&bundle))
}

fn misplaced_at(bundle: &Path, read_only: bool) -> Option<&'static str> {
    let text = bundle.to_string_lossy();
    if text.contains("/AppTranslocation/") {
        return Some(
            "Rowkery is running from a temporary copy macOS made. \
             Move it to Applications, open it from there, and try again.",
        );
    }
    if read_only {
        return Some(if text.starts_with("/Volumes/") {
            "Rowkery is running from the disk image. \
             Move it to Applications, open it from there, and try again."
        } else {
            "Rowkery is running from a disk it can't write to. \
             Move it to Applications, open it from there, and try again."
        });
    }
    None
}

/// The `.app` the running executable sits in (`…/Rowkery.app/Contents/MacOS/Rowkery`).
fn bundle_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .map(Path::to_path_buf)
}

#[cfg(target_os = "macos")]
fn read_only(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `c` is a valid C string and `stat` is written before it's read.
    unsafe {
        libc::statvfs(c.as_ptr(), stat.as_mut_ptr()) == 0
            && stat.assume_init().f_flag & libc::ST_RDONLY != 0
    }
}

#[cfg(not(target_os = "macos"))]
fn read_only(_path: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_disk_image_and_a_translocated_copy_are_misplaced() {
        let dmg = Path::new("/Volumes/Rowkery 0.3.0/Rowkery.app");
        assert!(misplaced_at(dmg, true).unwrap().contains("disk image"));
        let moved = Path::new("/private/var/folders/x/T/AppTranslocation/1F2E/d/Rowkery.app");
        assert!(misplaced_at(moved, true)
            .unwrap()
            .contains("temporary copy"));
    }

    #[test]
    fn applications_and_a_writable_external_disk_are_fine() {
        assert_eq!(
            misplaced_at(Path::new("/Applications/Rowkery.app"), false),
            None
        );
        assert_eq!(
            misplaced_at(Path::new("/Volumes/Work/Apps/Rowkery.app"), false),
            None
        );
    }
}
