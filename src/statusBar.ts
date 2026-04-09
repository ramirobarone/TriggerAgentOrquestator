import * as vscode from 'vscode';

// ─── StatusBarManager ─────────────────────────────────────────────────────────

/**
 * Manages a single VS Code status-bar item that reflects whether the
 * post-commit hook is active in the current workspace.
 */
export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      'triggerAgentOrquestator.status',
      vscode.StatusBarAlignment.Left,
      // Priority: show near the left end, after source-control items.
      50
    );
    this.item.command = 'triggerAgentOrquestator.showStatus';
    this.item.name = 'Trigger Agent Orquestator';
  }

  // ── State setters ──────────────────────────────────────────────────────────

  /** Show as active (hook installed and watching). */
  setActive(repoCount: number): void {
    this.item.text = `$(zap) Trigger Agent`;
    this.item.tooltip = new vscode.MarkdownString(
      `**Trigger Agent Orquestator** — active\n\n` +
      `Watching ${repoCount} repositor${repoCount === 1 ? 'y' : 'ies'} for commits.\n\n` +
      `Click to view status.`
    );
    this.item.backgroundColor = undefined;
    this.item.color = undefined;
    this.item.show();
  }

  /** Show as idle (no git repository found in workspace). */
  setIdle(): void {
    this.item.text = `$(zap) Trigger Agent`;
    this.item.tooltip = new vscode.MarkdownString(
      `**Trigger Agent Orquestator** — no git repo found.\n\n` +
      `Click for details.`
    );
    this.item.backgroundColor = undefined;
    this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
    this.item.show();
  }

  /** Briefly flash the status-bar item when a commit fires to give visual feedback. */
  flashOnCommit(): void {
    const originalText = this.item.text;
    const originalColor = this.item.color;

    this.item.text = '$(check) Commit Triggered!';
    this.item.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');

    setTimeout(() => {
      this.item.text = originalText;
      this.item.color = originalColor;
      this.item.backgroundColor = undefined;
    }, 2500);
  }

  hide(): void {
    this.item.hide();
  }

  dispose(): void {
    this.item.dispose();
  }
}
