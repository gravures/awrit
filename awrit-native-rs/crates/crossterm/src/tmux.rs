//!# Tmux
//!
//! The `tmux` module provides functionnality to deal with tmux session.
//!

#[cfg(unix)]
use std::{char, env, fmt};

use crate::csi;
#[doc(no_inline)]
use crate::Command;

const ESC: char = '\x1B';
const TMUX_BEGIN: &str = "\x1BPtmux;";
const TMUX_END: &str = "\x1B\\";

#[cfg(all(unix, debug_assertions))]
pub fn log(message: &str) {
    use std::{fs::File, io::Write};

    const PATH: &str = "crossterm_tmux.log";
    let logging = File::options().append(true).create(true).open(PATH);
    let _ = logging.and_then(|mut file| file.write_fmt(format_args!("{}{}", message, "\n")));
}

/// Returns true if called inside a Tmux session, false otherwise.
#[cfg(unix)]
pub fn is_tmux() -> bool {
    let res = env::var_os("TMUX").is_some();

    #[cfg(debug_assertions)]
    log(&format!("is_tmux: {:?}", res));
    res
}

/// Escape a ansi sequence for tmux passthrough.
///
///
#[cfg(unix)]
pub fn tmux_escape(buffer: &str) -> String {
    _tmux_escape(buffer, "", "")
}

#[cfg(unix)]
fn _tmux_escape(buffer: &str, begin: &str, end: &str) -> String {
    let mut out = begin.to_string();
    for ch in buffer.chars() {
        if ch == ESC {
            out.push(ESC);
        }
        out.push(ch);
    }
    out.push_str(end);

    #[cfg(debug_assertions)]
    log(&out);
    out
}

/// A low level function
#[cfg(unix)]
pub fn tmux_passthrough(buffer: &[u8]) -> std::io::Result<Vec<u8>> {
    let str_ = String::from_utf8(buffer.to_vec()).map_err(|_| std::io::ErrorKind::InvalidData)?;
    Ok(_tmux_escape(&str_, TMUX_BEGIN, TMUX_END).into_bytes())
}

/// ?
#[cfg(unix)]
pub struct MaybeTmux {
    pub write: fn(),
}

impl MaybeTmux {
    pub fn new() -> Self {
        MaybeTmux {
            write: if is_tmux() {
                MaybeTmux::_write_tmux
            } else {
                MaybeTmux::_write
            },
        }
    }

    fn _write(sequence: &str) {
        //
    }

    fn _write_tmux(sequence: &str) {
        tmux_passthrough(sequence)
    }
}

/// A commands that request tmux to begin passthrough to terminal client.
///
/// See the [`tmux_escape`](tmux_escape.html) function.
///
/// # Notes
///
/// Commands must be executed/queued for execution otherwise they do nothing.
#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TmuxBeginPassthrough;

impl Command for TmuxBeginPassthrough {
    fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result {
        f.write_str(TMUX_BEGIN)
    }
}

///
/// A commands that request tmux to end passthrough to terminal client.
///
/// # Notes
///
/// Commands must be executed/queued for execution otherwise they do nothing.
#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TmuxEndPassthrough;

impl Command for TmuxEndPassthrough {
    fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result {
        f.write_str(TMUX_END)
    }
}

/// Different tmux extended-keys modes.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Ord, PartialOrd, Hash)]
pub enum TmuxMode {
    /// Withdraw extended-keys support.
    Standard,
    /// Changes the sequence for only keys which lack an existing well-known representation.
    Mode1,
    /// changes the sequence for all keys. If you ever want to play with mode2,
    /// keep in mind it encodes Ctrl+C, Ctrl+Z, Ctrl+L and such in a way the line
    /// discipline and shells don't understand (e.g. you will be unable to send
    /// SIGINT by hitting Ctrl+C).
    Mode2,
}

/// A command that request a tmux extended-keys mode.
///
/// Tmux has three settings for extended-keys support: `off`, `on` and `always`.
///
/// When tmux is configured as:
///  * set extended-keys off: this command will have no effect.
///  * set extended-keys on: it expects a program to actively request support
///    for mode1 or mode2 and it expects the program to possibly withdraw suuport
///    with requesting standard mode (e.g. when the program exits).
///  * set extended-keys always: a new tmux server will start in mode1, switching
///    to the standard mode forces mode1.
///
/// See the [`TmuxMode`](enum.ClearMode.html) enum.
///
/// # Notes
///
/// Commands must be executed/queued for execution otherwise they do nothing.
#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TmuxSetExtendedKeysMode(pub TmuxMode);

impl Command for TmuxSetExtendedKeysMode {
    fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result {
        f.write_str(match self.0 {
            TmuxMode::Standard => csi!(">4;0m"),
            TmuxMode::Mode1 => csi!(">4;1m"),
            TmuxMode::Mode2 => csi!(">4;2m"),
        })
    }
}
