#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use napi::bindgen_prelude::*;
use nix::errno::Errno;
use nix::fcntl::OFlag;
use nix::sys::mman::{mmap, munmap, shm_open, shm_unlink, MapFlags, ProtFlags};
use nix::sys::stat::Mode;
use nix::unistd::{dup, ftruncate};
use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::os::fd::{AsFd, FromRawFd, OwnedFd};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

mod term;
pub use term::*;
mod input;
pub use input::*;
mod png_encode;
pub use png_encode::*;

#[napi(object)]
pub struct DirtyRect {
  pub x: u32,
  pub y: u32,
  pub width: u32,
  pub height: u32,
}

/// A GPU dmabuf kept mapped past the caller's `texture.release()`.
///
/// Electron's texture object is the only public way to reach a shared texture,
/// and Electron documents that only a limited number may exist at once. This
/// holds the plane open by `dup()`-ing its fd, so the caller can release the
/// texture immediately and do the read afterwards, rather than holding a
/// texture for the duration of the read.
struct PinnedTexture {
  /// Kept alive purely to pin the allocation; never read from directly.
  _fd: OwnedFd,
  ptr: std::ptr::NonNull<u8>,
  len: usize,
  width: u32,
  height: u32,
  stride: u32,
  offset: u32,
}

// Safety: access is serialised by the PINNED mutex, and the mapping is only
// read through the slice built in write_texture.
unsafe impl Send for PinnedTexture {}

static PINNED: OnceLock<Mutex<HashMap<u32, PinnedTexture>>> = OnceLock::new();
static NEXT_PIN: AtomicU32 = AtomicU32::new(1);

fn pinned() -> &'static Mutex<HashMap<u32, PinnedTexture>> {
  PINNED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Pins a GPU shared texture's plane (a dmabuf from
/// `webPreferences.offscreen.useSharedTexture`) and returns a handle for
/// `ShmGraphicBuffer::write_texture`.
///
/// Costs ~0.2ms, against ~20ms for the read it enables, so the caller can
/// release the Electron texture immediately afterwards. The fd is dup'd, so the
/// allocation outlives Electron dropping its own reference; `unpin_texture`
/// drops it. `stride` is the row stride in bytes, GPU-aligned and therefore
/// larger than `width * 4`.
#[napi]
pub fn pin_texture(
  fd: i32,
  width: u32,
  height: u32,
  stride: u32,
  offset: u32,
  size: u32,
) -> napi::Result<u32> {
  if width == 0 || height == 0 {
    return Err(napi::Error::from_reason("Texture has zero size"));
  }
  let row_bytes = width as usize * 4;
  let needed = offset as usize + stride as usize * (height as usize - 1) + row_bytes;
  if (size as usize) < needed {
    return Err(napi::Error::from_reason(format!(
      "Texture plane too small: {} < {}",
      size, needed
    )));
  }
  let len = NonZeroUsize::new(size as usize)
    .ok_or_else(|| napi::Error::from_reason("Texture size must be non-zero"))?;

  // dup first: if the mmap fails we must not have taken ownership of an fd
  // Electron still owns.
  let owned = unsafe {
    OwnedFd::from_raw_fd(
      dup(fd).map_err(|e| napi::Error::from_reason(format!("Failed to dup texture fd: {}", e)))?,
    )
  };
  let ptr = unsafe {
    mmap(
      None,
      len,
      ProtFlags::PROT_READ,
      MapFlags::MAP_SHARED,
      owned.as_fd(),
      0,
    )
    .map_err(|e| napi::Error::from_reason(format!("Failed to mmap texture: {}", e)))?
    .cast::<u8>()
  };

  let id = NEXT_PIN.fetch_add(1, Ordering::Relaxed);
  let entry = PinnedTexture {
    _fd: owned,
    ptr,
    len: len.get(),
    width,
    height,
    stride,
    offset,
  };
  match pinned().lock() {
    Ok(mut map) => {
      map.insert(id, entry);
      Ok(id)
    }
    Err(_) => {
      unsafe {
        let _ = munmap(entry.ptr.cast::<std::ffi::c_void>(), entry.len);
      }
      Err(napi::Error::from_reason("Texture pin table is poisoned"))
    }
  }
}

/// Unmap a pinned texture without reading it. Safe with a stale or already
/// consumed id, so callers can unpin unconditionally on the error path.
#[napi]
pub fn unpin_texture(id: u32) {
  if let Ok(mut map) = pinned().lock() {
    if let Some(p) = map.remove(&id) {
      unsafe {
        let _ = munmap(p.ptr.cast::<std::ffi::c_void>(), p.len);
      }
      // `_fd` closes on drop.
    }
  }
}

