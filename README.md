# Dotfiles

My personal dotfiles configuration for Bash, Ghostty, Kero, Zed, Neovim, gh-dash, and lazygit.

## Overview

This repository contains my Bash configuration files and scripts to manage them across different machines. It follows the standard dotfiles pattern using symbolic links and separates machine-specific configurations from the shared ones.

## Files

### Standard Configuration Files

- `.bash_profile` - Login shell configuration
- `.bashrc` - Interactive shell configuration
- `.bash_functions` - Custom helper functions
- `.inputrc` - Readline key bindings
- `.gitconfig` - Git global configuration
- `.gitignore` - Global Git ignore patterns (installed as `~/.gitignore_global`)

### Local Configuration Files (not tracked by Git)

- `.bash_profile.local` - Machine-specific login shell settings
- `.bashrc.local` - Machine-specific interactive shell settings
- `.gitconfig.local` - Machine-specific Git user settings

### Application Configuration

- `config/ghostty/config` - Ghostty terminal settings
- `config/kero/config` - Kero terminal settings
- `config/zed/settings.json` - Zed editor settings
- `config/nvim/` - Neovim settings and pinned plugin versions
- `config/gh-dash/config.yml` - gh-dash diff pager and keybindings for tuicr and ENHANCE
- `config/lazygit/config.yml` - lazygit diff pager and keybindings for tuicr, PR merge, and New tag

## Installation

1. Clone this repository to your home directory:

   ```bash
   cd ~
   git clone git@github.com:mathiashsteffensen/dotfiles.git
   ```

2. Run the install script:

   ```bash
   cd dotfiles
   ./install.sh
   ```

3. Open a new terminal or run:
   ```bash
   source ~/.bash_profile
   ```

The installer also installs the tooling I regularly use from the terminal during my development workflow:

