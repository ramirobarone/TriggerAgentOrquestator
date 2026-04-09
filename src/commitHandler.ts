import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { execSync } from 'child_process';
import * as vscode from 'vscode';
import { CommitInfo, WebhookPayload } from './types';

// ─── CommitHandler ────────────────────────────────────────────────────────────

/**
 * Watches the `.git` directory for the `commit_trigger` file written by the
 * post-commit hook and fires the configured actions (notification, webhook,
 * VS Code command) when a commit is detected.
 */
export class CommitHandler implements vscode.Disposable {
  private watcher: fs.FSWatcher | undefined;
  private processing = false;

  private readonly gitDir: string;
  private readonly triggerFile: string;

  constructor(
    private readonly workspaceRoot: string,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly context: vscode.ExtensionContext
  ) {
    this.gitDir = path.join(workspaceRoot, '.git');
    this.triggerFile = path.join(this.gitDir, 'commit_trigger');
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Begin watching `.git/` for the trigger file created by the post-commit hook. */
  startWatching(): void {
    if (!fs.existsSync(this.gitDir)) {
      this.log('Cannot start watcher — .git directory not found');
      return;
    }

    // Watch the .git directory for any file-change events.
    // We react only when the filename is "commit_trigger".
    this.watcher = fs.watch(this.gitDir, (_eventType: fs.WatchEventType, filename: string | Buffer | null) => {
      if (filename?.toString() === 'commit_trigger') {
        // Small delay to allow the hook process to finish writing the file.
        setTimeout(() => this.consumeTriggerFile(), 150);
      }
    });

    this.watcher.on('error', (err: Error) => {
      this.log(`Watcher error: ${err} — attempting restart`);
      this.watcher?.close();
      setTimeout(() => this.startWatching(), 2000);
    });

    this.log(`Watching for commits in ${path.basename(this.workspaceRoot)}`);
  }

  /**
   * Manually fire the commit handler using the current HEAD commit.
   * Useful for testing the pipeline without making an actual commit.
   */
  async triggerManual(): Promise<void> {
    try {
      const hash = execSync('git rev-parse HEAD', {
        cwd: this.workspaceRoot,
        timeout: 5000,
      })
        .toString()
        .trim();

      this.log(`Manual trigger with HEAD: ${hash}`);
      await this.handleCommit(hash);
    } catch {
      vscode.window.showErrorMessage(
        'Trigger Agent: No commits found — make at least one commit first.'
      );
    }
  }

  dispose(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }

  // ── Trigger file consumption ───────────────────────────────────────────────

  /**
   * Reads and deletes the trigger file, then routes to `handleCommit`.
   * Guard against re-entrancy with the `processing` flag.
   */
  private async consumeTriggerFile(): Promise<void> {
    if (this.processing) {
      return;
    }

    if (!fs.existsSync(this.triggerFile)) {
      return;
    }

    this.processing = true;
    try {
      const hash = fs.readFileSync(this.triggerFile, 'utf8').trim();

      // Remove the trigger file so we don't re-process on the next watcher tick.
      try {
        fs.unlinkSync(this.triggerFile);
      } catch {
        // Ignore — may already be deleted by a concurrent process.
      }

      if (hash) {
        await this.handleCommit(hash);
      }
    } finally {
      this.processing = false;
    }
  }

  // ── Core commit handler ────────────────────────────────────────────────────

  private async handleCommit(hash: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('triggerAgentOrquestator');

    if (!cfg.get<boolean>('enabled', true)) {
      this.log('Extension disabled — skipping commit handler');
      return;
    }

    const info = this.buildCommitInfo(hash);
    this.logCommit(info);

    // ── 1. VS Code notification ──────────────────────────────────────────────
    if (cfg.get<boolean>('showNotification', true)) {
      const subject = info.subject.length > 70
        ? info.subject.substring(0, 67) + '…'
        : info.subject;

      vscode.window.showInformationMessage(
        `[${info.repositoryName}] Commit ${info.shortHash}: ${subject}`
      );
    }

    // ── 2. Webhook ───────────────────────────────────────────────────────────
    const webhookUrl = cfg.get<string>('webhookUrl', '').trim();
    if (webhookUrl) {
      await this.sendWebhook(webhookUrl, info, cfg);
    }

    // ── 3. VS Code command ───────────────────────────────────────────────────
    const onCommitCommand = cfg.get<string>('onCommitCommand', '').trim();
    if (onCommitCommand) {
      try {
        await vscode.commands.executeCommand(onCommitCommand, info);
        this.log(`Executed command: ${onCommitCommand}`);
      } catch (err) {
        this.log(`Failed to execute command "${onCommitCommand}": ${err}`);
        vscode.window.showErrorMessage(
          `Trigger Agent: Command "${onCommitCommand}" failed — ${err}`
        );
      }
    }
  }

  // ── CommitInfo builder ─────────────────────────────────────────────────────

  private buildCommitInfo(hash: string): CommitInfo {
    let commitHash = hash;
    let shortHash = hash.substring(0, 7);
    let message = '';
    let subject = '';
    let author = '';
    let email = '';
    let timestamp = new Date().toISOString();
    let branch = 'unknown';
    let filesChanged: string[] = [];

    try {
      // Single git call to retrieve all scalar fields at once.
      // Fields are separated by the unit-separator character (0x1F) which
      // cannot appear in normal commit messages.
      const sep = '\x1f';
      const fmt = `%H${sep}%h${sep}%B${sep}%an${sep}%ae${sep}%aI`;
      const raw = execSync(`git log -1 --format=${fmt} ${hash}`, {
        cwd: this.workspaceRoot,
        timeout: 5000,
      }).toString();

      const parts = raw.split(sep);
      if (parts.length >= 6) {
        commitHash = parts[0].trim();
        shortHash = parts[1].trim();
        message = parts[2].trim();
        subject = message.split('\n')[0].trim();
        author = parts[3].trim();
        email = parts[4].trim();
        timestamp = parts[5].trim();
      }
    } catch (err) {
      this.log(`Could not retrieve commit details for ${hash}: ${err}`);
    }

    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: this.workspaceRoot,
        timeout: 3000,
      })
        .toString()
        .trim();
    } catch {
      // HEAD may be detached — leave as "unknown"
    }

    const cfg = vscode.workspace.getConfiguration('triggerAgentOrquestator');
    if (cfg.get<boolean>('includeFileChanges', true)) {
      try {
        const raw = execSync(
          `git diff-tree --no-commit-id -r --name-only ${commitHash}`,
          { cwd: this.workspaceRoot, timeout: 5000 }
        ).toString().trim();
        filesChanged = raw ? raw.split('\n').filter(Boolean) : [];
      } catch {
        // Not a fatal error — files list is optional
      }
    }

    return {
      hash: commitHash,
      shortHash,
      message,
      subject,
      branch,
      author,
      email,
      timestamp,
      filesChanged,
      workspaceRoot: this.workspaceRoot,
      repositoryName: path.basename(this.workspaceRoot),
    };
  }

  // ── Webhook ────────────────────────────────────────────────────────────────

  private async sendWebhook(
    url: string,
    info: CommitInfo,
    cfg: vscode.WorkspaceConfiguration
  ): Promise<void> {
    const extraHeaders = cfg.get<Record<string, string>>('webhookHeaders', {});
    const timeoutMs = cfg.get<number>('webhookTimeoutMs', 10000);

    const payload: WebhookPayload = {
      event: 'commit',
      firedAt: new Date().toISOString(),
      commit: info,
      vscodeVersion: vscode.version,
      extensionVersion: this.context.extension.packageJSON.version as string,
    };

    const body = JSON.stringify(payload, null, 2);

    try {
      const statusCode = await httpPost(url, body, {
        'Content-Type': 'application/json',
        'User-Agent': `VSCode/TriggerAgentOrquestator/${this.context.extension.packageJSON.version as string}`,
        ...extraHeaders,
      }, timeoutMs);

      if (statusCode >= 200 && statusCode < 300) {
        this.log(`Webhook → ${url} responded ${statusCode}`);
      } else {
        this.log(`Webhook → ${url} responded ${statusCode} (non-2xx)`);
        vscode.window.showWarningMessage(
          `Trigger Agent: Webhook returned HTTP ${statusCode}`
        );
      }
    } catch (err) {
      this.log(`Webhook error: ${err}`);
      vscode.window.showErrorMessage(`Trigger Agent: Webhook failed — ${err}`);
    }
  }

  // ── Logging ────────────────────────────────────────────────────────────────

  private logCommit(info: CommitInfo): void {
    const divider = '─'.repeat(60);
    this.outputChannel.appendLine('');
    this.outputChannel.appendLine(divider);
    this.outputChannel.appendLine(`[Commit detected] ${info.timestamp}`);
    this.outputChannel.appendLine(`  Repo    : ${info.repositoryName}`);
    this.outputChannel.appendLine(`  Branch  : ${info.branch}`);
    this.outputChannel.appendLine(`  Hash    : ${info.hash}`);
    this.outputChannel.appendLine(`  Author  : ${info.author} <${info.email}>`);
    this.outputChannel.appendLine(`  Subject : ${info.subject}`);
    if (info.filesChanged.length > 0) {
      this.outputChannel.appendLine(
        `  Files   : ${info.filesChanged.join(', ')}`
      );
    }
    this.outputChannel.appendLine(divider);
  }

  private log(message: string): void {
    this.outputChannel.appendLine(`[CommitHandler] ${message}`);
  }
}

// ─── HTTP helper (no external dependencies) ───────────────────────────────────

/**
 * Sends an HTTP/HTTPS POST request and resolves with the response status code.
 * Uses Node's built-in `http`/`https` modules to avoid runtime dependencies.
 */
function httpPost(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return reject(new Error(`Invalid webhook URL: ${url}`));
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options: http.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port
        ? parseInt(parsedUrl.port, 10)
        : isHttps ? 443 : 80,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(body, 'utf8'),
      },
      timeout: timeoutMs,
    };

    const req = lib.request(options, (res: http.IncomingMessage) => {
      // Consume response body to free the socket
      res.resume();
      resolve(res.statusCode ?? 0);
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Webhook request timed out after ${timeoutMs}ms`));
    });

    req.on('error', reject);
    req.write(body, 'utf8');
    req.end();
  });
}