#[napi(custom_finalize)]
pub struct ShmGraphicBuffer {
  name: String,
  size: u32,
  /// Cached mapping to avoid per-frame mmap/munmap page-fault cost.
  /// (fd, ptr, len)
  cached: Mutex<Option<(OwnedFd, NonNull<u8>, usize)>>,
  /// Last `write_texture` split, in ms: (shm open+truncate+map, convert, unmap).
  /// Read by `timings` so the JS perf log can attribute the per-frame cost.
  timings: Mutex<(f64, f64, f64)>,
}

impl ObjectFinalize for ShmGraphicBuffer {
  fn finalize(self, mut _env: Env) -> Result<()> {
    // Clean up cached mapping if present
    if let Ok(mut guard) = self.cached.lock() {
      if let Some((_fd, ptr, len)) = guard.take() {
        unsafe {
          let _ = munmap(ptr.cast::<std::ffi::c_void>(), len);
        }
      }
    }
    // Attempt to unlink the shared memory, doesn't really matter if it fails
    let _ = shm_unlink(self.name());
    Ok(())
  }
}

#[napi]
impl ShmGraphicBuffer {
  /// Creates a new shared memory buffer with a unique name with the provided size
  #[napi(constructor)]
  pub fn new(size: u32) -> Self {
    let timestamp = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .unwrap()
      .as_nanos();

    let hex = format!("{:x}", timestamp);
    let significant_part = if hex.len() > 23 {
      &hex[hex.len() - 23..]
    } else {
      &hex
    };
    let name = format!("/awrit_{}", significant_part);

    Self {
      name,
      size,
      cached: Mutex::new(None),
      timings: std::sync::Mutex::new((0.0, 0.0, 0.0)),
    }
  }

  /// Returns a reference to the shared memory name
  pub fn name(&self) -> &str {
    &self.name
  }

  /// Writes the raster, but refuses if the terminal has not yet read the
  /// previous contents of this segment.
  ///
  /// On first use: `O_CREAT|O_EXCL` creates segment, mmap and cache fd+ptr.
  /// On reuse: terminal has consumed (pool rotation), use cached mmap directly.
  /// Returns `Ok(false)` if segment still in use (shouldn't happen with pool rotation).
  #[napi]
  pub fn try_write(&self, buffer: Buffer, image_width: u32) -> napi::Result<bool> {
    // Get or create cached mapping
    let (dst_ptr, dst_len, map_time_ms) = {
      let mut cached = self
        .cached
        .lock()
        .map_err(|_| napi::Error::from_reason("cached mutex poisoned"))?;
      if let Some((_fd, ptr, len)) = cached.as_ref() {
        // Reuse existing mapping - terminal consumed this segment N frames ago
        (*ptr, *len, 0.0)
      } else {
        // First time: create segment with O_EXCL (fails if name exists = terminal hasn't consumed)
        let t0 = std::time::Instant::now();
        let fd = match shm_open(
          self.name(),
          OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_RDWR,
          Mode::S_IRUSR | Mode::S_IWUSR,
        ) {
          Ok(fd) => fd,
          Err(Errno::EEXIST) => return Ok(false), // Shouldn't happen with pool rotation
          Err(e) => {
            return Err(napi::Error::from_reason(format!(
              "Failed to open shared memory: {}",
              e
            )));
          }
        };

        ftruncate(&fd, self.size as i64).map_err(|e| {
          napi::Error::from_reason(format!("Failed to truncate shared memory: {}", e))
        })?;

        let dst_size = NonZeroUsize::new(self.size as usize)
          .ok_or_else(|| napi::Error::from_reason("Size must be non-zero"))?;

        let raw_ptr = unsafe {
          mmap(
            None,
            dst_size,
            ProtFlags::PROT_READ | ProtFlags::PROT_WRITE,
            MapFlags::MAP_SHARED,
            fd.as_fd(),
            0,
          )
          .map_err(|e| napi::Error::from_reason(format!("Failed to mmap shared memory: {}", e)))?
        };
        let map_ms = t0.elapsed().as_secs_f64() * 1000.0;
        let dst_ptr = raw_ptr.cast::<u8>();
        *cached = Some((fd, dst_ptr, dst_size.get()));
        (dst_ptr, dst_size.get(), map_ms)
      }
    };

    // Convert directly into the cached mapping
    let src_slice = buffer.as_ref();
    let dst_slice = unsafe { std::slice::from_raw_parts_mut(dst_ptr.as_ptr() as *mut u8, dst_len) };
    if !bgra_to_rgba::bgra_to_rgba(src_slice, dst_slice) {
      return Err(napi::Error::from_reason("Failed to convert BGRA to RGBA"));
    }

    // Don't unmap - keep the mapping cached for next cycle
    if let Ok(mut t) = self.timings.lock() {
      *t = (map_time_ms, 0.0, 0.0);
    }
    let _ = image_width;
    Ok(true)
  }

