use crossterm::event::{
  poll, read, Event, KeyCode, KeyModifiers, KittyGraphicsOkOrError, MediaKeyCode, ModifierKeyCode,
  MouseButton, MouseEventKind, Sequence,
};
use napi::{
  bindgen_prelude::*, threadsafe_function::ThreadsafeFunctionCallMode, Env, Result, Status,
};
use std::{
  sync::atomic::{AtomicBool, Ordering},
  time::Duration,
};

static QUIT: AtomicBool = AtomicBool::new(false);

#[napi(object)]
pub struct TermEvent {
  #[napi(ts_type = "'key' | 'mouse' | 'focus' | 'resize' | 'paste' | 'escape' | 'graphics'")]
  pub event_type: String,
  pub key_event: Option<KeyEvent>,
  pub mouse_event: Option<MouseEvent>,
  pub focus_gained: Option<bool>,
  pub focus_lost: Option<bool>,
  pub resize: Option<TermResize>,
  pub paste: Option<String>,
  pub escape: Option<TermEscape>,
  pub graphics: Option<KittyGraphics>,
}

#[napi(object)]
pub struct KeyEvent {
  /// Key code in Electron accelerator format (lowercase)
  pub code: String,
  /// Array of modifier strings in Electron accelerator format
  #[napi(
    ts_type = "('ctrl' | 'alt' | 'shift' | 'meta' | 'capsLock' | 'numLock' | 'left' | 'right' | 'isAutoRepeat')[]"
  )]
  pub modifiers: Vec<String>,
  /// True for keydown and repeat events, false for keyup
  pub down: bool,
  /// True for keys that should have an Electron char event
  pub is_char_event: bool,
}

#[napi(object)]
pub struct MouseEvent {
  #[napi(
    ts_type = "'mouseDown' | 'mouseUp' | 'mouseMove' | 'scrollUp' | 'scrollDown' | 'scrollLeft' | 'scrollRight'"
  )]
  pub kind: String,
  #[napi(ts_type = "'left' | 'middle' | 'right' | 'fourth' | 'fifth' | null")]
  pub button: Option<String>,
  pub x: u16,
  pub y: u16,
  /// Array of modifier strings in Electron accelerator format
  #[napi(ts_type = "('ctrl' | 'alt' | 'shift')[]")]
  pub modifiers: Vec<String>,
}

#[napi(object)]
#[derive(Debug)]
pub struct TermResize {
  pub columns: u16,
  pub rows: u16,
}

#[napi(object)]
#[derive(Debug)]
pub struct TermEscape {
  #[napi(ts_type = "'osc' | 'apc' | 'dcs' | 'pm'")]
  pub kind: String,
  pub text: String,
}

#[napi(object)]
#[derive(Debug)]
pub struct KittyGraphics {
  pub id: String,
  pub status: String,
}

