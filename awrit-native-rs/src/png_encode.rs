// Native PNG encode for the tmux path.
//
// 06-05 measured Electron's `toPNG()` at 36-169KB for a 1073x546 frame. The
// write to tmux is 85-90% of the delivery segment and is bytes-bound, so bytes
// are what matter, not encode speed. On real page content `png` produces
// 12.6-22.7% fewer bytes than Electron for truecolour.
//
// Two deliberate constraints, both from measurement:
//
// 1. Opaque frames only. Electron's `toBitmap()` is premultiplied, so handing
//    it to a PNG encoder as straight alpha would shift colours on transparent
//    pages. Rather than untangle that, `encode_png_opaque` refuses and the
//    caller keeps Electron's `toPNG()` unchanged. Opaque is the common case
//    and it is bit-exact.
// 2. Two filters, pick the smaller. `NoFilter` wins on flat page content
//    (55139B vs 72787B on a text page) but LOSES to `Sub` on gradients
//    (206383B vs 143165B -- worse than Electron either way). `Sub` is the
//    better filter whenever the first pass failed to compress like flat UI.

use napi::bindgen_prelude::Buffer;
use png::{BitDepth, ColorType, Compression, Encoder, FilterType};

/// A frame is "flat" if NoFilter compresses at least this many times over the
/// raw RGB size. Below it, the content is page-like and NoFilter wins; above it,
/// the pixels are gradient-like and Sub wins.
///
/// ponytail: calibration knob, not a constant of nature. Measured against three
/// 1073x546 frames (text 55139B, ui 31691B, image 206383B -> passes). Raise it
/// if a page should get Sub, or reach for png's `FilterType::Adaptive` when the
/// crate grows one — that picks per row and beats both.
const FLAT_COMPRESSION_RATIO: usize = 16;

fn encode_rgb(pixels: &[u8], width: u32, height: u32, filter: FilterType) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut enc = Encoder::new(&mut out, width, height);
        enc.set_color(ColorType::Rgb);
        enc.set_depth(BitDepth::Eight);
        enc.set_compression(Compression::Default);
        enc.set_filter(filter);
        // Writing to a Vec<u8> cannot fail.
        let _ = enc.write_header().map(|mut h| h.write_image_data(pixels));
    }
    out
}

/// Encode a BGRA bitmap to PNG, or return `None` if it has any transparency.
///
/// `bgra` is exactly `width * height * 4` bytes in Electron's `toBitmap()` order.
#[napi]
pub fn encode_png_opaque(bgra: Buffer, width: u32, height: u32) -> napi::Result<Option<Buffer>> {
    match encode_bgra_opaque(bgra.as_ref(), width, height) {
        Ok(out) => Ok(out.map(Buffer::from)),
        Err(msg) => Err(napi::Error::from_reason(msg)),
    }
}

