/**
 * Single switch for the messenger bots.
 *
 * The bots are wired to the same assistant as the web interface, but they are
 * only useful once the deployment has a public HTTPS address. Until then this
 * keeps them from connecting at all — in particular from re-creating a webhook
 * subscription that was deliberately removed.
 */
export function botsEnabled(): boolean {
  const value = process.env["BOTS_ENABLED"];
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLocaleLowerCase("en"));
}
