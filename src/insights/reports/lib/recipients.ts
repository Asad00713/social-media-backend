/**
 * Who a scheduled report goes to: the team first (when the report sends to
 * it), then the listed addresses, lowercased and each once, minus everyone who
 * opted out. `optedOut` is stored lowercased; the team's emails are not.
 */
export function resolveRecipients(
  r: { sendToTeam: boolean; recipients: string[]; optedOut: string[] },
  team: { email: string }[],
): string[] {
  const out = new Set(r.optedOut.map((e) => e.trim().toLowerCase()));
  const seen = new Set<string>();
  const candidates = [
    ...(r.sendToTeam ? team.map((t) => t.email) : []),
    ...r.recipients,
  ];
  for (const email of candidates) {
    const address = email.trim().toLowerCase();
    if (address && !out.has(address)) seen.add(address);
  }
  return [...seen];
}
