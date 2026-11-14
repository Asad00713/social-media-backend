const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Text that is safe between tags and inside a quoted attribute. The one escape
 * for every HTML a report route or the report email writes: a report name is
 * typed by a workspace member and shown to people outside the workspace.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ENTITIES[c]);
}
