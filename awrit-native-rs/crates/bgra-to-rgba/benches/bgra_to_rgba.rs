use bgra_to_rgba::{bgra_to_rgba, bgra_to_rgba_rect, bgra_to_rgba_strided, Rect};
use criterion::{black_box, criterion_group, criterion_main, Criterion};

fn create_test_buffer(size: usize) -> (Vec<u8>, Vec<u8>) {
  let mut src = vec![0u8; size];
  for i in 0..size {
    src[i] = (i % 256) as u8;
  }
  let dst = vec![0u8; size];
  (src, dst)
}

fn bench_bgra_to_rgba(c: &mut Criterion) {
  let mut group = c.benchmark_group("bgra_to_rgba");

  for size in [32, 256, 512, 1024, 128 * 128 * 4, 480 * 270 * 4, 512 * 1024 * 4, 200 * 600 * 4].iter() {
    let (src, mut dst) = create_test_buffer(*size);

    group.bench_function(format!("size_{}", size), |b| {
      b.iter(|| {
        bgra_to_rgba(black_box(&src), black_box(&mut dst));
      });
    });
  }

  group.finish();
}

fn bench_bgra_to_rgba_rect(c: &mut Criterion) {
    let mut group = c.benchmark_group("bgra_to_rgba_rect");

    // Test different image sizes and rectangle sizes
    let test_cases = [
        // (image_width, image_height, rect_width, rect_height, rect_x, rect_y)
        (512, 512, 128, 128, 0, 0),       // Small region at top-left
        (1920, 1080, 480, 270, 720, 405), // Quarter size region at center
        (1024, 1024, 1024, 512, 0, 256),  // Full width, half height
        (800, 600, 200, 600, 300, 0),     // Vertical strip
    ];

    for (img_w, img_h, rect_w, rect_h, x, y) in test_cases.iter() {
        let src_size = (img_w * img_h * 4) as usize;
        let dst_size = (rect_w * rect_h * 4) as usize;
        let (src, mut dst) = create_test_buffer(src_size);
        dst.truncate(dst_size);

        let rect = Rect {
            x: *x,
            y: *y,
            width: *rect_w,
            height: *rect_h,
        };

        group.bench_function(
            format!("{}x{}_rect_{}x{}_at_{}_{}_size_{}", img_w, img_h, rect_w, rect_h, x, y, rect_w * rect_h * 4),
            |b| {
                b.iter(|| {
                    bgra_to_rgba_rect(
                        black_box(&src),
                        black_box(&mut dst),
                        black_box(*img_w),
                        black_box(rect),
                    );
                });
            },
        );
    }

    group.finish();
}

/// 08-01 Task 5 — exact tmux frame geometry.
///
/// The tmux path submits 893×672 frames (row stride 3572 = width*4, not a
/// multiple of 32 bytes) through `try_write` → packed `bgra_to_rgba`, and dirty
/// crops through `bgra_to_rgba_rect` with `image_width` 893. The 896-wide cases
/// are alignment controls: their row stride (3584 = 32 × 112) is 32-aligned, so
/// any gap against the 893 cases is the unaligned-stride cost the plan
/// hypothesises (08-01-PLAN Task 5).
fn bench_tmux_geometry(c: &mut Criterion) {
  let mut group = c.benchmark_group("tmux_geometry");

  const W: u32 = 893;
  const H: u32 = 672;
  const STRIDE: usize = W as usize * 4; // 3572 — not 32-aligned

  // What `try_write` runs: one packed conversion of the whole frame.
  let (src, mut dst) = create_test_buffer(W as usize * H as usize * 4);
  group.bench_function("packed_full_893x672", |b| {
    b.iter(|| {
      bgra_to_rgba(black_box(&src), black_box(&mut dst));
    });
  });

  // Per-row strided conversion at the exact production stride.
  let (src_s, mut dst_s) = create_test_buffer(STRIDE * H as usize);
  group.bench_function("strided_893_tight", |b| {
    b.iter(|| {
      bgra_to_rgba_strided(black_box(&src_s), black_box(&mut dst_s), W, H, STRIDE, true);
    });
  });

  // Alignment control: same content height, rows padded to a 32-byte multiple.
  const W2: u32 = 896;
  const STRIDE2: usize = W2 as usize * 4; // 3584 = 32 × 112
  let (src2, mut dst2) = create_test_buffer(STRIDE2 * H as usize);
  group.bench_function("strided_896_aligned", |b| {
    b.iter(|| {
      bgra_to_rgba_strided(black_box(&src2), black_box(&mut dst2), W2, H, STRIDE2, true);
    });
  });

  // Dirty-rect variants of the tmux crop pattern (union-of-crops send).
  let rect_cases: [(&str, u32, Rect); 4] = [
    (
      "rect_full_893",
      893,
      Rect {
        x: 0,
        y: 0,
        width: 893,
        height: 672,
      },
    ),
    (
      "rect_full_896",
      896,
      Rect {
        x: 0,
        y: 0,
        width: 896,
        height: 672,
      },
    ),
    (
      "rect_band_893",
      893,
      Rect {
        x: 0,
        y: 100,
        width: 893,
        height: 64,
      },
    ),
    (
      "rect_small_893",
      893,
      Rect {
        x: 350,
        y: 288,
        width: 192,
        height: 96,
      },
    ),
  ];
  for (name, image_width, rect) in rect_cases {
    let (src_r, _dst_r) = create_test_buffer(image_width as usize * H as usize * 4);
    let mut dst_r = vec![0u8; (rect.width * rect.height * 4) as usize];
    group.bench_function(name, |b| {
      b.iter(|| {
        bgra_to_rgba_rect(
          black_box(&src_r),
          black_box(&mut dst_r),
          black_box(image_width),
          black_box(rect),
        );
      });
    });
  }

  group.finish();
}

criterion_group!(
  benches,
  bench_bgra_to_rgba,
  bench_bgra_to_rgba_rect,
  bench_tmux_geometry
);
criterion_main!(benches);
