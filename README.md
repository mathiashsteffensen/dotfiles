# Dotfiles

My personal dotfiles configuration for Bash, Pi, Ghostty, Zed, and Neovim.

## Overview

This repository contains my Bash configuration files and scripts to manage them across different machines. It follows the standard dotfiles pattern using symbolic links and separates machine-specific configurations from the shared ones.

## Files

### Standard Configuration Files
- `.bash_profile` - Login shell configuration
- `.bashrc` - Interactive shell configuration  
- `.bash_functions` - Custom helper functions
- `.gitconfig` - Git global configuration
- `.gitignore` - Global Git ignore patterns (installed as `~/.gitignore_global`)

### Local Configuration Files (not tracked by Git)
- `.bash_profile.local` - Machine-specific login shell settings
- `.bashrc.local` - Machine-specific interactive shell settings
- `.gitconfig.local` - Machine-specific Git user settings

### Application Configuration
- `config/ghostty/config` - Ghostty terminal settings
- `config/zed/settings.json` - Zed editor settings
- `config/nvim/` - Neovim settings and pinned plugin versions

### Pi Configuration
- `config/pi/agent/settings.json` - Global Pi settings
- `config/pi/agent/models.json` - Custom Pi model providers
- `config/pi/agent/APPEND_SYSTEM.md` - Global appended system instructions
- `git:github.com/DietrichGebert/ponytail@v4.9.0` - Ponytail package with always-on minimal-code guidance and six skills/commands
- `config/pi/agent/extensions/ask-user-question.ts` - Structured clarification questions with single- and multi-select support
- `config/pi/agent/extensions/auto-approve/` - Custom auto-approve extension source
- `config/pi/agent/extensions/usage-display/` - Model-aware Codex subscription and OpenRouter budget usage status
- `config/pi/agent/extensions/notify.ts` - Terminal notification when an agent settles
- `config/pi/agent/extensions/plan-mode/` - Read-only planning with trusted exploration tools and tracked execution
- `config/pi/agent/extensions/subagent/` - Local fresh-context delegation and live split-pane dashboard
- `config/pi/agent/extensions/openai-priority.ts` - Always request priority service for OpenAI Codex models and show a Fast mode footer indicator
- `config/pi/agent/extensions/ui-review/` - `/ux-review`, reusable manual login state, browser screenshots, and automated axe accessibility audits
- `config/pi/agent/extensions/linear/` - Linear team and issue tools; requires `LINEAR_API_KEY`

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
* Pi agent harness
* Ghostty terminal
* Go compiler and `gopls`
* `rbenv`, `ruby-build`, and the latest stable Ruby
* Ruby LSP via RubyGems
* lazygit
* lazysql
* Zed and Neovim text editors
* Node.js runtime
* Neovim language servers for JavaScript/TypeScript, Terraform, Dockerfiles, HTML/CSS/JSON, YAML, and Helm
* Terraform and Helm CLIs, Prettier, and ripgrep

The installer links Ghostty, Zed, and Neovim settings under `${XDG_CONFIG_HOME:-$HOME/.config}`. It installs `rbenv`, `ruby-build`, and the latest stable Ruby known to `ruby-build`, then selects it as rbenv’s global default. Zed is configured to automatically install its Ruby and Terraform extensions; TypeScript and Go support are built in. The installer also installs `gopls`, `ruby-lsp`, RuboCop, and a standalone `terraform-ls` for Neovim. It links Pi configuration into `~/.pi/agent` (or the directory set by `PI_CODING_AGENT_DIR`); Pi installs the pinned packages in that configuration on startup. Existing files and directories are backed up as `.bak` (or `.bak.1`, `.bak.2`, etc. when needed) before being replaced with symbolic links.

Ghostty notifications require `desktop-notifications = true` (configured here) and notifications enabled for Ghostty in macOS System Settings. To test the terminal independently of Pi, run this while Ghostty is unfocused:
```bash
sleep 3; printf '\033]777;notify;Ghostty Test;OSC 777 is working\007'
```

### Neovim

