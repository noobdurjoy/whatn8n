// Who sent an outgoing WhatsApp message we did not (yet) match to our outbox?
// Uses only Zernio's documented fields (message.sent: sentVia, source) and our
// own outbound records. Never decides from message text.
//
//   own                  – provider id matches an outbound row we sent
//   human_phone_app      – source=whatsapp_business_app (Coexistence phone app)
//   human_zernio_inbox   – sentVia=human (operator in Zernio's inbox)
//   meta_business_agent  – source=meta_business_agent
//   zernio_automation    – sentVia in broadcast|sequence|workflow|comment_automation|bulk-api
//   possibly_own_pending – we have a send in flight in this conversation and
//                          the echo could be it (webhook raced our HTTP response)
//   other_api            – sentVia=api but not ours: another integration is sending
//   unknown              – sentVia null / unrecognised

export type OriginClass =
  | 'own' | 'human_phone_app' | 'human_zernio_inbox' | 'meta_business_agent' | 'zernio_automation'
  | 'possibly_own_pending' | 'other_api' | 'unknown';

export function classifyOutgoingOrigin(input: {
  sentVia: string | null;
  source: string | null;
  matchesOwnOutbound: boolean;
  hasPendingOwnSend: boolean;
}): OriginClass {
  if (input.matchesOwnOutbound) return 'own';
  if (input.source === 'whatsapp_business_app') return 'human_phone_app';
  if (input.sentVia === 'human') return 'human_zernio_inbox';
  if (input.source === 'meta_business_agent') return 'meta_business_agent';
  if (input.sentVia && ['broadcast', 'sequence', 'workflow', 'comment_automation', 'bulk-api'].includes(input.sentVia)) {
    return 'zernio_automation';
  }
  // Our own API send whose HTTP response has not been recorded yet looks like
  // sentVia=api (or unknown). Wait and re-check instead of guessing.
  if (input.hasPendingOwnSend && (input.sentVia === 'api' || input.sentVia === null)) return 'possibly_own_pending';
  if (input.sentVia === 'api') return 'other_api';
  return 'unknown';
}

export function isVerifiedHuman(o: OriginClass) {
  return o === 'human_phone_app' || o === 'human_zernio_inbox';
}
