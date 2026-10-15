import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { CardButton, Transport } from './types.js';

type Link = { tier: 'standard' | 'personal'; label: string; url: string; paymentLinkId: string; productId: string };
type Config = { enabled: boolean; groupInviteUrl: string; links: Link[]; offers?: { KRAFT: { code: string } } };
type Reference = { chatId: string; created: number; paymentLinkId: string; productId: string };
type Delivery = { reference: string; status: 'pending' | 'sending' | 'sent' };
type State = { version: 1; references: Record<string, Reference>; offers: Record<string, 'KRAFT'>; deliveries: Record<string, Delivery> };
const PRIVATE = /^[1-9]\d*$/;
const REF = /^[a-f0-9]{48}$/;
const CONTACT = 'Напишите [@glebkalinin](https://t.me/glebkalinin), если нужна помощь.';
const UNAVAILABLE = 'Сейчас автоматическая проверка оплаты недоступна. ' + CONTACT;
const EMPTY = (): State => ({ version: 1, references: {}, offers: {}, deliveries: {} });
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Stripe GET reconciliation supplements the existing signed webhook. Never trusts a redirect or email identity. */
export class LabPayments {
  private root: string;
  private apiKey?: string;
  private request: typeof fetch;
  private livemode: boolean;
  private lastTickWarning = 0;
  constructor(root: string, options: { apiKey?: string; fetch?: typeof fetch; livemode?: boolean } = {}) {
    this.root = path.resolve(root); this.apiKey = options.apiKey; this.request = options.fetch ?? fetch; this.livemode = options.livemode ?? true;
  }
  private safe(name: string): string {
    // Check every component, including ancestors of the private root and dangling links.
    const target = path.join(this.root, name); let cursor = path.parse(target).root;
    for (const segment of target.slice(cursor.length).split(path.sep)) {
      cursor = path.join(cursor, segment);
      try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Unsafe payment path'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (!fs.statSync(this.root).isDirectory()) throw new Error('Unsafe payment root');
    return target;
  }
  private read(name: string): any {
    const file = this.safe(name);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024 || (stat.mode & 0o077) !== 0) throw new Error('Unsafe payment source');
      return JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally { fs.closeSync(fd); }
  }
  private config(): Config {
    const value = this.read('payments.json');
    if (!record(value) || typeof value.enabled !== 'boolean' || !Array.isArray(value.links) || value.links.length > 2 || typeof value.groupInviteUrl !== 'string') throw new Error('Invalid payment config');
    const invite = new URL(value.groupInviteUrl);
    if (invite.protocol !== 'https:' || invite.hostname !== 't.me' || invite.username || invite.password || invite.port || invite.hash || !/^\/(?:\+|joinchat\/)[A-Za-z0-9_-]+$/.test(invite.pathname) || invite.search) throw new Error('Invalid invite');
    const tiers = new Set(); const ids = new Set();
    for (const link of value.links) {
      if (!record(link) || !['standard', 'personal'].includes(link.tier) || tiers.has(link.tier) || typeof link.label !== 'string' || !link.label.trim() || link.label.length > 100 || !/^plink_[A-Za-z0-9]+$/.test(link.paymentLinkId) || !/^prod_[A-Za-z0-9]+$/.test(link.productId) || ids.has(link.paymentLinkId)) throw new Error('Invalid payment link');
      const url = new URL(link.url);
      if (url.protocol !== 'https:' || url.hostname !== 'buy.stripe.com' || url.username || url.password || url.port || url.search || url.hash || !/^\/[A-Za-z0-9_]+$/.test(url.pathname)) throw new Error('Invalid payment URL');
      tiers.add(link.tier); ids.add(link.paymentLinkId);
    }
    if (value.enabled && !value.links.length) throw new Error('Missing payment links');
    if (value.offers !== undefined && (!record(value.offers) || Object.keys(value.offers).some(k => k !== 'KRAFT') || (value.offers.KRAFT !== undefined && (!record(value.offers.KRAFT) || value.offers.KRAFT.code !== 'KRAFT')))) throw new Error('Invalid offer');
    return value as Config;
  }
  isEnabled(): boolean { try { return this.config().enabled; } catch { return false; } }
  private state(): State {
    let s: any;
    try { s = this.read('payments-state.json'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY(); throw error; }
    if (!record(s) || s.version !== 1 || !record(s.references) || !record(s.offers) || !record(s.deliveries)) throw new Error('Invalid payment state');
    for (const [key, r] of Object.entries(s.references)) {
      if (!REF.test(key) || !record(r) || typeof r.chatId !== 'string' || !PRIVATE.test(r.chatId) || !Number.isSafeInteger(r.created) || r.created <= 0 || !/^plink_[A-Za-z0-9]+$/.test(r.paymentLinkId) || !/^prod_[A-Za-z0-9]+$/.test(r.productId)) throw new Error('Invalid payment reference');
    }
    for (const [chat, offer] of Object.entries(s.offers)) if (!PRIVATE.test(chat) || offer !== 'KRAFT') throw new Error('Invalid saved offer');
    for (const [id, d] of Object.entries(s.deliveries)) if (!/^cs_[A-Za-z0-9_]+$/.test(id) || !record(d) || !own(s.references, d.reference) || !['pending', 'sending', 'sent'].includes(d.status)) throw new Error('Invalid payment delivery');
    return s as State;
  }
  private save(s: State): void {
    const file = this.safe('payments-state.json'); const tmp = this.safe(`payments-state.${randomUUID()}.tmp`);
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(s)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.safe('payments-state.json'); fs.renameSync(tmp, file);
    const directory = fs.openSync(this.root, 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
  private async locked<T>(run: () => Promise<T>): Promise<T> {
    const lock = this.safe('payments-state.lock');
    let fd: number;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Serialize dead-owner recovery so concurrent contenders cannot unlink a
      // newly acquired lock. A malformed lock or abandoned recovery gate stays
      // blocked for manual review; never guess that its owner is dead.
      const gate = this.safe('payments-recovery.lock'); const gateFd = fs.openSync(gate, 'wx', 0o600);
      try {
        const stat = fs.lstatSync(this.safe('payments-state.lock'));
        const prior = this.read('payments-state.lock');
        if (!record(prior) || prior.version !== 1 || !Number.isSafeInteger(prior.pid) || prior.pid <= 0) throw new Error('Invalid payment lock');
        let dead = false;
        try { process.kill(prior.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') dead = true; else throw error; }
        if (!dead) throw new Error('Payment verification already running');
        const current = fs.lstatSync(this.safe('payments-state.lock'));
        if (current.ino !== stat.ino || current.dev !== stat.dev) throw new Error('Payment lock changed');
        fs.unlinkSync(lock); fd = fs.openSync(lock, 'wx', 0o600);
      } finally { fs.closeSync(gateFd); fs.unlinkSync(gate); }
    }
    const held = fs.fstatSync(fd);
    try {
      fs.writeFileSync(fd, JSON.stringify({ version: 1, pid: process.pid })); fs.fsyncSync(fd);
      return await run();
    } finally {
      fs.closeSync(fd);
      const current = fs.lstatSync(this.safe('payments-state.lock'));
      if (current.ino === held.ino && current.dev === held.dev) fs.unlinkSync(lock);
    }
  }
  private eligible(t: Transport, chatId?: string): boolean { return t.name === 'telegram:lab' && t.boundAgentId === 'lab' && (chatId === undefined || PRIVATE.test(chatId)); }
  private async reply(t: Transport, chatId: string, text: string, buttons?: CardButton[]): Promise<void> {
    await t.push(chatId, { text, ...(buttons ? { card: { text: '', buttons } } : {}), dedupeKey: `lab-payments:${randomUUID()}` });
  }
  async menu(t: Transport, chatId: string, code?: string): Promise<void> {
    if (!this.eligible(t, chatId)) return;
    try {
      await this.locked(async () => {
        const config = this.config(); if (!config.enabled) { await this.reply(t, chatId, 'Запись на курс сейчас недоступна. ' + CONTACT); return; }
        const state = this.state();
        if (code !== undefined && code !== 'KRAFT') { await this.reply(t, chatId, 'Это предложение недоступно. ' + CONTACT); return; }
        if (code === 'KRAFT' && !config.offers?.KRAFT) { await this.reply(t, chatId, 'Это предложение недоступно. ' + CONTACT); return; }
        if (code === 'KRAFT') state.offers[chatId] = 'KRAFT';
        const offer = state.offers[chatId] === 'KRAFT' && !!config.offers?.KRAFT;
        const buttons: CardButton[] = config.links.map(link => {
          const reference = randomBytes(24).toString('hex');
          state.references[reference] = { chatId, created: Math.floor(Date.now() / 1000), paymentLinkId: link.paymentLinkId, productId: link.productId };
          const url = new URL(link.url); url.searchParams.set('client_reference_id', reference);
          if (offer) url.searchParams.set('prefilled_promo_code', config.offers!.KRAFT.code);
          return { label: link.label, action: 'lab:payment', url: url.toString() };
        });
        this.save(state);
        buttons.push({ label: 'Проверить оплату', action: 'lab:payment-check' }, { label: 'Написать Глебу', action: 'lab:contact', url: 'https://t.me/glebkalinin' });
        await this.reply(t, chatId, '**Goal-Driven AI**\nПрактическая работа с ИИ на ваших задачах: 8 встреч, записи и материалы.\n[Программа курса](https://agency-lab.glebkalinin.com/goal-driven-ai-01)\n\nВыберите вариант участия.' + (offer ? '\nКод KRAFT (скидка 50%) подставлен в ссылку. Код доступен для одного применения; итоговую сумму проверьте на странице оплаты.' : '') + (this.apiKey ? '\nПосле подтверждения оплаты приглашение обычно приходит в течение минуты. Можно также нажать «Проверить оплату».' : '\n' + UNAVAILABLE), buttons);
      });
    } catch { await this.reply(t, chatId, UNAVAILABLE); }
  }
  private async get(endpoint: string, params: URLSearchParams): Promise<any> {
    if (!this.apiKey) throw new Error('Payment verification unavailable');
    const response = await this.request(`https://api.stripe.com/v1/${endpoint}?${params}`, { method: 'GET', headers: { Authorization: `Bearer ${this.apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Payment verification unavailable');
    // Bound streamed bodies too; neither bodies nor credentials are logged or surfaced.
    if (!response.body || Number(response.headers.get('content-length') ?? 0) > 2 * 1024 * 1024) throw new Error('Invalid payment response');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Invalid payment response'); } chunks.push(part.value); }
    } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  private async sessions(link: string, created: number): Promise<any[]> {
    const sessions: any[] = []; let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const params = new URLSearchParams({ payment_link: link, 'created[gte]': String(created), limit: '100' }); if (cursor) params.set('starting_after', cursor);
      const data = await this.get('checkout/sessions', params);
      if (!record(data) || !Array.isArray(data.data) || typeof data.has_more !== 'boolean' || data.data.length > 100 || data.data.some((s: any) => !record(s) || !/^cs_[A-Za-z0-9_]+$/.test(s.id))) throw new Error('Invalid payment response');
      sessions.push(...data.data);
      if (!data.has_more) return sessions;
      const next = data.data.at(-1)?.id; if (!next || next === cursor) throw new Error('Incomplete payment history'); cursor = next;
    }
    throw new Error('Incomplete payment history');
  }
  private async validItems(sessionId: string, productId: string): Promise<boolean> {
    const data = await this.get(`checkout/sessions/${sessionId}/line_items`, new URLSearchParams({ limit: '100', 'expand[]': 'data.price.product' }));
    if (!record(data) || !Array.isArray(data.data) || typeof data.has_more !== 'boolean' || data.has_more) throw new Error('Incomplete payment items');
    if (data.data.length !== 1) return false;
    const item = data.data[0]; const product = item?.price?.product;
    return item.quantity === 1 && record(product) && product.id === productId && product.deleted !== true && product.metadata?.cohort_site === 'goal-driven-ai-01';
  }
  private async reconcile(t: Transport, chatId?: string): Promise<'sent' | 'already' | 'blocked' | 'unpaid' | 'empty'> {
    const config = this.config(); if (!config.enabled) throw new Error('Payments disabled');
    const state = this.state();
    const references = Object.entries(state.references).filter(([reference, r]) => (!chatId || r.chatId === chatId) && !Object.values(state.deliveries).some(d => d.reference === reference));
    let result: 'sent' | 'already' | 'blocked' | 'unpaid' | 'empty' = Object.values(state.deliveries).some(d => !chatId || state.references[d.reference].chatId === chatId) ? 'blocked' : 'empty';
    if (chatId && Object.values(state.deliveries).some(d => d.status === 'sent' && state.references[d.reference].chatId === chatId)) result = 'already';
    if (!references.length) return result;
    if (!this.apiKey) throw new Error('Payments unavailable');
    result = result === 'empty' ? 'unpaid' : result;
    // Fetch all relevant pages before sending anything. Incomplete history cannot grant access.
    const candidates: Array<{ id: string; reference: string }> = [];
    for (const link of config.links) {
      const selected = references.filter(([, r]) => r.paymentLinkId === link.paymentLinkId && r.productId === link.productId); if (!selected.length) continue;
      const sessions = await this.sessions(link.paymentLinkId, Math.min(...selected.map(([, r]) => r.created)));
      for (const session of sessions) {
        const selectedRef = selected.find(([ref]) => ref === session.client_reference_id); if (!selectedRef) continue;
        if (session.livemode !== this.livemode || session.mode !== 'payment' || session.status !== 'complete' || session.payment_status !== 'paid' || session.payment_link !== link.paymentLinkId || !Number.isSafeInteger(session.created) || session.created < selectedRef[1].created || own(state.deliveries, session.id)) continue;
        if (await this.validItems(session.id, link.productId)) candidates.push({ id: session.id, reference: selectedRef[0] });
      }
    }
    for (const candidate of candidates) {
      if (own(state.deliveries, candidate.id)) continue;
      const chat = state.references[candidate.reference].chatId;
      state.deliveries[candidate.id] = { reference: candidate.reference, status: 'pending' }; this.save(state);
      state.deliveries[candidate.id].status = 'sending'; this.save(state);
      try {
        await t.push(chat, { text: 'Оплата подтверждена. [Войти в группу курса](' + config.groupInviteUrl + ').\n\nДоступ к порталу и письмо с материалами оформляются отдельно: проверьте почту, указанную при оплате, и папку «Спам». ' + CONTACT, dedupeKey: `lab-payment:${candidate.id}` });
        state.deliveries[candidate.id].status = 'sent'; this.save(state); result = 'sent';
      } catch { result = 'blocked'; /* Ambiguous send or receipt failure: durable sending status blocks every retry. */ }
    }
    return result;
  }
  async check(t: Transport, chatId: string): Promise<void> {
    if (!this.eligible(t, chatId)) return;
    try {
      const result = await this.locked(() => this.reconcile(t, chatId));
      if (result === 'sent') return;
      if (result === 'already') { await this.reply(t, chatId, 'Приглашение уже отправлено в этот чат. ' + CONTACT); return; }
      await this.reply(t, chatId, result === 'blocked' ? 'Оплата уже зарегистрирована, но доставку приглашения нужно проверить вручную. ' + CONTACT : result === 'empty' ? 'Откройте меню курса и оплатите по своей кнопке, затем нажмите «Проверить оплату». ' + CONTACT : 'Подтверждённая оплата пока не найдена. Если вы уже оплатили, попробуйте проверить позже. ' + CONTACT);
    } catch { await this.reply(t, chatId, UNAVAILABLE); }
  }
  async tick(t: Transport): Promise<void> {
    if (!this.eligible(t)) return;
    try {
      if (!this.config().enabled) return;
      await this.locked(() => this.reconcile(t));
    } catch {
      // No private identifiers, response bodies, or credentials in operational logs.
      if (Date.now() - this.lastTickWarning >= 60 * 60 * 1000) { this.lastTickWarning = Date.now(); console.warn('[lab-payments] Automatic payment verification unavailable; durable state retained.'); }
    }
  }
}
