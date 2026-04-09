/**
 * Information about a git commit extracted by the post-commit hook handler.
 */
export interface CommitInfo {
  /** Full 40-character commit hash */
  hash: string;
  /** Abbreviated 7-character commit hash */
  shortHash: string;
  /** Full commit message (may include body and trailers) */
  message: string;
  /** Subject line only (first line of message) */
  subject: string;
  /** Current branch name at time of commit */
  branch: string;
  /** Commit author name */
  author: string;
  /** Commit author email */
  email: string;
  /** ISO-8601 UTC timestamp of the commit */
  timestamp: string;
  /** Paths of files changed in this commit (relative to repo root) */
  filesChanged: string[];
  /** Absolute path to the workspace root */
  workspaceRoot: string;
  /** Repository name (basename of workspaceRoot) */
  repositoryName: string;
}

/**
 * Payload POSTed to the configured webhook URL on every commit.
 */
export interface WebhookPayload {
  /** Always "commit" — allows the receiving server to differentiate event types */
  event: 'commit';
  /** ISO-8601 timestamp of when the event was fired by the extension */
  firedAt: string;
  /** Commit details */
  commit: CommitInfo;
  /** Version of VS Code running the extension */
  vscodeVersion: string;
  /** Version of this extension */
  extensionVersion: string;
}

/**
 * Internal state tracked per workspace folder.
 */
export interface WorkspaceEntry {
  workspaceRoot: string;
}
