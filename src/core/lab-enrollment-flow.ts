import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { LabEnrollmentService, type EnrollmentRequest, type UsernameEnrollmentGrant } from './lab-enrollment.js';
import type { IncomingMedia, Transport } from './types.js';
import { errorMessage } from './util.js';

const CONTACT = 'Напишите [@glebkalinin](https://t.me/glebkalinin), если нужна помощь.';
const PROMPTS = [
  'Чего вы ждёте от лаборатории? Какую задачу хотелось бы решить с ИИ? Можно ответить текстом или голосом.',
  'Расскажите немного о себе: чем вы занимаетесь и какой у вас опыт с ИИ? Можно ответить текстом, голосом или «пропустить».',
  'Что в работе с ИИ вас вдохновляет, а что беспокоит или пугает? Какая помощь вам была бы полезна? Можно ответить текстом, голосом или «пропустить».',
  'Укажите email, с которым вы войдёте на сайт. Доступ появится после входа с подтверждённым email или Google с тем же адресом.',
];
export interface LabEnrollmentControl {
  list(query?: string): EnrollmentRequest[];
  listGrants(): Omit<ReturnType<LabEnrollmentService['issueFree']>['grant'], 'tokenHash'>[];
  /** pre-approved usernames (deep links /start user_<name>) */
  listUsernames(): UsernameEnrollmentGrant[];
  issueUsername(username: string, ttlMs?: number): UsernameEnrollmentGrant;
  revokeUsername(grantId: string): UsernameEnrollmentGrant;
  approve(id: string, note?: string): Promise<EnrollmentRequest>;
  reject(id: string, note?: string): Promise<EnrollmentRequest>;
  issue(chatId: string, ttlMs?: number): { token: string; grant: ReturnType<LabEnrollmentService['issueFree']>['grant']; url: string };
  revoke(grantId: string): ReturnType<LabEnrollmentService['revokeFree']>;
  evidence(id: string): { localPath: string; sha256: string; bytes: number } | undefined;
}

