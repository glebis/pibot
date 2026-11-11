import type { ChatRef, DeliveryReceipt, Transport } from "./types.js";

export interface AttachmentOutcome {
  index: number;
  status: "acknowledged" | "unverified" | "mismatch" | "uncertain" | "unavailable";
  receipt?: DeliveryReceipt;
}

/** The host consumes MEDIA syntax when it dispatches owner-facing attachments. Return the
 * actual transport outcome to the caller as well: absence of the syntax is not absence of a send.
 * Delivery stays part of the original run; this boundary never retries or forwards attachments. */
export async function prepareDelegatedReply(opts: {
  reply: string | null;
  cleanReply: string;
  media: string[];
  ownerFacing: boolean;
  originChat?: ChatRef;
  transport?: Pick<Transport, "name" | "sendMedia">;
  onSent?: (source: string) => void;
  onError?: (source: string, error: unknown) => void;
}): Promise<{ ownerReply: string; callerReply: string; attachments: AttachmentOutcome[] }> {
  const rawReply = opts.reply || "(no reply)";
  if (!opts.ownerFacing) return { ownerReply: rawReply, callerReply: rawReply, attachments: [] };
  const ownerReply = opts.cleanReply || (opts.media.length ? "📎 (media)" : rawReply);
  if (!opts.media.length) return { ownerReply, callerReply: ownerReply, attachments: [] };
  const expectedPeer = opts.originChat ? `${opts.originChat.transport}:${opts.originChat.chatId}` : undefined;
  const attachments: AttachmentOutcome[] = [];
  for (const [index, source] of opts.media.entries()) {
    if (!opts.originChat || !opts.transport?.sendMedia) {
      attachments.push({ index, status: "unavailable" });
      continue;
    }
    try {
      const result = await opts.transport.sendMedia(opts.originChat.chatId, source);
      // Copy only receipt fields actually supplied by the transport. No destination/account/id
      // is manufactured from the requested route or from the delegate's prose.
      const receipt: DeliveryReceipt | undefined = result ? Object.fromEntries(
        ["messageId", "mediaType", "peer", "account", "idProtocol", "evidence"]
          .filter((key) => result[key as keyof DeliveryReceipt] !== undefined)
          .map((key) => [key, result[key as keyof DeliveryReceipt]]),
      ) : undefined;
      const validId = typeof receipt?.messageId === "number" && Number.isSafeInteger(receipt.messageId) && receipt.messageId > 0;
      const mismatch = receipt?.peer !== undefined && receipt.peer !== expectedPeer;
      const evidenced = receipt?.evidence === "ack" || receipt?.evidence === "readback" || receipt?.evidence === "viewed";
      const complete = validId && receipt?.peer === expectedPeer && Boolean(receipt.account?.trim()) && Boolean(receipt.idProtocol?.trim()) && evidenced;
      attachments.push({ index, status: mismatch ? "mismatch" : complete ? "acknowledged" : "unverified", ...(receipt ? { receipt } : {}) });
      try { opts.onSent?.(source); } catch { /* diagnostics cannot change delivery truth */ }
    } catch (error) {
      // A rejection/timeout does not prove the remote send never happened. Preserve uncertainty
      // and explicitly prohibit blind retries, rather than creating a duplicate delivery.
      attachments.push({ index, status: "uncertain" });
      try { opts.onError?.(source, error); } catch { /* preserve the send outcome even if diagnostics fail */ }
    }
  }
  const counts = Object.fromEntries(["acknowledged", "unverified", "mismatch", "uncertain", "unavailable"]
    .map((status) => [status, attachments.filter((item) => item.status === status).length]));
  const report = JSON.stringify({ requestedPeer: expectedPeer, counts, attachments });
  const callerReply = `[Host attachment delivery]\n${report}\nMEDIA lines were consumed by the host, not lost from the delegate reply. Acknowledged attachments were already dispatched to the stated receipt peer; do not resend or forward them. An ack is transport acknowledgement, not independent readback or a human view. Unverified, mismatched, uncertain or unavailable outcomes require inspection; never retry automatically.\n\nDelegate reply:\n${ownerReply}`;
  return { ownerReply, callerReply, attachments };
}
