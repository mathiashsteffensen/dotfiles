-- Keep Vim's editing keys; Space prefixes the few editor-specific shortcuts.
vim.g.mapleader = " "
vim.g.maplocalleader = " "
vim.opt.number = true
vim.opt.relativenumber = true
vim.opt.termguicolors = true
vim.opt.background = "dark"
vim.opt.signcolumn = "yes"
vim.opt.ignorecase = true
vim.opt.smartcase = true
vim.opt.undofile = true
vim.opt.updatetime = 250
vim.opt.splitright = true
vim.opt.splitbelow = true
vim.opt.expandtab = true
vim.opt.shiftwidth = 2
vim.opt.tabstop = 2

local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not vim.uv.fs_stat(lazypath) then
  local output = vim.fn.system({
    "git", "clone", "--filter=blob:none", "--branch=stable",
    "https://github.com/folke/lazy.nvim.git", lazypath,
  })
  if vim.v.shell_error ~= 0 then
    error("Could not install lazy.nvim:\n" .. output)
  end
end
vim.opt.rtp:prepend(lazypath)

require("lazy").setup({
  {
    "Shatur/neovim-ayu",
    priority = 1000,
    config = function()
      vim.cmd.colorscheme("ayu-dark")
    end,
  },
  { "neovim/nvim-lspconfig" },
  {
    "saghen/blink.cmp",
    version = "1.*",
    opts = {
      keymap = { preset = "default" },
      fuzzy = { implementation = "lua" },
      cmdline = { enabled = false },
      completion = {
        documentation = { auto_show = true },
        -- Text labels work with Ghostty's existing font; no Nerd Font needed.
        menu = { draw = { columns = { { "label", "label_description", gap = 1 }, { "kind" } } } },
      },
    },
  },
  { "nvim-mini/mini.pick", version = "*", opts = {} },
  { "stevearc/conform.nvim" },
  { "towolf/vim-helm" },
}, {
  local_spec = false,
  rocks = { enabled = false },
  change_detection = { notify = false },
})

-- Match Zed's Helm associations, including nested templates and scratch files.
vim.filetype.add({
  pattern = {
    [".*/templates/.*%.tpl"] = "helm",
    [".*/templates/.*%.yaml"] = "helm",
    [".*/templates/.*%.yml"] = "helm",
  },
})

-- Ruby LSP supplies navigation/completion; RuboCop owns linting and formatting.
-- Launch the rbenv executables directly, as in Zed, rather than `bundle exec`.
vim.lsp.config("ruby_lsp", {
  init_options = { formatter = "none", enabledFeatures = { diagnostics = false } },
})
vim.lsp.enable({
  "ruby_lsp", "rubocop", "gopls", "tsc", "terraformls",
  "dockerls", "html", "cssls", "jsonls", "yamlls", "helm_ls",
})
vim.diagnostic.config({ severity_sort = true, underline = true, virtual_text = true })

vim.api.nvim_create_autocmd("LspAttach", {
  callback = function(event)
    local function map(key, action, description)
      vim.keymap.set("n", key, action, { buffer = event.buf, desc = description })
    end
    map("gd", vim.lsp.buf.definition, "Go to definition")
    map("gr", vim.lsp.buf.references, "Find references")
    map("K", vim.lsp.buf.hover, "Documentation")
    map("<leader>rn", vim.lsp.buf.rename, "Rename symbol")
    map("<leader>ca", vim.lsp.buf.code_action, "Code action")
  end,
})

require("conform").setup({
  formatters_by_ft = {
    ruby = { "rubocop" },
    go = { "gofmt" },
    javascript = { "prettier" },
    javascriptreact = { "prettier" },
    typescript = { "prettier" },
    typescriptreact = { "prettier" },
    html = { "prettier" },
    css = { "prettier" },
    json = { "prettier" },
    jsonc = { "prettier" },
    yaml = { "prettier" },
    ["yaml.helm-values"] = { "prettier" },
    terraform = { "terraform_fmt" },
    ["terraform-vars"] = { "terraform_fmt" },
  },
  format_on_save = function(bufnr)
    -- Generic YAML formatters can damage Go templates. Leave Helm templates alone.
    if vim.bo[bufnr].filetype == "helm" then
      return
    end
    return { timeout_ms = 3000, lsp_format = "fallback" }
  end,
})

vim.keymap.set("n", "<leader>ff", function() MiniPick.builtin.files({ tool = "rg" }) end, { desc = "Find files" })
vim.keymap.set("n", "<leader>fg", function() MiniPick.builtin.grep_live({ tool = "rg" }) end, { desc = "Search project text" })
vim.keymap.set("n", "<leader>fb", function() MiniPick.builtin.buffers() end, { desc = "Find open buffers" })
vim.keymap.set("n", "<leader>e", vim.diagnostic.open_float, { desc = "Show diagnostic" })