- [JULIA coding harness](https://github.com/mathiashsteffensen/julia-cli), built from source
- Ghostty and Kero terminals
- Go compiler and `gopls`
- `rbenv`, `ruby-build`, and the latest stable Ruby
- Ruby LSP via RubyGems
- lazygit
- GitHub CLI (`gh`) with the gh-dash and gh-enhance extensions, delta, and tuicr for pull request review
- lazysql
- Zed and Neovim text editors
- Node.js runtime
- Neovim language servers for JavaScript/TypeScript, Terraform, Dockerfiles, HTML/CSS/JSON, YAML, and Helm
- Terraform and Helm CLIs, Prettier, and ripgrep

The installer links Ghostty, Kero, Zed, Neovim, and gh-dash settings under `${XDG_CONFIG_HOME:-$HOME/.config}`. It links lazygit settings into the directory that `lazygit --print-config-dir` reports; on macOS that is `~/Library/Application Support/lazygit` unless `XDG_CONFIG_HOME` is set. It installs `rbenv`, `ruby-build`, and the latest stable Ruby known to `ruby-build`, then selects it as rbenv’s global default. Zed is configured to automatically install its Ruby and Terraform extensions; TypeScript and Go support are built in. The installer also installs `gopls`, `ruby-lsp`, RuboCop, and a standalone `terraform-ls` for Neovim. Existing files and directories are backed up as `.bak` (or `.bak.1`, `.bak.2`, etc. when needed) before being replaced with symbolic links.

Kero's configuration enables a Tailscale listener on port 7373. By default, Kero permits connections from the Tailscale user who owns the machine; authorized connections can run programs as the local account.

When `julia` is missing from Go's bin directory, the installer clones julia-cli to `~/code/julia-cli`, or uses the checkout already there, and builds it with `go install ./cmd/julia`. After installation, run `julia doctor` to check the setup.

### Neovim

Run `nvim .` from a project directory. Zed remains installed and is still the shell/Git default editor. Neovim uses [Ayu Dark](https://github.com/Shatur/neovim-ayu), matching Zed's theme; font and font size come from Ghostty.

Requires Neovim 0.11.3+ and TypeScript 7+ (which includes the native `tsc --lsp` server). The installer adds missing tools but does not upgrade existing ones; use `brew upgrade neovim typescript` if needed. On first launch, [lazy.nvim](https://lazy.folke.io/) downloads the plugins; this needs internet access. Plugin revisions are tracked in `config/nvim/lazy-lock.json`. Use `:Lazy restore` after pulling changes to restore those revisions, or `:Lazy update` to deliberately update them and the lockfile.

Language support uses Neovim's built-in LSP client with [nvim-lspconfig](https://github.com/neovim/nvim-lspconfig), Blink completion, and [Conform](https://github.com/stevearc/conform.nvim) for format-on-save:

| Language                            | Language server              | Save formatter                      |
| ----------------------------------- | ---------------------------- | ----------------------------------- |
| Ruby                                | `ruby-lsp` + `rubocop --lsp` | RuboCop safe autocorrection         |
| Go                                  | `gopls`                      | `gofmt`                             |
| JavaScript / TypeScript / JSX / TSX | TypeScript 7's native `tsc`  | Prettier                            |
| Terraform                           | `terraform-ls`               | `terraform fmt`                     |
| Dockerfile                          | `docker-langserver`          | None                                |
| HTML / CSS / JSON                   | VS Code language servers     | Prettier                            |
| YAML / Helm values                  | `yaml-language-server`       | Prettier                            |
| Helm templates                      | `helm_ls`                    | Disabled to protect template syntax |

Ruby executables come from the active rbenv version, without a `bundle exec` wrapper, matching Zed's launch behavior. Install `ruby-lsp` and `rubocop` for each Ruby version you use. Ruby LSP can manage its own bundle internally. RuboCop alone owns Ruby linting and save formatting to avoid duplicate diagnostics/formatters. Prettier prefers a project's local installation when available. Helm file associations preserve Zed's `templates/**/*.tpl`, `templates/**/*.yaml`, and `templates/**/*.yml` patterns.

Vim editing commands are retained except `T`, which opens the Go or Ruby test file in normal mode. Zed also enables Vim mode and uses the same shortcut: `file.go` → `file_test.go`, and `app/path/file.rb` or `lib/path/file.rb` → `specs/path/file_test.rb`. Existing test files stay open. These shortcuts add IDE features (`Space` is the leader):

| Keys                                      | Action                                                      |
| ----------------------------------------- | ----------------------------------------------------------- |
| `Space ff` / `Space fg` / `Space fb`      | Find files / search project text / switch buffers           |
| `gd` / `gr` / `K`                         | Definition / references / documentation (with LSP attached) |
| `Space rn` / `Space ca`                   | Rename symbol / code action                                 |
| `Space e` / `[d` / `]d`                   | Diagnostic details / previous / next diagnostic             |
| `Ctrl-n` / `Ctrl-p` / `Ctrl-y` / `Ctrl-e` | Next / previous / accept / dismiss completion               |

Searches use the current working directory, so launch Neovim from the project root. `:Explore` opens the built-in file browser. `:Tutor` starts the interactive Vim tutorial; `:checkhealth vim.lsp` and `:ConformInfo` diagnose language servers and formatters. No Nerd Font, tmux, or GUI is required. Filetype syntax highlighting uses Neovim's runtime plus `vim-helm`; there is no Treesitter parser installation to maintain.

### Pull request review

Sign in once with `gh auth login`; gh-dash, tuicr, and ENHANCE all use that login. Run `gh dash` to see the pull requests that need your review. In the pull request list:

| Key | Action                                            |
| --- | ------------------------------------------------- |
| `T` | Review the selected PR in tuicr                   |
| `E` | Show the selected PR's checks and logs in ENHANCE |
| `d` | Show the selected PR's diff in delta              |

In tuicr, `c` comments on a line, `v` selects a range to comment on, and `:submit` posts all comments as one GitHub review: comment, approve, request changes, or draft. Quit tuicr to return to gh-dash. To skip the dashboard, run `tuicr pr <number>` in a checkout or `tuicr pr <url>` anywhere.

In ENHANCE, `h` and `l` move between the run, job, step, and log panes, and `/` searches the focused pane. `Ctrl-r` reruns the selected run or job, `o` opens the selection in the browser, and `?` lists all keys. Quit ENHANCE to return to gh-dash.

In lazygit, these keys act on the selected branch in the Local branches panel:

| Key      | Action                                                            |
| -------- | ----------------------------------------------------------------- |
| `T`      | Review the branch's PR in tuicr                                   |
| `Ctrl-m` | Merge the branch's PR with `gh pr merge`                          |
| `Ctrl-t` | New tag, moved from `T`; replaces the external diff tool key here |

The PR is the branch's open one, or else the most recent. Quit tuicr, then press Enter to return to lazygit. `Ctrl-m` asks for the merge method, which is also the confirmation; Esc cancels. It needs a terminal with the kitty keyboard protocol, such as Ghostty. In other terminals `Ctrl-m` is Enter; run the command from the `?` menu there.

## Local Configuration Management

To set up local configurations:

1. Copy any `.example` file to remove the `.example` extension
2. Customize the copied file with your machine-specific settings
3. Run the install script again to link the new files

## Structure

The configuration follows these conventions:

- Standard configs are tracked in Git
- Local configs are intentionally ignored by Git
- The install script handles backup and linking of existing files and directories
- Machine-specific overrides are loaded automatically

## Contributing

Feel free to fork and modify for your own use. If you find improvements, PRs are welcome!

## License

MIT
