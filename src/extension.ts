import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { CommitHandler } from './commitHandler';
import { GitHookManager } from './gitHookManager';
import { StatusBarManager } from './statusBar';

// ─── Per-folder state ─────────────────────────────────────────────────────────

interface FolderEntry {
  hookManager: GitHookManager;
  commitHandler: CommitHandler;
}

// ─── Module-level singletons ──────────────────────────────────────────────────

let outputChannel: vscode.OutputChannel;
let statusBar: StatusBarManager;

/** One entry per git-backed workspace folder, keyed by folder path. */
const folders = new Map<string, FolderEntry>();

// ─── Activate ─────────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // ── Output channel ──────────────────────────────────────────────────────────
  outputChannel = vscode.window.createOutputChannel('Trigger Agent Orquestator');
  context.subscriptions.push(outputChannel);

  // ── Status bar ──────────────────────────────────────────────────────────────
  statusBar = new StatusBarManager();
  context.subscriptions.push(statusBar);

  log('Activating Trigger Agent Orquestator…');

  // ── Commands ─────────────────────────────────────────────────────────────────
  registerCommands(context);

  // ── Initialise for all current workspace folders ─────────────────────────────
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of workspaceFolders) {
    await initFolder(folder.uri.fsPath, context);
  }

  // ── React to workspace folder changes ────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
      for (const added of event.added) {
        await initFolder(added.uri.fsPath, context);
      }
      for (const removed of event.removed) {
        disposeFolder(removed.uri.fsPath);
      }
      refreshStatusBar();
    })
  );

  refreshStatusBar();
  log(`Activation complete — ${folders.size} git repositor${folders.size === 1 ? 'y' : 'ies'} found.`);
}

// ─── Deactivate ───────────────────────────────────────────────────────────────

export function deactivate(): void {
  for (const folderPath of [...folders.keys()]) {
    disposeFolder(folderPath);
  }
  log('Extension deactivated.');
}

// ─── Folder lifecycle ─────────────────────────────────────────────────────────

async function initFolder(
  folderPath: string,
  context: vscode.ExtensionContext
): Promise<void> {
  if (folders.has(folderPath)) {
    return; // Already initialised
  }

  const gitDir = path.join(folderPath, '.git');
  if (!fs.existsSync(gitDir)) {
    log(`Skipping ${folderPath} — no .git directory`);
    return;
  }

  const hookManager = new GitHookManager(folderPath, outputChannel);
  const commitHandler = new CommitHandler(folderPath, outputChannel, context);

  // Wire up status-bar flash when a commit fires
  patchCommitHandler(commitHandler);

  folders.set(folderPath, { hookManager, commitHandler });

  // Dispose the handler when the extension is deactivated
  context.subscriptions.push(commitHandler);

  // Auto-install the hook if the setting is on
  const cfg = vscode.workspace.getConfiguration('triggerAgentOrquestator');
  if (cfg.get<boolean>('autoInstallHook', true)) {
    await hookManager.installHook(/* showMessages */ false);
  }

  commitHandler.startWatching();

  log(`Watching: ${path.basename(folderPath)}`);
}

function disposeFolder(folderPath: string): void {
  const entry = folders.get(folderPath);
  if (entry) {
    entry.commitHandler.dispose();
    folders.delete(folderPath);
    log(`Stopped watching: ${path.basename(folderPath)}`);
  }
}

/**
 * Monkey-patches the CommitHandler so that every detected commit also flashes
 * the status bar without coupling CommitHandler to the StatusBarManager.
 */
function patchCommitHandler(handler: CommitHandler): void {
  // We override `triggerManual` and the internal `handleCommit` by wrapping
  // the public `triggerManual` method to always flash the status bar.
  const original = handler.triggerManual.bind(handler);
  handler.triggerManual = async () => {
    await original();
    statusBar.flashOnCommit();
  };

  // For automatic commits (via hook), we use the public `startWatching` path.
  // Because CommitHandler calls `handleCommit` internally, we also need to hook
  // into the watcher path. We do this by listening for a synthetic event fired
  // by overriding `startWatching`:
  const originalStart = handler.startWatching.bind(handler);
  handler.startWatching = () => {
    originalStart();
    // After the watcher is attached, wrap the internal tick.
    // Since the handler calls its own private method we cannot easily wrap it,
    // so instead we install a filesystem watch on the same trigger file and
    // flash when the file appears (before the handler deletes it).
    const triggerFile = path.join(handler['workspaceRoot'] as string, '.git', 'commit_trigger');
    const watchDir = path.join(handler['workspaceRoot'] as string, '.git');
    if (fs.existsSync(watchDir)) {
      const flashWatcher = fs.watch(watchDir, (_type: fs.WatchEventType, name: string | Buffer | null) => {
        if (name?.toString() === 'commit_trigger' && fs.existsSync(triggerFile)) {
          statusBar.flashOnCommit();
        }
      });
      // Close when the handler is disposed
      const origDispose = handler.dispose.bind(handler);
      handler.dispose = () => {
        flashWatcher.close();
        origDispose();
      };
    }
  };
}

// ─── Status bar refresh ───────────────────────────────────────────────────────

function refreshStatusBar(): void {
  if (folders.size === 0) {
    statusBar.setIdle();
  } else {
    statusBar.setActive(folders.size);
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

function registerCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(

    // ── Install hook ──────────────────────────────────────────────────────────
    vscode.commands.registerCommand('triggerAgentOrquestator.installHook', async () => {
      if (folders.size === 0) {
        vscode.window.showWarningMessage('Trigger Agent: No git repositories found in workspace.');
        return;
      }
      for (const { hookManager } of folders.values()) {
        await hookManager.installHook(/* showMessages */ true);
      }
      refreshStatusBar();
    }),

    // ── Uninstall hook ────────────────────────────────────────────────────────
    vscode.commands.registerCommand('triggerAgentOrquestator.uninstallHook', async () => {
      if (folders.size === 0) {
        vscode.window.showWarningMessage('Trigger Agent: No git repositories found in workspace.');
        return;
      }
      for (const { hookManager } of folders.values()) {
        await hookManager.uninstallHook();
      }
    }),

    // ── Trigger manual ────────────────────────────────────────────────────────
    vscode.commands.registerCommand('triggerAgentOrquestator.triggerManual', async () => {
      if (folders.size === 0) {
        vscode.window.showWarningMessage('Trigger Agent: No git repositories found in workspace.');
        return;
      }
      for (const { commitHandler } of folders.values()) {
        await commitHandler.triggerManual();
      }
    }),

    // ── Show output channel ───────────────────────────────────────────────────
    vscode.commands.registerCommand('triggerAgentOrquestator.showOutput', () => {
      outputChannel.show(/* preserveFocus */ true);
    }),

    // ── Show status ───────────────────────────────────────────────────────────
    vscode.commands.registerCommand('triggerAgentOrquestator.showStatus', () => {
      if (folders.size === 0) {
        vscode.window.showInformationMessage(
          'Trigger Agent: No git repositories found in the current workspace.'
        );
        return;
      }

      const lines: string[] = [];
      for (const [folderPath, { hookManager }] of folders) {
        const name = path.basename(folderPath);
        const installed = hookManager.isHookInstalled();
        lines.push(`${name}: ${installed ? '✓ hook installed' : '✗ hook NOT installed'}`);
      }

      const summary = lines.join('\n');
      vscode.window.showInformationMessage(`Trigger Agent Status:\n${summary}`);
      log(`[Status]\n${summary}`);
      outputChannel.show(/* preserveFocus */ true);
    })
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(message: string): void {
  outputChannel.appendLine(`[Extension] ${message}`);
}
