import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Unique marker written inside the hook so we can identify & manage it safely */
const HOOK_MARKER = '# @@TRIGGER_AGENT_ORQUESTATOR@@';

/**
 * The shell script injected (or appended) as the post-commit hook.
 *
 * - Works on Git for Windows (MINGW bash), macOS, and Linux.
 * - Writes just the commit hash to `.git/commit_trigger` so the VS Code
 *   extension can pick it up via a fs.watch on that directory.
 * - Skips quietly if anything fails so it never blocks the commit.
 */
const HOOK_SCRIPT_BODY = `
${HOOK_MARKER}
# Installed by the Trigger Agent Orquestator VS Code extension.
# Remove this block (or run "Trigger Agent: Uninstall Git Commit Hook") to disable.
_TAG_GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)
if [ -n "$_TAG_GIT_DIR" ]; then
  _TAG_HASH=$(git rev-parse HEAD 2>/dev/null)
  if [ -n "$_TAG_HASH" ]; then
    printf '%s' "$_TAG_HASH" > "$_TAG_GIT_DIR/commit_trigger"
  fi
fi
# @@END_TRIGGER_AGENT_ORQUESTATOR@@
`;

const HOOK_END_MARKER = '# @@END_TRIGGER_AGENT_ORQUESTATOR@@';

// ─── GitHookManager ───────────────────────────────────────────────────────────

/**
 * Installs, updates, and removes the post-commit git hook for a single
 * workspace-folder / git repository.
 */
export class GitHookManager {
  private readonly hooksDir: string;
  private readonly hookPath: string;

  constructor(
    private readonly workspaceRoot: string,
    private readonly outputChannel: vscode.OutputChannel
  ) {
    this.hooksDir = path.join(workspaceRoot, '.git', 'hooks');
    this.hookPath = path.join(this.hooksDir, 'post-commit');
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Installs the post-commit hook.
   * - If no hook exists yet → writes a fresh one.
   * - If our hook is already present → updates it in-place.
   * - If a *third-party* hook exists → appends our block safely.
   *
   * @param showMessages Whether to surface VS Code info/error messages.
   */
  async installHook(showMessages = true): Promise<boolean> {
    if (!this.assertGitRepo(showMessages)) {
      return false;
    }

    this.ensureHooksDirExists();

    try {
      if (!fs.existsSync(this.hookPath)) {
        // No hook at all → write our standalone hook
        this.writeNewHook();
        this.log('Installed new post-commit hook');
      } else {
        const existing = fs.readFileSync(this.hookPath, 'utf8');

        if (existing.includes(HOOK_MARKER)) {
          // Our hook is already present → replace our block (update)
          this.updateExistingHook(existing);
          this.log('Updated existing trigger block in post-commit hook');
        } else {
          // Someone else's hook → append our block
          this.appendToExistingHook(existing);
          this.log('Appended trigger block to existing post-commit hook');
        }
      }

      this.makeExecutable();

      if (showMessages) {
        vscode.window.showInformationMessage(
          `Trigger Agent: post-commit hook installed in ${path.basename(this.workspaceRoot)}`
        );
      }
      return true;
    } catch (err) {
      const msg = `Failed to install hook: ${err}`;
      this.log(msg);
      if (showMessages) {
        vscode.window.showErrorMessage(`Trigger Agent: ${msg}`);
      }
      return false;
    }
  }

  /** Removes the trigger block from the post-commit hook (or the whole file if it was ours alone). */
  async uninstallHook(): Promise<void> {
    if (!fs.existsSync(this.hookPath)) {
      vscode.window.showInformationMessage('Trigger Agent: No post-commit hook found — nothing to remove.');
      return;
    }

    const content = fs.readFileSync(this.hookPath, 'utf8');

    if (!content.includes(HOOK_MARKER)) {
      vscode.window.showWarningMessage(
        'Trigger Agent: The current post-commit hook was not installed by this extension — not touching it.'
      );
      return;
    }

    try {
      const cleaned = this.removeOurBlock(content);

      if (cleaned.trim().length === 0 || cleaned.trim() === '#!/bin/sh') {
        // Nothing left besides a shebang — remove the file entirely
        fs.unlinkSync(this.hookPath);
        this.log('Removed post-commit hook file (only our block remained)');
      } else {
        fs.writeFileSync(this.hookPath, cleaned, 'utf8');
        this.log('Removed trigger block from post-commit hook');
      }

      vscode.window.showInformationMessage(
        `Trigger Agent: post-commit hook uninstalled from ${path.basename(this.workspaceRoot)}`
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Trigger Agent: Failed to uninstall hook: ${err}`);
    }
  }

  /** Returns true when our trigger block is present in the hook file. */
  isHookInstalled(): boolean {
    if (!fs.existsSync(this.hookPath)) {
      return false;
    }
    const content = fs.readFileSync(this.hookPath, 'utf8');
    return content.includes(HOOK_MARKER);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private assertGitRepo(showMessages: boolean): boolean {
    const gitDir = path.join(this.workspaceRoot, '.git');
    if (!fs.existsSync(gitDir)) {
      const msg = `No .git directory found in ${this.workspaceRoot}`;
      this.log(msg);
      if (showMessages) {
        vscode.window.showErrorMessage(`Trigger Agent: ${msg}`);
      }
      return false;
    }
    return true;
  }

  private ensureHooksDirExists(): void {
    if (!fs.existsSync(this.hooksDir)) {
      fs.mkdirSync(this.hooksDir, { recursive: true });
    }
  }

  private writeNewHook(): void {
    const content = `#!/bin/sh\n${HOOK_SCRIPT_BODY}`;
    fs.writeFileSync(this.hookPath, content, { encoding: 'utf8', flag: 'w' });
  }

  private appendToExistingHook(existing: string): void {
    const separator = existing.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(this.hookPath, existing + separator + HOOK_SCRIPT_BODY, { encoding: 'utf8', flag: 'w' });
  }

  private updateExistingHook(existing: string): void {
    const cleaned = this.removeOurBlock(existing);
    const separator = cleaned.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(this.hookPath, cleaned + separator + HOOK_SCRIPT_BODY, { encoding: 'utf8', flag: 'w' });
  }

  /**
   * Strips our block (from HOOK_MARKER line to HOOK_END_MARKER line inclusive)
   * from the given content string.
   */
  private removeOurBlock(content: string): string {
    const lines = content.split('\n');
    const startIdx = lines.findIndex(l => l.includes(HOOK_MARKER));
    const endIdx = lines.findIndex(l => l.includes(HOOK_END_MARKER));

    if (startIdx === -1) {
      return content;
    }

    const end = endIdx !== -1 ? endIdx : startIdx;
    lines.splice(startIdx, end - startIdx + 1);
    return lines.join('\n');
  }

  /** Marks the hook executable (no-op on Windows, required on Unix). */
  private makeExecutable(): void {
    try {
      fs.chmodSync(this.hookPath, 0o755);
    } catch {
      // Windows does not support POSIX permissions — ignored intentionally.
    }
  }

  private log(message: string): void {
    this.outputChannel.appendLine(`[HookManager] ${message}`);
  }
}