/// The whole encoder, napi-free so it can be tested directly.
fn encode_bgra_opaque(bgra: &[u8], width: u32, height: u32) -> Result<Option<Vec<u8>>, String> {
    let px = (width as usize)
        .checked_mul(height as usize)
        .ok_or_else(|| "Frame dimensions overflow".to_string())?;
    if width == 0 || height == 0 {
        return Err("Frame dimensions must be non-zero".to_string());
    }
    let expected = px.checked_mul(4).ok_or_else(|| "Frame size overflows".to_string())?;
    if bgra.len() != expected {
        return Err(format!(
            "Bitmap is {} bytes, expected {} for {}x{} BGRA",
            bgra.len(),
            expected,
            width,
            height
        ));
    }

    // Transparency check and channel swap in one pass. Short-circuits, so a
    // transparent frame costs no more than the scan that rejects it.
    let mut pixels = Vec::with_capacity(px * 3);
    for p in bgra.chunks_exact(4) {
        if p[3] != 255 {
            return Ok(None);
        }
        pixels.push(p[2]);
        pixels.push(p[1]);
        pixels.push(p[0]);
    }

    let none = encode_rgb(&pixels, width, height, FilterType::NoFilter);
    let out = if none.len() * FLAT_COMPRESSION_RATIO > pixels.len() {
        let sub = encode_rgb(&pixels, width, height, FilterType::Sub);
        if sub.len() < none.len() {
            sub
        } else {
            none
        }
    } else {
        none
    };

    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Flat UI-ish content: large runs of one colour.
    fn flat_bgra(w: u32, h: u32) -> Vec<u8> {
        let mut v = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                let band: u8 = ((y / 8) % 3) as u8;
                let px: [u8; 4] = match band {
                    0 => [255, 255, 255, 255],
                    1 => [30, 30, 30, 255],
                    _ => [200, 60, 60, 255],
                };
                // A little per-pixel noise so it is not one solid block.
                let n = ((x * 7 + y * 13) % 5) as u8;
                v.extend_from_slice(&[px[2].saturating_add(n), px[1], px[0], px[3]]);
            }
        }
        v
    }

    /// Smooth horizontal gradient -- the case that defeats NoFilter.
    fn gradient_bgra(w: u32, h: u32) -> Vec<u8> {
        let mut v = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                let r = (x * 255 / w.max(1)) as u8;
                let g = (y * 255 / h.max(1)) as u8;
                let b = ((x + y) * 255 / (w + h).max(1)) as u8;
                v.extend_from_slice(&[b, g, r, 255]);
            }
        }
        v
    }

    fn decode_rgb(png: &[u8]) -> (u32, u32, Vec<u8>) {
        let mut dec = png::Decoder::new(png);
        dec.set_transformations(png::Transformations::EXPAND);
        let mut r = dec.read_info().unwrap();
        let mut buf = vec![0u8; r.output_buffer_size()];
        let info = r.next_frame(&mut buf).unwrap();
        (info.width, info.height, buf[..info.buffer_size()].to_vec())
    }

    #[test]
    fn opaque_frame_round_trips_bit_exact() {
        let (w, h) = (64u32, 48u32);
        let src = flat_bgra(w, h);
        let out = encode_bgra_opaque(&src, w, h).unwrap().expect("opaque accepted");
        let (dw, dh, px) = decode_rgb(&out);
        assert_eq!((dw, dh), (w, h));
        assert_eq!(px.len(), (w * h * 3) as usize);
        for (i, p) in src.chunks_exact(4).enumerate() {
            // BGRA in, RGB out, so the channels must be reversed and alpha dropped.
            assert_eq!(&px[i * 3..i * 3 + 3], &[p[2], p[1], p[0]], "pixel {i} differs");
        }
    }

    #[test]
    fn any_transparency_is_refused() {
        let (w, h) = (8u32, 8u32);
        let mut src = flat_bgra(w, h);
        // A single non-opaque pixel anywhere must reject the whole frame.
        for i in [0usize, 17, 63] {
            src[i * 4 + 3] = 254;
            assert!(encode_bgra_opaque(&src, w, h).unwrap().is_none());
            src[i * 4 + 3] = 255;
        }
    }

    #[test]
    fn gradients_pick_sub_over_nofilter() {
        let (w, h) = (200u32, 120u32);
        let src = gradient_bgra(w, h);
        let pixels_len = (w * h * 3) as usize;
        let none = encode_rgb(&interleave_rgb(&src), w, h, FilterType::NoFilter);
        let sub = encode_rgb(&interleave_rgb(&src), w, h, FilterType::Sub);
        assert!(
            sub.len() < none.len(),
            "Sub {} should beat NoFilter {} on a gradient",
            sub.len(),
            none.len()
        );
        // ...and the threshold must actually route a gradient to the second pass.
        assert!(none.len() * FLAT_COMPRESSION_RATIO > pixels_len);
    }

    #[test]
    fn flat_content_keeps_nofilter() {
        let (w, h) = (200u32, 120u32);
        let src = flat_bgra(w, h);
        let none = encode_rgb(&interleave_rgb(&src), w, h, FilterType::NoFilter);
        let sub = encode_rgb(&interleave_rgb(&src), w, h, FilterType::Sub);
        assert!(
            none.len() < sub.len(),
            "NoFilter {} should beat Sub {} on flat content",
            none.len(),
            sub.len()
        );
        assert!(
            none.len() * FLAT_COMPRESSION_RATIO <= (w * h * 3) as usize,
            "flat content must not trigger the Sub retry"
        );
    }

    fn interleave_rgb(bgra: &[u8]) -> Vec<u8> {
        let mut px = Vec::with_capacity(bgra.len() / 4 * 3);
        for p in bgra.chunks_exact(4) {
            px.extend_from_slice(&[p[2], p[1], p[0]]);
        }
        px
    }

    /// The 06-05 acceptance check: never larger than Electron's own output on the
    /// real captured frames. Depends on `dist/bench/frames` (gitignored, produced
    /// by `dist/bench/harness.js`), so it SKIPS when that is absent rather than
    /// failing a checkout that has never run the harness.
    #[test]
    fn never_larger_than_electron_on_captured_frames() {
        let dir = std::path::Path::new("../dist/bench/frames");
        if !dir.exists() {
            eprintln!("skipping: no captured frames at {}", dir.display());
            return;
        }
        let mut checked = 0;
        for name in ["text", "image", "ui"] {
            let Ok(bgra) = std::fs::read(dir.join(format!("{name}.bgra"))) else {
                continue;
            };
            let electron = std::fs::read(dir.join(format!("{name}.electron.png"))).unwrap();
            let w = 1073u32;
            let h = (bgra.len() / 4 / w as usize) as u32;
            let ours = encode_bgra_opaque(&bgra, w, h).unwrap().expect("frame is opaque");
            eprintln!(
                "  {name}: ours {}B vs electron {}B ({:.1}%)",
                ours.len(),
                electron.len(),
                (ours.len() as f64 / electron.len() as f64 - 1.0) * 100.0
            );
            assert!(
                ours.len() < electron.len(),
                "{name}: native encode must not be larger than Electron"
            );
            checked += 1;
        }
        assert!(checked > 0, "no captured frames found to check");
    }

    #[test]
    fn rejects_malformed_input() {
        // Wrong buffer length, zero dimensions, and an overflowing size.
        assert!(encode_bgra_opaque(&[0u8; 10], 4, 4).is_err());
        assert!(encode_bgra_opaque(&[], 0, 4).is_err());
        assert!(encode_bgra_opaque(&[], u32::MAX, u32::MAX).is_err());
        assert!(encode_bgra_opaque(&[0u8; 16], 2, 2).is_ok());
    }
}