  /// Returns the shared memory name as a base64 encoded string
  #[napi(getter)]
  pub fn name_base64(&self) -> String {
    BASE64.encode(self.name.as_bytes())
  }

  /// Creates and truncates the shared memory segment to the specified size, filling it with zeros
  #[napi]
  pub fn write_empty(&self) -> napi::Result<()> {
    // Open shared memory with create flag
    let fd = shm_open(
      self.name(),
      OFlag::O_CREAT | OFlag::O_RDWR,
      Mode::S_IRUSR | Mode::S_IWUSR,
    )
    .map_err(|e| napi::Error::from_reason(format!("Failed to open shared memory: {}", e)))?;

    // Truncate to desired size
    ftruncate(fd, self.size as i64)
      .map_err(|e| napi::Error::from_reason(format!("Failed to truncate shared memory: {}", e)))?;

    // Close the file descriptor - fd is automatically closed when dropped
    Ok(())
  }

  /// Cost of the last `write_texture`, in ms: (shm map, convert, unmap).
  /// Diagnostics only — reading it costs a lock, so it is off the hot path in JS.
  #[napi]
  pub fn timings(&self) -> [f64; 3] {
    match self.timings.lock() {
      Ok(t) => [t.0, t.1, t.2],
      Err(_) => [0.0, 0.0, 0.0],
    }
  }

  /// Writes an image buffer to the shared memory at the specified dirty rectangle
  #[napi]
  pub fn write(
    &self,
    buffer: Buffer,
    image_width: u32,
    dirty_rect: Option<DirtyRect>,
  ) -> napi::Result<()> {
    // Acquire or create cached mapping
    let (dst_ptr, dst_len, map_time_ms) = {
      let mut cached = self
        .cached
        .lock()
        .map_err(|_| napi::Error::from_reason("cached mutex poisoned"))?;
      if let Some((_fd, ptr, len)) = cached.as_ref() {
        // Reuse existing mapping
        let t0 = std::time::Instant::now();
        let _ = t0; // map_time_ms ~0
        (*ptr, *len, 0.0)
      } else {
        // First time: create shm object and map
        let t0 = std::time::Instant::now();
        let shm_fd = shm_open(
          self.name(),
          OFlag::O_CREAT | OFlag::O_RDWR,
          Mode::S_IRUSR | Mode::S_IWUSR,
        )
        .map_err(|e| napi::Error::from_reason(format!("Failed to open shared memory: {}", e)))?;

        ftruncate(&shm_fd, self.size as i64).map_err(|e| {
          napi::Error::from_reason(format!("Failed to truncate shared memory: {}", e))
        })?;

        let dst_size = NonZeroUsize::new(self.size as usize)
          .ok_or_else(|| napi::Error::from_reason("Size must be non-zero"))?;

        let raw_ptr = unsafe {
          mmap(
            None,
            dst_size,
            ProtFlags::PROT_READ | ProtFlags::PROT_WRITE,
            MapFlags::MAP_SHARED,
            shm_fd.as_fd(),
            0,
          )
          .map_err(|e| napi::Error::from_reason(format!("Failed to mmap shared memory: {}", e)))?
        };
        let map_ms = t0.elapsed().as_secs_f64() * 1000.0;
        let dst_ptr = raw_ptr.cast::<u8>();
        *cached = Some((shm_fd, dst_ptr, dst_size.get()));
        (dst_ptr, dst_size.get(), map_ms)
      }
    };

    let src_slice = buffer.as_ref();
    let dst_slice = unsafe { std::slice::from_raw_parts_mut(dst_ptr.as_ptr() as *mut u8, dst_len) };

    match dirty_rect {
      Some(rect) => {
        let bgra_rect = bgra_to_rgba::Rect {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        };
        if !bgra_to_rgba::bgra_to_rgba_rect(src_slice, dst_slice, image_width, bgra_rect) {
          return Err(napi::Error::from_reason("Failed to convert BGRA to RGBA"));
        }
      }
      None => {
        if !bgra_to_rgba::bgra_to_rgba(src_slice, dst_slice) {
          return Err(napi::Error::from_reason("Failed to convert BGRA to RGBA"));
        }
      }
    }

    if let Ok(mut t) = self.timings.lock() {
      *t = (map_time_ms, 0.0, 0.0); // convert time not split here
    }
    Ok(())
  }