/** Fixed enrollment conversation. Never invokes an agent or treats submitted proof as verified. */
export class LabEnrollmentFlow {
  readonly service: LabEnrollmentService;
  private readonly uploads: string;
  constructor(private readonly root: string, readonly ownerId: string, private readonly secret: () => string | undefined = () => process.env.LAB_ENROLLMENT_SECRET) {
    this.uploads = path.join(root, 'enrollment-uploads');
    // Root is validated before creating descendants, so a symbolic-link root cannot redirect the write.
    new LabEnrollmentService({ rootDir: root, ownerId });
    if (!fs.existsSync(this.uploads)) fs.mkdirSync(this.uploads, { mode: 0o700 });
    this.service = new LabEnrollmentService({ rootDir: root, uploadsDir: this.uploads, ownerId });
  }
  private async reply(t: Transport, chatId: string, text: string): Promise<void> {
    await t.push(chatId, { text, dedupeKey: `lab-enrollment:${randomUUID()}` });
  }
  private claimLink(r: EnrollmentRequest): string | undefined {
    const secret = this.secret();
    if (!secret || secret.length < 32 || r.status !== 'approved' || !r.email) return;
    const payload = { v: 1, requestId: r.id, kind: r.method === 'free' ? 'free' : 'manual_crypto', site: 'goal-driven-ai-01', email: r.email, exp: Math.floor(Date.now() / 1000) + 3600 };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', secret).update(encoded).digest('hex');
    return `https://agency-lab.glebkalinin.com/enroll#token=${encoded}.${signature}`;
  }
  private async completion(t: Transport, r: EnrollmentRequest): Promise<void> {
    if (!r.email) { await this.reply(t, r.chatId, PROMPTS[3]); return; }
    const link = this.claimLink(r);
    await this.reply(t, r.chatId, link
      ? `Участие подтверждено. [Войти на сайт и получить доступ](${link}). Используйте ${r.email}: подтвердите email или войдите через Google с этим адресом. Ссылка действует 1 час. Если она истечёт, напишите /enroll.`
      : 'Участие подтверждено. Настройка входа на сайт ещё не завершена; доступ на сайте пока не выдан. ' + CONTACT);
  }
  async handle(t: Transport, chatId: string, request: string, source: 'text' | 'voice' = 'text', media?: IncomingMedia): Promise<boolean> {
    if (t.name !== 'telegram:lab' || t.boundAgentId !== 'lab' || !/^[1-9]\d*$/.test(chatId)) return false;
    let text = (request === 'lab:crypto' ? '/crypto' : request === 'lab:enroll' ? '/enroll' : request).trim().replace(/^(\/[a-z0-9_]+)@[a-z0-9_]+(?=\s|$)/i, '$1');
    const existing = this.service.requestForChat(chatId);
    if (text === '/start' && existing) text = '/enroll';
    const free = /^\/start\s+free_([A-Za-z0-9_-]{32})$/.exec(text);
    const issue = /^\/freeaccess(?:\s+(\d+))?$/.exec(text);
    // deep link by pre-approved username: /start user_<name> (or /start <name> / @<name> when a grant exists)
    const approveUser = /^\/approveuser(?:@\w+)?\s*([^\s]*)$/.exec(text);
    const startParam = /^\/start\s+(?:@)?([A-Za-z0-9_-]{1,64})(?=$|\s)/.exec(text);
    const userClaim = startParam && !free ? ((raw: string) => { const name = raw.startsWith('user_') ? raw.slice(5) : raw; return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(name) && this.service.hasUsernamePreapproval(name) ? name : undefined; })(startParam[1]) : undefined;
    const explicit = !!free || !!issue || !!userClaim || !!approveUser || /^\/(?:start\s+crypto|crypto|enroll)(?:\s|$)/i.test(text);
    if (!explicit && !media && text.startsWith('/')) return false;
    if (!explicit && !existing && !this.service.awaitingCrypto(chatId)) return false;
    try {
      if (issue) {
        if (chatId !== this.ownerId) { await this.reply(t, chatId, 'Эта команда доступна только администратору.'); return true; }
        if (!issue[1]) { await this.reply(t, chatId, 'Укажите Telegram ID получателя: /freeaccess CHAT_ID'); return true; }
        const issued = this.issue(issue[1]);
        await this.reply(t, chatId, `Персональная ссылка для Telegram ${issue[1]} (один раз, 7 дней):\n${issued.url}`); return true;
      }
      if (free) { const r = this.service.claimFree(chatId, free[1]); await this.reply(t, chatId, PROMPTS[r.answers.length]); return true; }
      if (userClaim) {
        try { const r = this.service.claimUsername(chatId, userClaim); await this.reply(t, chatId, PROMPTS[r.answers.length]); }
        catch (e) { await this.reply(t, chatId, `Не получилось: ${errorMessage(e)}. ${CONTACT}`); }
        return true;
      }
      if (approveUser) {
        if (chatId !== this.ownerId) return true; // silent: participants never learn the admin command exists
        const arg = approveUser[1];
        if (!arg || /^list$/i.test(arg)) {
          const list = this.service.listUsernames();
          await this.reply(t, chatId, list.length
            ? `Предодобренные username:
${list.map(u => `@${u.username} — ${u.redeemedAt ? 'активировано' : u.revokedAt ? 'отозвано' : u.expiresAt !== undefined && u.expiresAt < Date.now() ? 'истекло' : 'активна'}`).join('\n')}`
            : 'Предодобренных username пока нет. /approveuser @name — выдать одноразовую ссылку.');
          return true;
        }
        try {
          const grant = this.service.issueUsername(this.ownerId, arg);
          await this.reply(t, chatId, `Предодобрено @${grant.username} (один раз, 14 дней). Перешлите пользователю эту ссылку:
https://t.me/agency_lab_companion_bot?start=user_${grant.username}`);
        } catch (e) { await this.reply(t, chatId, `Не вышло: ${errorMessage(e)}`); }
        return true;
      }
      if (/^\/(?:start\s+crypto|crypto)$/i.test(text)) {
        this.service.beginCrypto(chatId);
        await this.reply(t, chatId, 'Отправьте текст с хешем транзакции или скриншот перевода. Глеб проверит перевод вручную; скриншот сам по себе не подтверждает оплату.'); return true;
      }
      if (text === '/enroll') {
        if (existing?.status === 'approved') await this.completion(t, existing);
        else if (existing?.status === 'questionnaire') await this.reply(t, chatId, PROMPTS[existing.answers.length]);
        else if (existing?.status === 'pending_review') await this.reply(t, chatId, existing.email ? 'Подтверждение перевода ожидает ручной проверки.' : PROMPTS[3]);
        else await this.reply(t, chatId, 'Для бесплатного участия нужна персональная одноразовая ссылка. Для перевода в криптовалюте: /crypto. ' + CONTACT);
        return true;
      }
      if (existing?.status === 'questionnaire') {
        if (media) { await this.reply(t, chatId, 'На этот вопрос ответьте текстом или голосом.'); return true; }
        const r = this.service.saveAnswer(chatId, text, source);
        if (r.status === 'approved') await this.completion(t, r); else await this.reply(t, chatId, PROMPTS[r.answers.length]);
        return true;
      }
      if (existing && ['pending_review', 'approved'].includes(existing.status) && !existing.email && !media) {
        const r = this.service.setEmail(chatId, text);
        if (r.status === 'approved') await this.completion(t, r); else await this.reply(t, chatId, 'Email сохранён. Перевод ожидает ручной проверки Глебом.');
        return true;
      }
      if (this.service.awaitingCrypto(chatId)) {
        let localPath: string | undefined;
        if (media) {
          if (media.kind !== 'photo' && media.kind !== 'document') { await this.reply(t, chatId, 'Отправьте скриншот перевода или хеш транзакции текстом.'); return true; }
          const st = fs.lstatSync(media.filePath);
          if (!st.isFile() || st.isSymbolicLink() || st.size > 20 * 1024 * 1024 || st.size < 12) throw new Error('Invalid screenshot');
          localPath = path.join(this.uploads, `${randomUUID()}.image`);
          fs.copyFileSync(media.filePath, localPath, fs.constants.COPYFILE_EXCL); fs.chmodSync(localPath, 0o600);
        }
        const r = this.service.submitCrypto(chatId, { ...(text && text !== '/start' ? { text } : {}), ...(localPath ? { localPath } : {}) });
        await this.reply(t, chatId, 'Подтверждение принято на ручную проверку. ' + PROMPTS[3]);
        await this.reply(t, this.ownerId, `Новая заявка на ручную проверку криптоперевода: ${r.id}. Telegram ${chatId}. Откройте заявки в панели администратора.`);
        return true;
      }
      if (media) return false;
      if (existing?.status === 'pending_review') { await this.reply(t, chatId, 'Перевод ожидает ручной проверки. ' + CONTACT); return true; }
      // Approved participants who already belong to the group retain normal companion conversations.
      return false;
    } catch {
      await this.reply(t, chatId, 'Не удалось продолжить запись. Проверьте ссылку или ответ: цель и email обязательны, контекст и помощь можно пропустить. ' + CONTACT);
      return true;
    }
  }
  issue(chatId: string, ttlMs?: number): ReturnType<LabEnrollmentControl['issue']> {
    const issued = this.service.issueFree(this.ownerId, chatId, ttlMs);
    return { ...issued, url: `https://t.me/agency_lab_companion_bot?start=free_${issued.token}` };
  }
  control(transport: () => Transport | undefined): LabEnrollmentControl {
    return {
      list: query => this.service.list().filter(r => !query || JSON.stringify({ id: r.id, chatId: r.chatId, email: r.email, status: r.status, method: r.method }).toLowerCase().includes(query.toLowerCase())), listGrants: () => this.service.listGrants(), issue: (chat, ttl) => this.issue(chat, ttl), revoke: id => this.service.revokeFree(this.ownerId, id),
      listUsernames: () => this.service.listUsernames(),
      issueUsername: (username, ttl) => this.service.issueUsername(this.ownerId, username, ttl),
      revokeUsername: id => this.service.revokeUsername(this.ownerId, id),
      approve: async (id, note) => {
        const t = transport(); if (!t) throw new Error('Lab transport unavailable');
        let r = this.service.getById(id);
        if (!r) throw new Error('Enrollment not found');
        // An approved request can retry delivery after a transport failure without reapproving payment.
        if (r.status !== 'approved') r = this.service.approve(this.ownerId, id, note);
        await this.completion(t, r); return r;
      },
      reject: async (id, note) => {
        const r = this.service.reject(this.ownerId, id, note); const t = transport();
        if (t) await this.reply(t, r.chatId, 'Подтверждение перевода не принято. ' + (note ? `Комментарий: ${note}\n` : '') + CONTACT);
        return r;
      },
      evidence: id => {
        const e = this.service.getById(id)?.evidence;
        return e?.localPath && e.sha256 && e.bytes ? { localPath: e.localPath, sha256: e.sha256, bytes: e.bytes } : undefined;
      },
    };
  }
}