impl From<Event> for TermEvent {
  fn from(event: Event) -> Self {
    match event {
      Event::Key(key) => {
        let (code, is_char_event, left_right) = translate_key_code(&key.code);
        let mut mod_vec = Vec::new();
        let mods = key.modifiers;

        // Convert modifier bits to strings
        if mods.contains(KeyModifiers::CONTROL) {
          mod_vec.push("ctrl".to_string());
        }
        if mods.contains(KeyModifiers::ALT) {
          mod_vec.push("alt".to_string());
        }
        if mods.contains(KeyModifiers::SHIFT) {
          mod_vec.push("shift".to_string());
        }
        if mods.contains(KeyModifiers::META) {
          mod_vec.push("meta".to_string());
        }
        if mods.contains(KeyModifiers::CAPS_LOCK) {
          mod_vec.push("capsLock".to_string());
        }
        if mods.contains(KeyModifiers::NUM_LOCK) {
          mod_vec.push("numLock".to_string());
        }

        // Add left/right modifiers if present
        if let Some(side) = left_right {
          mod_vec.push(side.to_string());
        }

        // Add isautorepeat for repeat events
        let down = match key.kind {
          crossterm::event::KeyEventKind::Press | crossterm::event::KeyEventKind::Repeat => true,
          crossterm::event::KeyEventKind::Release => false,
        };
        if matches!(key.kind, crossterm::event::KeyEventKind::Repeat) {
          mod_vec.push("isAutoRepeat".to_string());
        }

        TermEvent {
          event_type: "key".to_string(),
          key_event: Some(KeyEvent {
            code,
            modifiers: mod_vec,
            down,
            is_char_event,
          }),
          mouse_event: None,
          focus_gained: None,
          focus_lost: None,
          resize: None,
          paste: None,
          escape: None,
          graphics: None,
        }
      }
      Event::Mouse(mouse) => {
        let mut mod_vec = Vec::new();
        let mods = mouse.modifiers;

        // Convert modifier bits to strings
        if mods.contains(KeyModifiers::CONTROL) {
          mod_vec.push("ctrl".to_string());
        }
        if mods.contains(KeyModifiers::ALT) {
          mod_vec.push("alt".to_string());
        }
        if mods.contains(KeyModifiers::SHIFT) {
          mod_vec.push("shift".to_string());
        }

        // Convert MouseEventKind to string and extract button
        let (kind, button) = match mouse.kind {
          MouseEventKind::Down(btn) => (
            "mouseDown",
            Some(match btn {
              MouseButton::Left => "left",
              MouseButton::Middle => "middle",
              MouseButton::Right => "right",
              MouseButton::Fourth => "fourth",
              MouseButton::Fifth => "fifth",
            }),
          ),
          MouseEventKind::Up(btn) => (
            "mouseUp",
            Some(match btn {
              MouseButton::Left => "left",
              MouseButton::Middle => "middle",
              MouseButton::Right => "right",
              MouseButton::Fourth => "fourth",
              MouseButton::Fifth => "fifth",
            }),
          ),
          MouseEventKind::Drag(btn) => (
            "mouseMove",
            Some(match btn {
              MouseButton::Left => "left",
              MouseButton::Middle => "middle",
              MouseButton::Right => "right",
              MouseButton::Fourth => "fourth",
              MouseButton::Fifth => "fifth",
            }),
          ),
          MouseEventKind::Moved => ("mouseMove", None),
          MouseEventKind::ScrollUp => ("scrollUp", None),
          MouseEventKind::ScrollDown => ("scrollDown", None),
          MouseEventKind::ScrollLeft => ("scrollLeft", None),
          MouseEventKind::ScrollRight => ("scrollRight", None),
        };

        TermEvent {
          event_type: "mouse".to_string(),
          key_event: None,
          mouse_event: Some(MouseEvent {
            kind: kind.to_string(),
            button: button.map(|s| s.to_string()),
            x: mouse.x,
            y: mouse.y,
            modifiers: mod_vec,
          }),
          focus_gained: None,
          focus_lost: None,
          resize: None,
          paste: None,
          escape: None,
          graphics: None,
        }
      }
      Event::FocusGained => TermEvent {
        event_type: "focus".to_string(),
        key_event: None,
        mouse_event: None,
        focus_gained: Some(true),
        focus_lost: None,
        resize: None,
        paste: None,
        escape: None,
        graphics: None,
      },
      Event::FocusLost => TermEvent {
        event_type: "focus".to_string(),
        key_event: None,
        mouse_event: None,
        focus_gained: None,
        focus_lost: Some(true),
        resize: None,
        paste: None,
        escape: None,
        graphics: None,
      },
      Event::Resize(columns, rows) => TermEvent {
        event_type: "resize".to_string(),
        key_event: None,
        mouse_event: None,
        focus_gained: None,
        focus_lost: None,
        resize: Some(TermResize { columns, rows }),
        paste: None,
        escape: None,
        graphics: None,
      },
      Event::Paste(text) => TermEvent {
        event_type: "paste".to_string(),
        key_event: None,
        mouse_event: None,
        focus_gained: None,
        focus_lost: None,
        resize: None,
        paste: Some(text),
        escape: None,
        graphics: None,
      },
      Event::Escape(sequence) => {
        let (kind, text) = match sequence {
          Sequence::Osc(text) => ("osc", text),
          Sequence::Apc(text) => ("apc", text),
          Sequence::Dcs(text) => ("dcs", text),
          Sequence::Pm(text) => ("pm", text),
        };
        TermEvent {
          event_type: "escape".to_string(),
          key_event: None,
          mouse_event: None,
          focus_gained: None,
          focus_lost: None,
          resize: None,
          paste: None,
          escape: Some(TermEscape {
            kind: kind.to_string(),
            text,
          }),
          graphics: None,
        }
      }
      Event::KittyGraphics(data, status) => TermEvent {
        event_type: "graphics".to_string(),
        key_event: None,
        mouse_event: None,
        focus_gained: None,
        focus_lost: None,
        resize: None,
        paste: None,
        escape: None,
        graphics: Some(KittyGraphics {
          id: data,
          // The protocol's own status text, not the Debug form: JS matches
          // "OK" to decide the terminal consumed the frame, and "Ok" never
          // matches.
          status: match status {
            KittyGraphicsOkOrError::Ok => "OK".to_string(),
            KittyGraphicsOkOrError::Error(e) if e.is_empty() => "NONE".to_string(),
            KittyGraphicsOkOrError::Error(e) => e,
          },
        }),
      },
    }
  }
}