  /// Reads a texture pinned by `pin_texture` into the shared memory, skipping
  /// the CPU-side `NativeImage` copy entirely. Row padding is dropped.
  ///
  /// Consumes the pin. Prefer this over `write_texture` when the caller can
  /// release the Electron texture before reading, so the texture is not held
  /// for the duration of the read.
  #[napi]
  pub fn write_texture(&self, id: u32, swap: bool) -> napi::Result<()> {
    let pinned = pinned()
      .lock()
      .map_err(|_| napi::Error::from_reason("Texture pin table is poisoned"))?
      // Consume on the way out, so a later unpin_texture is a harmless no-op.
      .remove(&id)
      .ok_or_else(|| napi::Error::from_reason("Unknown or already-consumed texture pin"))?;

    let result = self.write_pinned(&pinned, swap);

    unsafe {
      let _ = munmap(pinned.ptr.cast::<std::ffi::c_void>(), pinned.len);
    }
    result
  }

  fn write_pinned(&self, pinned: &PinnedTexture, swap: bool) -> napi::Result<()> {
    let src_ptr = pinned.ptr;
    let offset = pinned.offset;
    let width = pinned.width;
    let height = pinned.height;
    let stride = pinned.stride;
    if (self.size as usize) < width as usize * 4 * height as usize {
      return Err(napi::Error::from_reason(
        "Shared buffer smaller than texture",
      ));
    }

    // Acquire or create cached mapping
    let (dst_ptr, dst_len, map_time_ms) = {
      let mut cached = self
        .cached
        .lock()
        .map_err(|_| napi::Error::from_reason("cached mutex poisoned"))?;
      if let Some((_fd, ptr, len)) = cached.as_ref() {
        // Reuse existing mapping
        let t0 = std::time::Instant::now();
        let _ = t0; // map_time_ms ~0
        (*ptr, *len, 0.0)
      } else {
        // First time: create shm object and map
        let t0 = std::time::Instant::now();
        let shm_fd = shm_open(
          self.name(),
          OFlag::O_CREAT | OFlag::O_RDWR,
          Mode::S_IRUSR | Mode::S_IWUSR,
        )
        .map_err(|e| napi::Error::from_reason(format!("Failed to open shared memory: {}", e)))?;

        ftruncate(&shm_fd, self.size as i64).map_err(|e| {
          napi::Error::from_reason(format!("Failed to truncate shared memory: {}", e))
        })?;

        let dst_size = NonZeroUsize::new(self.size as usize)
          .ok_or_else(|| napi::Error::from_reason("Size must be non-zero"))?;

        let raw_ptr = unsafe {
          mmap(
            None,
            dst_size,
            ProtFlags::PROT_READ | ProtFlags::PROT_WRITE,
            MapFlags::MAP_SHARED,
            shm_fd.as_fd(),
            0,
          )
          .map_err(|e| napi::Error::from_reason(format!("Failed to mmap shared memory: {}", e)))?
        };
        let map_ms = t0.elapsed().as_secs_f64() * 1000.0;
        // mmap returns NonNull<c_void>; cast to NonNull<u8> for cached storage
        let dst_ptr = raw_ptr.cast::<u8>();
        // Store fd and ptr for reuse
        *cached = Some((shm_fd, dst_ptr, dst_size.get()));
        (dst_ptr, dst_size.get(), map_ms)
      }
    };

    let result = (|| -> napi::Result<()> {
      let t0 = std::time::Instant::now();

      let src_slice = unsafe {
        std::slice::from_raw_parts(
          src_ptr.as_ptr().add(offset as usize),
          pinned.len - offset as usize,
        )
      };
      let dst_slice =
        unsafe { std::slice::from_raw_parts_mut(dst_ptr.as_ptr() as *mut u8, dst_len) };

      let converted = bgra_to_rgba::bgra_to_rgba_strided(
        src_slice,
        dst_slice,
        width,
        height,
        stride as usize,
        swap,
      );
      let t2 = t0.elapsed().as_secs_f64() * 1000.0;

      if !converted {
        return Err(napi::Error::from_reason(
          "Failed to convert texture to RGBA",
        ));
      }
      if let Ok(mut t) = self.timings.lock() {
        *t = (
          map_time_ms,
          t2 - map_time_ms,
          t0.elapsed().as_secs_f64() * 1000.0 - t2,
        );
      }
      Ok(())
    })();

    result
  }
}
