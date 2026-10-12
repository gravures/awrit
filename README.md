I no longer have time to maintain my hobby projects and with the rising number of security issues, I would advise you to look at a more actively maintained fork.

If you use macOS you might enjoy using [cmux](https://github.com/manaflow-ai/cmux) as a replacement for awrit.

---

# Actual Web Rendering in Terminal

Or just `awrit`.

[awrit-demo.webm](https://github.com/user-attachments/assets/5da3fffc-d781-4b00-9fe3-19ce18d01a7e)

Yep, actual Chromium being rendered in your favorite terminal that supports the [Kitty terminal graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/).

**`awrit` works best in [Kitty v0.31 or newer](https://github.com/kovidgoyal/kitty/releases)**

## Why?

- Display documentation from [DevDocs](https://devdocs.io)
- Watch the changes from [Vite](https://vitejs.dev) come to life
- Tiled layout without a tiling window manager using [Kitty's layouts](https://sw.kovidgoyal.net/kitty/layouts/)
- Add fancy UI using web technologies, so NeoVim can pretend it is Emacs instead of the other way around

## Usage

```bash
awrit [url]

# if url is not provided, it will go to the awrit homepage (this is temporary, promise)
# the URL protocol can be http:, https:, or data:
# if the URL protocol is not included, https: is used by default
```

### Ghostty and tmux

This fork includes the native tmux renderer adapted from
[`marromlam/awrit:add-tmux-support`](https://github.com/marromlam/awrit/tree/add-tmux-support).
Awrit now remains inside the pane that launched it instead of opening another
terminal window. It requires tmux 3.4 or newer with graphics passthrough and
mouse input enabled:

```tmux
set -gq allow-passthrough on
set -g mouse on
```

`awrit` temporarily promotes only its own pane to `allow-passthrough all`
while it is running, which lets the native renderer clean up its exact image
IDs even if the pane is hidden. It restores the pane's previous value on exit;
other panes remain on the safer global `on` setting. If pointer coordinates are
detected incorrectly, set
`AWRIT_TMUX_MOUSE_COORDS=cell` or `AWRIT_TMUX_MOUSE_COORDS=pixel` explicitly.

Awrit's tmux behaviour is covered by automated tests that run without a real
tmux session (`bun test`). They check that awrit stays in the pane it was
launched from and restores that pane's `allow-passthrough` value when it exits.

For more options look at the help:

```bash
awrit --help
```

## Configuration

`awrit` is configured with a single `config.toml`, looked up in this order:

1. `--config <path>`
2. `./config.toml` in the current directory
3. `$XDG_CONFIG_HOME/awrit/config.toml` (usually `~/.config/awrit/config.toml`)

If none exists, awrit writes the default file to `~/.config/awrit/config.toml` the first
time it starts, so there is nothing to set up. Edits are picked up while awrit runs; a
broken edit keeps the last good config and the reason goes to the log
(`$XDG_STATE_HOME/awrit/awrit.log`, usually `~/.local/state/awrit/awrit.log`).

The file is plain data — no JavaScript is ever executed from it:

```toml
# Page shown when no URL is given.
homepage = "https://duckduckgo.com"

# Pane pixels divided by this is the bitmap Electron renders; 1 = 1:1 with the
# pane. 2 = quarter of the pixels (larger text, softer edges).
rasterScale = 1

# GPU shared-texture paint path for the fallback renderer (Ghostty outside tmux).
sharedTexture = true

[keybindings]
"<C-r>" = "refresh"
"<Cmd-f>" = "find" # Cmd on macOS, Ctrl elsewhere
```

Available actions: `back`, `forward`, `refresh`, `find`, `select-all`, `zoom-in`,
`zoom-out`, `zoom-reset`, `copy`, `paste`, `diagnostic-copy`, `quit`.

Key sequence syntax: `<C-x>` ctrl, `<A-x>` alt, `<S-x>` shift, `<M-x>` meta,
`<Cmd-x>` Command on macOS and Ctrl elsewhere, `<Super-x>` the super/Windows key —
so one file expresses the same intent on both platforms. Multi-key sequences like
`<C-w>l` work as well. The shipped defaults live in `config.toml` and are generated
from `src/config.ts`, which also documents every option.

## Contributing

See [Contributing to Awrit](/CONTRIBUTING.md#contributing-to-awrit).

## Development

Assuming you already have `git` installed, your installation of `awrit` will already be a Git repository.

You can update `awrit` to use your fork by changing the origin:

``` bash
# note: you'll have to change the username some-kind-contributor to your GitHub username
git remote set-url origin git@github.com:some-kind-contributor/awrit.git
# also track the upstream electron branch
git remote add upstream -f -t electron git@github.com:chase/awrit.git
```

You can make a branch (ex: my-feature-branch) off the latest changes by doing:

```
git fetch upstream electron
git checkout upstream/electron
git switch -c 'my-feature-branch'
```

Read [Your First Code Contribution](/CONTRIBUTING.md#your-first-code-contribution) for more information on making a PR.
