use crossterm::{
  event::{
    DisableBracketedPaste, DisableFocusChange, DisableMouseCapture, EnableBracketedPaste,
    EnableFocusChange, EnableMouseCapture, KeyboardEnhancementFlags, PopKeyboardEnhancementFlags,
    PushKeyboardEnhancementFlags,
  },
  execute, queue,
  style::Print,
  terminal::{
    disable_raw_mode, enable_raw_mode, query_kitty_graphics_support, supports_keyboard_enhancement,
    window_size,
  },
  tmux::{
    tmux_escape, TmuxBeginPassthrough, TmuxEndPassthrough, TmuxMode, TmuxSetExtendedKeysMode,
  },
  Command,
};
use std::sync::Mutex;
use std::time::Instant;

#[napi(object)]
pub struct SupportedFeatures {
  pub keyboard: bool,
  pub images: bool,
  pub load_frame: bool,
  pub composite_frame: bool,
}

#[napi(object)]
#[derive(Copy, Clone)]
pub struct WindowSize {
  pub cols: u16,
  pub rows: u16,
  pub width: u16,
  pub height: u16,
}

#[napi]
/// Enable features for the terminal that are necessary for Awrit
pub fn term_enable_features() -> napi::Result<SupportedFeatures> {
  enable_raw_mode().map_err(|e| napi::Error::from_reason(e.to_string()))?;

  let mut stdout = std::io::stdout();

  if crossterm::tmux::is_tmux() {
    #[cfg(debug_assertions)]
    crossterm::tmux::log("Setting tmux extended-keys to <mode1>");
    execute!(stdout, TmuxSetExtendedKeysMode(TmuxMode::Mode1))?;
  }

  // TODO: check if this is actually needed? It could potentially block the event loop for 200ms
  let keyboard =
    supports_keyboard_enhancement().map_err(|e| napi::Error::from_reason(e.to_string()))?;

  let graphics =
    query_kitty_graphics_support().map_err(|e| napi::Error::from_reason(e.to_string()))?;

  if keyboard {
    queue!(
      stdout,
      PushKeyboardEnhancementFlags(
        KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
          | KeyboardEnhancementFlags::REPORT_ALL_KEYS_AS_ESCAPE_CODES
          | KeyboardEnhancementFlags::REPORT_ALTERNATE_KEYS
          | KeyboardEnhancementFlags::REPORT_EVENT_TYPES
      )
    )?;
  }

  execute!(
    stdout,
    EnableBracketedPaste,
    EnableFocusChange,
    EnableMouseCapture,
  )?;

  Ok(SupportedFeatures {
    keyboard,
    images: graphics.images,
    load_frame: graphics.load_frame,
    composite_frame: graphics.composite_frame,
  })
}

