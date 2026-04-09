# Trigger Agent Orquestator

A VS Code extension that **automatically triggers agent orchestration on every `git commit`** by installing a lightweight `post-commit` git hook into your repository.

---

## How it works

```
git commit  →  post-commit hook  →  .git/commit_trigger  →  extension watcher  →  actions
```

1. On activation the extension installs a `post-commit` git hook in `.git/hooks/post-commit`.
2. After every commit, the hook writes the commit hash to `.git/commit_trigger`.
3. A `fs.watch` listener inside VS Code detects the file, reads it, then fires the configured actions.
4. The trigger file is deleted immediately after processing.

---

## Features

| Feature | Description |
|---|---|
| Auto-install hook | Installs the hook when the extension activates (configurable) |
| VS Code notification | Shows a toast with repo name, short hash, and subject line |
| Webhook POST | POSTs a JSON payload with full commit details to any HTTP/HTTPS URL |
| VS Code command | Executes any registered VS Code command, passing `CommitInfo` as argument |
| Status bar item | Shows current state; flashes on every detected commit |
| Multi-root support | Works with multiple git repos in the same workspace |
| Hook safety | Appends to (never replaces) an existing third-party post-commit hook |

---

## Commands (Command Palette)

| Command | Description |
|---|---|
| `Trigger Agent: Install Git Commit Hook` | (Re)install the hook |
| `Trigger Agent: Uninstall Git Commit Hook` | Remove the trigger block from the hook |
| `Trigger Agent: Trigger Agent Manually (last commit)` | Fire actions against HEAD without committing |
| `Trigger Agent: Show Output Channel` | Open the log |
| `Trigger Agent: Show Hook Status` | Show install state for each repo |

---

## Configuration

Add to your VS Code `settings.json`:

```jsonc
{
  // Disable the extension entirely
  "triggerAgentOrquestator.enabled": true,

  // Auto-install the hook when VS Code opens the workspace
  "triggerAgentOrquestator.autoInstallHook": true,

  // Show a notification toast on every commit
  "triggerAgentOrquestator.showNotification": true,

  // Include changed file paths in the payload
  "triggerAgentOrquestator.includeFileChanges": true,

  // ------------------------------------------------------------------
  // Webhook – POST JSON to an HTTP/HTTPS endpoint on every commit
  // ------------------------------------------------------------------
  "triggerAgentOrquestator.webhookUrl": "https://your-agent-server/api/trigger",

  // Extra headers (e.g. authentication)
  "triggerAgentOrquestator.webhookHeaders": {
    "Authorization": "Bearer YOUR_SECRET_TOKEN",
    "X-Source": "vscode-trigger-agent"
  },

  // Request timeout in milliseconds (default 10 000)
  "triggerAgentOrquestator.webhookTimeoutMs": 10000,

  // ------------------------------------------------------------------
  // VS Code command – run any registered command on every commit
  // ------------------------------------------------------------------
  "triggerAgentOrquestator.onCommitCommand": "myExtension.onCommit"
}
```

---

## Webhook payload

```jsonc
{
  "event": "commit",
  "firedAt": "2026-04-08T12:00:00.000Z",
  "commit": {
    "hash": "a1b2c3d4e5f6...",
    "shortHash": "a1b2c3d",
    "message": "feat: add new feature\n\nBody text...",
    "subject": "feat: add new feature",
    "branch": "main",
    "author": "Jane Doe",
    "email": "jane@example.com",
    "timestamp": "2026-04-08T12:00:00+00:00",
    "filesChanged": ["src/foo.ts", "src/bar.ts"],
    "workspaceRoot": "/absolute/path/to/repo",
    "repositoryName": "my-repo"
  },
  "vscodeVersion": "1.90.0",
  "extensionVersion": "0.1.0"
}
```

---

## Development

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode (recompile on save)
npm run watch

# Press F5 inside VS Code to launch Extension Development Host
```

### Project structure

```
src/
  extension.ts       — Entry point: activation, command registration, folder management
  gitHookManager.ts  — Installs / updates / removes the post-commit git hook
  commitHandler.ts   — Watches .git/ for the trigger file and fires actions
  statusBar.ts       — Status-bar item management
  types.ts           — Shared TypeScript interfaces
```

---

## Requirements

- VS Code ≥ 1.85
- Git installed and on `PATH`
- Git for Windows (includes MINGW bash) if running on Windows
Es una extension para visual studio que se encarga de ejecutar un orquestador de Agentes de IA para crear casos de uso, test, pruebas y reportes.