fn translate_key_code(code: &KeyCode) -> (String, bool, Option<&str>) {
  let (code, is_char_event, left_right) = match code {
    KeyCode::Backspace => ("backspace", false, None),
    KeyCode::Enter => ("return", true, None),
    KeyCode::Left => ("left", false, None),
    KeyCode::Right => ("right", false, None),
    KeyCode::Up => ("up", false, None),
    KeyCode::Down => ("down", false, None),
    KeyCode::Home => ("home", false, None),
    KeyCode::End => ("end", false, None),
    KeyCode::PageUp => ("pageup", false, None),
    KeyCode::PageDown => ("pagedown", false, None),
    KeyCode::Tab => ("tab", false, None),
    KeyCode::BackTab => ("tab", false, None),
    KeyCode::Delete => ("delete", false, None),
    KeyCode::Insert => ("insert", false, None),
    KeyCode::F(n) => return (format!("f{n}"), false, None),
    KeyCode::Char(c) => {
      if *c == ' ' {
        return ("space".to_string(), true, None);
      }
      return (c.to_string(), true, None);
    }
    KeyCode::Esc => ("escape", false, None),
    KeyCode::CapsLock => ("capslock", false, None),
    KeyCode::ScrollLock => ("scrolllock", false, None),
    KeyCode::NumLock => ("numlock", false, None),
    KeyCode::PrintScreen => ("printscreen", false, None),
    KeyCode::Pause => ("pause", false, None),
    KeyCode::Menu => ("menu", false, None),
    KeyCode::KeypadBegin => ("clear", false, None),
    KeyCode::Null => ("", false, None),
    KeyCode::Media(media) => match media {
      MediaKeyCode::Play => ("mediaplay", false, None),
      MediaKeyCode::Pause => ("mediapause", false, None),
      MediaKeyCode::PlayPause => ("mediaplaypause", false, None),
      MediaKeyCode::Reverse => ("mediareverse", false, None),
      MediaKeyCode::Stop => ("mediastop", false, None),
      MediaKeyCode::FastForward => ("mediafastforward", false, None),
      MediaKeyCode::Rewind => ("mediarewind", false, None),
      MediaKeyCode::TrackNext => ("medianexttrack", false, None),
      MediaKeyCode::TrackPrevious => ("mediaprevioustrack", false, None),
      MediaKeyCode::Record => ("mediarecord", false, None),
      MediaKeyCode::LowerVolume => ("volumedown", false, None),
      MediaKeyCode::RaiseVolume => ("volumeup", false, None),
      MediaKeyCode::MuteVolume => ("volumemute", false, None),
    },
    KeyCode::Modifier(modifier) => match modifier {
      ModifierKeyCode::LeftShift => ("shift", false, Some("left")),
      ModifierKeyCode::RightShift => ("shift", false, Some("right")),
      ModifierKeyCode::LeftControl => ("control", false, Some("left")),
      ModifierKeyCode::RightControl => ("control", false, Some("right")),
      ModifierKeyCode::LeftAlt => ("alt", false, Some("left")),
      ModifierKeyCode::RightAlt => ("alt", false, Some("right")),
      ModifierKeyCode::LeftSuper => ("super", false, Some("left")),
      ModifierKeyCode::RightSuper => ("super", false, Some("right")),
      ModifierKeyCode::LeftMeta => ("meta", false, Some("left")),
      ModifierKeyCode::RightMeta => ("meta", false, Some("right")),
      _ => ("", false, None),
    },
  };
  (code.to_string(), is_char_event, left_right)
}

#[napi(ts_return_type = "() => void")]
pub fn listen_for_input<'a>(
  env: &'a Env,
  callback: Function<TermEvent, ()>,
  wait_ms: Option<i32>,
) -> Result<Function<'a, (), ()>> {
  // Convert the JavaScript callback into a threadsafe function
  let tsfn = callback.build_threadsafe_function().build().map_err(|e| {
    napi::Error::from_reason(format!("Failed to create threadsafe function: {}", e))
  })?;

  // Reset the quit flag
  QUIT.store(false, Ordering::SeqCst);

  // Get wait duration (default 10ms)
  let wait = wait_ms.unwrap_or(10);

  // Spawn the input polling thread
  std::thread::spawn({
    move || {
      while !QUIT.load(Ordering::SeqCst) {
        match poll(Duration::from_millis(wait as u64)) {
          Ok(true) => {
            if let Ok(event) = read() {
              let js_event = TermEvent::from(event);
              let status = tsfn.call(js_event, ThreadsafeFunctionCallMode::NonBlocking);
              if status != Status::Ok {
                break;
              }
            }
          }
          Ok(_) => continue,
          Err(_) => break,
        }
      }
    }
  });

  // Return cleanup function
  env.create_function_from_closure("cleanup", move |_| {
    QUIT.store(true, Ordering::SeqCst);
    Ok(())
  })
}