#[napi]
/// Disable previously enabled features for the terminal that are necessary for Awrit
pub fn term_disable_features(features: SupportedFeatures) -> napi::Result<()> {
  let mut stdout = std::io::stdout();

  execute!(
    stdout,
    DisableBracketedPaste,
    DisableFocusChange,
    DisableMouseCapture
  )?;

  if features.keyboard {
    execute!(stdout, PopKeyboardEnhancementFlags)?;
  }

  if crossterm::tmux::is_tmux() {
    #[cfg(debug_assertions)]
    crossterm::tmux::log("Resetting tmux extended-keys to <standard mode>");
    execute!(stdout, TmuxSetExtendedKeysMode(TmuxMode::Standard))?;
  }

  disable_raw_mode().map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
/// Get the current terminal window size
pub fn get_window_size() -> napi::Result<WindowSize> {
  let size = window_size().map_err(|e| napi::Error::from_reason(e.to_string()))?;

  Ok(WindowSize {
    cols: size.columns,
    rows: size.rows,
    width: size.width,
    height: size.height,
  })
}

static TMUX_PANE_CACHE: Mutex<Option<(WindowSize, Instant)>> = Mutex::new(None);

const TMUX_PANE_CACHE_TTL_MS: u128 = 250;

#[napi]
/// Get tmux pane size with 250ms caching. Falls back to regular window_size if not in tmux.
pub fn get_tmux_pane_size() -> napi::Result<WindowSize> {
  let in_tmux = std::env::var("TMUX").is_ok();

  if !in_tmux {
    return get_window_size();
  }

  // Check cache
  {
    let cache = TMUX_PANE_CACHE.lock().map_err(|e| napi::Error::from_reason(e.to_string()))?;
    if let Some((size, ts)) = *cache {
      if ts.elapsed().as_millis() < TMUX_PANE_CACHE_TTL_MS {
        return Ok(size);
      }
    }
  }

  // Query tmux
  let output = std::process::Command::new("tmux")
    .args(["display-message", "-p", "#{pane_width} #{pane_height}"])
    .output()
    .map_err(|e| napi::Error::from_reason(format!("Failed to run tmux: {}", e)))?;

  let stdout = String::from_utf8_lossy(&output.stdout);
  let parts: Vec<&str> = stdout.trim().split_whitespace().collect();
  if parts.len() < 2 {
    return Err(napi::Error::from_reason(format!("Invalid tmux output: {}", stdout)));
  }

  let cols: u16 = parts[0]
    .parse()
    .map_err(|e| napi::Error::from_reason(format!("Invalid cols: {}", e)))?;
  let rows: u16 = parts[1]
    .parse()
    .map_err(|e| napi::Error::from_reason(format!("Invalid rows: {}", e)))?;

  let size = WindowSize {
    cols,
    rows,
    width: 0,
    height: 0,
  };

  // Update cache
  {
    let mut cache = TMUX_PANE_CACHE.lock().map_err(|e| napi::Error::from_reason(e.to_string()))?;
    *cache = Some((size, Instant::now()));
  }

  Ok(size)
}

#[napi]
/// Returns true if called inside a Tmux session, false otherwise.
pub fn is_tmux() -> bool {
  crossterm::tmux::is_tmux()
}

#[napi]
/// Send the given sequence directly to the client terminal passing through tmux
pub fn passthrough_tmux(sequence: String) -> napi::Result<()> {
  execute!(
    std::io::stdout(),
    TmuxBeginPassthrough,
    Print(tmux_escape(&sequence)),
    TmuxEndPassthrough,
  )
  .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn write_maybe_tmux(sequence: String) -> napi::Result<()> {
  if is_tmux() {
    passthrough_tmux(sequence)
  } else {
    execute!(std::io::stdout(), Print(&sequence))
      .map_err(|e| napi::Error::from_reason(e.to_string()))
  }
}

#[cfg(debug_assertions)]
#[napi]
pub fn log(message: String) {
  crossterm::tmux::log(&message);
}

#[napi]
/// Returns the DCS sequence to begin tmux passthrough
pub fn tmux_begin_passthrough() -> String {
  let mut s = String::new();
  TmuxBeginPassthrough.write_ansi(&mut s).unwrap();
  s
}

#[napi]
/// Returns the DCS sequence to end tmux passthrough
pub fn tmux_end_passthrough() -> String {
  let mut s = String::new();
  TmuxEndPassthrough.write_ansi(&mut s).unwrap();
  s
}

#[napi]
/// Wrap a string with tmux passthrough DCS sequences, escaping ESC characters
pub fn tmux_passthrough(buffer: String) -> napi::Result<String> {
  Ok(tmux_escape(&buffer))
}

#[napi]
/// Wrap a sequence with tmux passthrough DCS sequences in one call
pub fn wrap_tmux_passthrough(sequence: String) -> String {
  let mut s = String::new();
  TmuxBeginPassthrough.write_ansi(&mut s).unwrap();
  s.push_str(&tmux_escape(&sequence));
  TmuxEndPassthrough.write_ansi(&mut s).unwrap();
  s
}

#[napi]
/// Returns the CSI sequence for the requested tmux extended-keys mode
pub fn tmux_set_extended_keys_mode(mode: String) -> napi::Result<String> {
  let m = match mode.as_str() {
    "standard" => TmuxMode::Standard,
    "mode1" => TmuxMode::Mode1,
    "mode2" => TmuxMode::Mode2,
    _ => return Err(napi::Error::from_reason(format!("Invalid mode: {}", mode))),
  };
  let mut s = String::new();
  TmuxSetExtendedKeysMode(m).write_ansi(&mut s).unwrap();
  Ok(s)
}
