#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use napi::bindgen_prelude::*;
use nix::fcntl::OFlag;
use nix::sys::mman::{mmap, munmap, shm_open, shm_unlink, MapFlags, ProtFlags};
use nix::sys::stat::Mode;
use nix::unistd::ftruncate;
use std::num::NonZeroUsize;
use std::os::fd::OwnedFd;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

mod term;
pub use term::*;
mod input;
pub use input::*;

#[napi(object)]
pub struct DirtyRect {
  pub x: u32,
  pub y: u32,
  pub width: u32,
  pub height: u32,
}

/// A lazily created, persistent shm mapping: opened and mmapped once,
/// reused for every write, and released when the buffer is dropped.
struct ShmMapping {
  fd: OwnedFd,
  addr: usize,
}

#[napi(custom_finalize)]
pub struct ShmGraphicBuffer {
  name: String,
  size: u32,
  mapping: Mutex<Option<ShmMapping>>,
}

impl ObjectFinalize for ShmGraphicBuffer {
  fn finalize(self, mut _env: Env) -> Result<()> {
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

    // Convert timestamp to hex, keeping the least significant (most unique) digits
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
      mapping: Mutex::new(None),
    }
  }

  /// Returns a reference to the shared memory name
  pub fn name(&self) -> &str {
    &self.name
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

  /// Lazily opens and maps the shared memory once; the mapping is reused for
  /// every subsequent write and released when the buffer is dropped.
  fn ensure_mapped(&self) -> napi::Result<usize> {
    let mut mapping = self.mapping.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(m) = mapping.as_ref() {
      return Ok(m.addr);
    }

    // Open shared memory
    let fd = shm_open(
      self.name(),
      OFlag::O_CREAT | OFlag::O_RDWR,
      Mode::S_IRUSR | Mode::S_IWUSR,
    )
    .map_err(|e| napi::Error::from_reason(format!("Failed to open shared memory: {}", e)))?;

    ftruncate(&fd, self.size as i64)
      .map_err(|e| napi::Error::from_reason(format!("Failed to truncate shared memory: {}", e)))?;

    let size = NonZeroUsize::new(self.size as usize)
      .ok_or_else(|| napi::Error::from_reason("Size must be non-zero"))?;

    // Map the shared memory
    let ptr = unsafe {
      mmap(
        None,
        size,
        ProtFlags::PROT_READ | ProtFlags::PROT_WRITE,
        MapFlags::MAP_SHARED,
        &fd,
        0,
      )
    }
    .map_err(|e| napi::Error::from_reason(format!("Failed to mmap shared memory: {}", e)))?;

    let addr = ptr.as_ptr() as usize;
    *mapping = Some(ShmMapping { fd, addr });
    Ok(addr)
  }

  /// Writes an image buffer to the shared memory at the specified dirty rectangle
  #[napi]
  pub fn write(
    &self,
    buffer: Buffer,
    image_width: u32,
    dirty_rect: Option<DirtyRect>,
  ) -> napi::Result<()> {
    let addr = self.ensure_mapped()?;

    let src_slice = buffer.as_ref();
    let dst_slice = unsafe { std::slice::from_raw_parts_mut(addr as *mut u8, self.size as usize) };

    match dirty_rect {
      Some(rect) => {
        let bgra_rect = bgra_to_rgba::Rect {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        };
        // Convert the rect in place (same position in the shared frame as in
        // the source bitmap), so a partial update ends up byte-identical to a
        // full-frame write of the same image.
        let dst_start = (rect.y as usize)
          .saturating_mul(image_width as usize)
          .saturating_add(rect.x as usize)
          * 4;
        let dst_end = dst_start.saturating_add(rect.width as usize * rect.height as usize * 4);
        if dst_end > dst_slice.len() || rect.x.saturating_add(rect.width) > image_width {
          return Err(napi::Error::from_reason("Failed to convert BGRA to RGBA"));
        }
        if !bgra_to_rgba::bgra_to_rgba_rect(
          src_slice,
          &mut dst_slice[dst_start..dst_end],
          image_width,
          bgra_rect,
        ) {
          return Err(napi::Error::from_reason("Failed to convert BGRA to RGBA"));
        }
      }
      None => {
        if !bgra_to_rgba::bgra_to_rgba(src_slice, dst_slice) {
          return Err(napi::Error::from_reason("Failed to convert BGRA to RGBA"));
        }
      }
    }

    Ok(())
  }
}

impl Drop for ShmGraphicBuffer {
  fn drop(&mut self) {
    if let Some(mapping) = self.mapping.get_mut().unwrap_or_else(|e| e.into_inner()).take() {
      let ShmMapping { fd, addr } = mapping;
      if let Some(ptr) = std::ptr::NonNull::new(addr as *mut std::ffi::c_void) {
        unsafe {
          let _ = munmap(ptr, self.size as usize);
        }
      }
      drop(fd);
    }
  }
}
