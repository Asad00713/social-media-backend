import type { ReleaseHeldResult } from '../services/channel-pause.service';

/** `DELETE /channels/workspaces/:workspaceId/:channelId[?deleteHistory=true]` */
export interface DisconnectChannelResponse {
  /**
   * 'disconnected': kept as history, can be undone until `restoreUntil`.
   * 'deleted': gone at once (deleteHistory, or an integration) - no undo.
   */
  outcome: 'disconnected' | 'deleted';
  channelId: number;
  /** ISO time the undo closes; null for 'deleted'. */
  restoreUntil: string | null;
  /**
   * False when the platform's policy requires its data to go: the history is
   * deleted when the undo window closes (channels/lib/disconnect-policy.ts).
   */
  historyKept: boolean;
  /** Scheduled posts on the channel now paused (held). */
  pausedCount: number;
}

/** `POST /channels/workspaces/:workspaceId/:channelId/restore` (the undo). */
export interface RestoreChannelResponse extends ReleaseHeldResult {
  channelId: number;
  /** The status it is back to (what it had when disconnected). */
  connectionStatus: string;
}
