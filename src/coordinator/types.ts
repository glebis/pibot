export interface Recipient { botId: string; chatId: string; userId: string }
export interface Mandate { digest: string; ownerCapsVersion: number; id: string; lineageId: string; version: number; status: string; ownerId: string; coordinatorId: string; recipient: Recipient; purpose: 'contract_decision'; notBefore: number; expiresAt: number; windowMs: number; maxMessages: number; ownerWindowMs: number; ownerMaxMessages: number; quietHours: { startMinute: number; endMinute: number; timeZone: 'Europe/Berlin' }; acknowledgeMs: number; maxResends: 0 | 1; retryDelayMs: number }
export interface AuthorityCheck { expectedVersion?: number; expectedDigest?: string; mandateId: string; ownerId: string; coordinatorId: string; botId: string; chatId: string; userId: string; purpose: 'contract_decision' }
export interface AuthorityReply { schemaVersion: 1; allowed: boolean; reason: string; checkedAt: number; mandate: Mandate | null }
export interface Authority { check(input: AuthorityCheck): Promise<AuthorityReply> }
export type SendOutcome = { status: 'accepted'; messageId: string } | { status: 'rejected' | 'unknown'; reason?: string };
export interface SendInput { attemptId: string; recipient: Recipient; text: string; controls: { label: string; token: string }[] }
export interface Sender { send(input: SendInput): Promise<SendOutcome> }
export interface DecisionInput { id?: string; sourceContractId: string; question: string; choices: string[]; mandateId: string; ownerId: string; coordinatorId: string; recipient: Recipient; deadline: number; urgent?: boolean }
export interface Decision extends DecisionInput { id: string; questionVersion: number; stateSeq: number; answerRevision: number; state: 'open' | 'answered' | 'dismissed' | 'cancelled' | 'expired'; attention: 'pending' | 'acknowledged' | 'snoozed'; attentionUntil: number; retrySuppressed?: boolean; answer?: string }
export interface ResponseInput { eventId: string; recipient: Recipient; token: string; snoozeUntil?: number }
export interface Attempt { id: string; decisionId: string; questionVersion: number; status: 'planned' | 'dispatching' | 'accepted' | 'rejected' | 'unknown' | 'cancelled'; createdAt: number; dispatchedAt?: number; messageId?: string; retry: boolean; lineageId?: string; ownerId: string; reason?: string }