Run `nvim .` from a project directory. Zed remains installed and is still the shell/Git default editor. Neovim uses [Ayu Dark](https://github.com/Shatur/neovim-ayu), matching Zed's theme; font and font size come from Ghostty.

Requires Neovim 0.11.3+ and TypeScript 7+ (which includes the native `tsc --lsp` server). The installer adds missing tools but does not upgrade existing ones; use `brew upgrade neovim typescript` if needed. On first launch, [lazy.nvim](https://lazy.folke.io/) downloads the plugins; this needs internet access. Plugin revisions are tracked in `config/nvim/lazy-lock.json`. Use `:Lazy restore` after pulling changes to restore those revisions, or `:Lazy update` to deliberately update them and the lockfile.

Language support uses Neovim's built-in LSP client with [nvim-lspconfig](https://github.com/neovim/nvim-lspconfig), Blink completion, and [Conform](https://github.com/stevearc/conform.nvim) for format-on-save:

| Language | Language server | Save formatter |
| --- | --- | --- |
| Ruby | `ruby-lsp` + `rubocop --lsp` | RuboCop safe autocorrection |
| Go | `gopls` | `gofmt` |
| JavaScript / TypeScript / JSX / TSX | TypeScript 7's native `tsc` | Prettier |
| Terraform | `terraform-ls` | `terraform fmt` |
| Dockerfile | `docker-langserver` | None |
| HTML / CSS / JSON | VS Code language servers | Prettier |
| YAML / Helm values | `yaml-language-server` | Prettier |
| Helm templates | `helm_ls` | Disabled to protect template syntax |

Ruby executables come from the active rbenv version, without a `bundle exec` wrapper, matching Zed's launch behavior. Install `ruby-lsp` and `rubocop` for each Ruby version you use. Ruby LSP can manage its own bundle internally. RuboCop alone owns Ruby linting and save formatting to avoid duplicate diagnostics/formatters. Prettier prefers a project's local installation when available. Helm file associations preserve Zed's `templates/**/*.tpl`, `templates/**/*.yaml`, and `templates/**/*.yml` patterns.

Core Vim motions and editing commands are retained. These shortcuts add IDE features (`Space` is the leader):

| Keys | Action |
| --- | --- |
| `Space ff` / `Space fg` / `Space fb` | Find files / search project text / switch buffers |
| `gd` / `gr` / `K` | Definition / references / documentation (with LSP attached) |
| `Space rn` / `Space ca` | Rename symbol / code action |
| `Space e` / `[d` / `]d` | Diagnostic details / previous / next diagnostic |
| `Ctrl-n` / `Ctrl-p` / `Ctrl-y` / `Ctrl-e` | Next / previous / accept / dismiss completion |

Searches use the current working directory, so launch Neovim from the project root. `:Explore` opens the built-in file browser. `:Tutor` starts the interactive Vim tutorial; `:checkhealth vim.lsp` and `:ConformInfo` diagnose language servers and formatters. No Nerd Font, tmux, or GUI is required. Filetype syntax highlighting uses Neovim's runtime plus `vim-helm`; there is no Treesitter parser installation to maintain.

Checks: `bash tests/shell.test.sh`, `bash tests/install.test.sh`, and `bash tests/nvim.test.sh`. The Neovim smoke test uses isolated temporary config/data, downloads the pinned plugins, and requires the installed language tooling.

### Linear setup

Run `/linear-login` in an interactive Pi session. It opens [Linear Security & Access](https://linear.app/settings/account/security), prompts for the key, and stores it in macOS Keychain. The key is never stored in this repository. For manual setup, add it to the ignored `.bash_profile.local` file:

```bash
export LINEAR_API_KEY="lin_api_..."
```

Reload Pi with `/reload` after installing the extension. It provides Linear team/issue tools; mutating calls are checked by auto-approve instead of using a second confirmation prompt.

This configuration includes custom extensions to:
* Ask structured clarification questions with selectable options, free-text answers, and working multi-select support
* Classify Bash, sensitive/out-of-project edits and writes, and outbound research with an auto-approve LLM using complete arguments. Ordinary in-project edits/writes and local reads bypass classification; the edit/write path check is not OS containment. Routine research is implicitly authorized, while secret leakage and remote mutations remain checked
* Display weekly Codex subscription usage or OpenRouter budget usage for the selected provider, refreshing every minute and when the agent settles
* Send a terminal notification when an agent is ready for input
* Provide plan mode with trusted built-in read/navigation tools, structured questions in the TUI, and Bash under auto-approve's read-only, network-denied macOS sandbox. Writes, subagents, and Bash escalation are blocked while planning; execution requires reviewing and confirming the full plan (immediately or later with `/plan execute`). This protects agent tool calls, not user-initiated shell commands or sensitive reads
* Run up to three fresh-context local Pi children with `subagent({ action: "run", agent, task })` or a `tasks` array. Roles: scout, reviewer, oracle, worker (requires `editBoundary`; one writer per working directory). Use `background: true` to continue working, `action: "status"`/`"stop"` to inspect/control runs, and `/subagents` or Ctrl+Alt+F for the live split-pane dashboard. The persistent status lists active roles; panes show bounded tool-call arguments. Children load only the local auto-approve extension; calls requiring human confirmation are denied in headless children. Runs are session-scoped with a 30-minute timeout and are stopped on orderly shutdown; a parent crash can leave a child running. The worker edit boundary is an instruction, not an OS-enforced restriction
* Request priority service for all OpenAI Codex models (no model list or toggle)
* Review rendered web UIs with screenshots and automated axe accessibility audits
* Apply Ponytail’s minimal-code guidance and provide its six skills/commands

## Pi Usage Budget

The usage footer switches automatically with the selected model: Codex shows weekly subscription usage; OpenRouter shows the API key's spend against a configurable USD budget. Other providers hide the status.

Edit `config/pi/agent/extensions/usage-display/config.json` (linked to `~/.pi/agent/extensions/usage-display/config.json`):

```json
{
  "openrouter": {
    "limit": 50,
    "period": "monthly"
  }
}
```

`limit` must be a positive number; `period` accepts `daily`, `weekly`, or `monthly`. Each is the current UTC calendar period (weeks run Monday–Sunday), not a rolling window. Changes take effect on the next refresh. This is a display-only budget, not a change to OpenRouter's enforced API-key limit. Percentages can exceed 100% if you exceed the configured display budget.

Usage comes from OpenRouter's [current-key endpoint](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key), using Pi's existing OpenRouter credentials. It includes all OpenRouter-credit spending on that key, not just this Pi session, plus BYOK spending when the key's `include_byok_in_limit` setting is enabled. Missing usage or request/configuration errors show `unavailable` rather than 0%.

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
