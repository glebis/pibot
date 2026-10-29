import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { LabCompanion, labMenu, labContactLinks } from './lab-companion.js';
import type { Transport } from './types.js';

describe('private lab companion', () => {
  let root: string; let lab: LabCompanion; let t: Transport;
  const write = (file: string, value: unknown) => { const p = path.join(root, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value)); };
  const profiles = () => write('participants.json', { participants: [
    { key: 'alice', identity_status: 'confirmed', telegram_user_id: 42, recommendation_file: 'alice.md' },
    { key: 'bob', identity_status: 'confirmed', telegram_user_id: 43, recommendation_file: 'bob.md' },
  ] });
  function lesson(overrides = {}) {
    write('lessons/one/transcript.md', 'PRIVATE TRANSCRIPT NEVER SHARED');
    write('lessons/one/participants/alice/recommendations.md', 'New advice for Alice');
    write('lessons/one/participants/bob/recommendations.md', 'New advice for Bob');
    write('lessons/one/manifest.json', { status: 'finalized', approved: true, transcript_file: 'transcript.md', transcript_sha256: createHash('sha256').update('PRIVATE TRANSCRIPT NEVER SHARED').digest('hex'), recipient_files: { alice: 'participants/alice/recommendations.md', bob: 'participants/bob/recommendations.md' }, ...overrides });
  }
  beforeEach(() => {
    vi.unstubAllGlobals();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-companion-')); lab = new LabCompanion(root);
    t = { name: 'telegram:lab', boundAgentId: 'lab', push: vi.fn().mockResolvedValue(undefined) } as unknown as Transport;
    profiles(); write('alice.md', 'Alice only'); write('bob.md', 'Bob only');
    write('participants/alice/homework.md', 'Alice homework');
    write('public/models.md', 'Offline model instructions');
  });
  it('persists every private reply with dedupe and attributed profile evidence across restarts', () => {
    lab.recordConversation(t, '42', 'user', 'Моя цель — автоматизировать типографию', 123, 'Какова ваша цель?');
    lab.recordConversation(t, '42', 'user', 'Моя цель — автоматизировать типографию', 123, 'Какова ваша цель?');
    lab.recordConversation(t, '42', 'assistant', 'Начните с одной проверяемой задачи.', 'answer-123');
    lab.recordConversation(t, '42', 'user', 'спасибо', 124);
    const restored = new LabCompanion(root);
    expect(restored.context(t, '42')).toContain('автоматизировать типографию');
    expect(restored.context(t, '43')).not.toContain('автоматизировать типографию');
    const profile = JSON.parse(fs.readFileSync(path.join(root, 'conversations/42/profile.json'), 'utf8'));
    expect(profile.evidence_message_ids).toHaveLength(2); expect(profile.memory).toHaveLength(1);
    expect(profile.memory[0].question).toBe('Какова ваша цель?');
    expect(fs.statSync(path.join(root, 'conversations/42/profile.json')).mode & 0o777).toBe(0o600);
  });
  it('remembers short contextual answers but keeps one-off replies out of durable memory', () => {
    lab.recordConversation(t, '42', 'assistant', 'Какой редактор используете?');
    lab.recordConversation(t, '42', 'user', 'Codex', 1);
    lab.recordConversation(t, '42', 'user', 'Следующий вторник подходит лучше', 2, 'Когда встретиться?');
    const profile = JSON.parse(fs.readFileSync(path.join(root, 'conversations/42/profile.json'), 'utf8'));
    expect(profile.memory).toHaveLength(1); expect(profile.memory[0].self_report).toBe('Codex');
    expect(profile.evidence_message_ids).toHaveLength(2);
  });
  it('retains unconfirmed chat replies without assigning a guessed participant', () => {
    expect(lab.recordConversation(t, '77', 'user', 'Я работаю с исследованиями пользователей', 1)).toBe(true);
    expect(lab.context(t, '77')).toContain('исследованиями');
    expect(JSON.parse(fs.readFileSync(path.join(root, 'conversations/77/profile.json'), 'utf8')).participant_key).toBeNull();
    expect(lab.recordConversation(t, '-1001', 'user', 'private group message', 1)).toBe(false);
  });
  it('keeps preview conversations separate from the real participant and excludes secrets from memory', async () => {
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'participants.json'), 'utf8'));
    write('participants.json', { ...registry, owner_telegram_user_id: 99 });
    await lab.userView(t, '99', 'alice');
    lab.recordConversation(t, '99', 'user', 'Я хочу preview-only project', 1);
    expect(lab.context(t, '99')).toContain('preview-only');
    expect(lab.context(t, '42')).not.toContain('preview-only');
    expect(fs.existsSync(path.join(root, 'conversations'))).toBe(false);
    lab.recordConversation(t, '42', 'user', 'my password is private-secret-value', 2, 'What is your goal?');
    expect(lab.context(t, '42')).not.toContain('private-secret-value');
    expect(JSON.parse(fs.readFileSync(path.join(root, 'conversations/42/profile.json'), 'utf8')).memory).toHaveLength(0);
  });
  it('sends an existing personal illustration before the start menu and safely skips absent artwork', async () => {
    t.sendMedia = vi.fn().mockResolvedValue(undefined);
    write('participants/alice/illustration.png', 'PNG fixture');
    await lab.handle(t, '42', 'start');
    expect(t.sendMedia).toHaveBeenCalledWith('42', path.join(root, 'participants/alice/illustration.png'));
    await lab.handle(t, '43', 'start'); expect(t.sendMedia).toHaveBeenCalledTimes(1);
  });
  it('gives participants one stateful notification control and reserves payment for nonparticipants', () => {
    for (const subscribed of [false, true]) {
      const buttons = labMenu({ subscribed }).buttons;
      expect(buttons.some(button => button.action === 'lab:payment')).toBe(false);
      const notifications = buttons.filter(button => /notifications|subscribe|unsubscribe/.test(button.action));
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual(expect.objectContaining({ action: 'lab:notifications', label: expect.stringContaining(subscribed ? 'включены' : 'выключены') }));
    }
    expect(labMenu()).toEqual(labMenu({ enrolled: true, subscribed: false }));
    const publicButtons = labMenu({ enrolled: false, subscribed: true }).buttons;
    expect(publicButtons.filter(button => button.action === 'lab:payment')).toHaveLength(1);
    expect(publicButtons.some(button => /notifications|subscribe|unsubscribe/.test(button.action))).toBe(false);
  });
  it('toggles notification state durably and returns the updated menu across restarts', async () => {
    expect(await lab.handle(t, '42', 'notifications')).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'subscriptions.json'), 'utf8'))).toEqual({ '42': true });
    expect(t.push).toHaveBeenLastCalledWith('42', expect.objectContaining({ card: labMenu({ subscribed: true }) }));
    const restored = new LabCompanion(root);
    expect(await restored.handle(t, '42', 'notifications')).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'subscriptions.json'), 'utf8'))).toEqual({ '42': false });
    expect(t.push).toHaveBeenLastCalledWith('42', expect.objectContaining({ card: labMenu({ subscribed: false }) }));
    await restored.handle(t, '42', 'start');
    expect(t.push).toHaveBeenLastCalledWith('42', expect.objectContaining({ card: labMenu({ subscribed: false }) }));
  });
  it('toggles preview notifications in memory while preserving participant state', async () => {
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'participants.json'), 'utf8'));
    write('participants.json', { ...registry, owner_telegram_user_id: 99 });
    write('subscriptions.json', { '42': true });
    const before = fs.readFileSync(path.join(root, 'subscriptions.json'));
    await lab.userView(t, '99', 'alice');
    expect(await lab.handle(t, '99', 'notifications')).toBe(true);
    expect(t.push).toHaveBeenLastCalledWith('99', expect.objectContaining({ card: labMenu({ subscribed: false }) }));
    await lab.handle(t, '99', 'menu');
    expect(t.push).toHaveBeenLastCalledWith('99', expect.objectContaining({ card: labMenu({ subscribed: false }) }));
    expect(await lab.handle(t, '99', 'notifications')).toBe(true);
    expect(t.push).toHaveBeenLastCalledWith('99', expect.objectContaining({ card: labMenu({ subscribed: true }) }));
    expect(fs.readFileSync(path.join(root, 'subscriptions.json'))).toEqual(before);
    expect(fs.existsSync(path.join(root, 'receipts'))).toBe(false);
    expect(vi.mocked(t.push).mock.calls.every(([id]) => id === '99')).toBe(true);
  });
  it('gives each verified recording its own title and two URL buttons below a separate heading', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ cohort: 'goal-driven-ai-01', meetings: [
      { number: '01', title: 'Встреча 01. Первые шаги', video_url: 'https://www.youtube.com/watch?v=known', publication_status: 'draft', summary_md: 'Evidence based notes' },
      { number: '02', title: 'Later', video_url: null },
      { number: '../secret', title: 'Invalid', video_url: 'https://youtube.com/video' },
      { number: '03', title: 'Unsafe', video_url: 'javascript:bad' },
      { number: '04', title: 'Занятие 04 · Следующий шаг', video_url: 'https://www.youtube.com/watch?v=next' },
    ] }))));
    await lab.handle(t, '77', 'recordings');
    const messages = vi.mocked(t.push).mock.calls.map(([, message]) => message);
    expect(messages[0].text).toContain('Записи занятий');
    expect(messages[0].text).not.toContain('Первые шаги');
    const recordings = messages.filter(message => message.card?.buttons.some(button => button.label.includes('Смотреть запись')));
    expect(recordings).toHaveLength(2);
    for (const [index, title] of ['Первые шаги', 'Следующий шаг'].entries()) {
      const recording = recordings[index];
      expect(recording.text).toContain(title);
      expect(recording.text.match(/(?:Встреча|Занятие)\s*0[14]/gi)).toHaveLength(1);
      expect(recording.text).not.toContain('https://');
      expect(recording.card?.columns).toBe(1);
      expect(recording.card?.buttons.map(button => button.label)).toEqual([expect.stringContaining('Смотреть запись'), 'Материалы занятия']);
      expect(recording.card?.buttons.map(button => button.url)).toEqual([
        `https://www.youtube.com/watch?v=${index ? 'next' : 'known'}`,
        `https://agency-lab.glebkalinin.com/goal-driven-ai-01/meetings/${index ? '04' : '01'}`,
      ]);
    }
    expect(messages.map(message => message.text).join('\n')).not.toMatch(/Later|Invalid|Unsafe|javascript:/);
    expect(await lab.recordingsContext(t, '42')).toContain('Evidence based notes');
    expect(await lab.recordingsContext(t, '-100')).toBe('');
  });
  it('fails gracefully when recording feed is unavailable and uses curated fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    write('public/recordings.md', 'Curated recording guide');
    await lab.handle(t, '42', 'recordings');
    expect(vi.mocked(t.push).mock.calls.at(-1)?.[1].text).toBe('Curated recording guide');
  });
  it('saves scoped generated Markdown only for a confirmed participant and keeps preview read-only', async () => {
    expect(lab.savePersonalizedRecommendation(t, '77', 'Unknown')).toBe(false);
    expect(lab.savePersonalizedRecommendation(t, '42', '# Personal plan')).toBe(true);
    const latest = JSON.parse(fs.readFileSync(path.join(root, 'conversations/42/latest-recommendation.json'), 'utf8'));
    expect(fs.readFileSync(path.join(root, latest.file), 'utf8')).toBe('# Personal plan');
    expect(fs.statSync(path.join(root, latest.file)).mode & 0o777).toBe(0o600);
    lab.recordConversation(t, '42', 'user', 'Моя цель — реальный проект', 1);
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'participants.json'), 'utf8'));
    write('participants.json', { ...registry, owner_telegram_user_id: 99 });
    await lab.userView(t, '99', 'alice');
    expect(lab.context(t, '99')).toContain('реальный проект');
    expect(lab.savePersonalizedRecommendation(t, '99', '# Preview plan')).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'conversations/42/latest-recommendation.json'), 'utf8')).file).toBe(latest.file);
    expect(fs.existsSync(path.join(root, 'conversations/99'))).toBe(false);
  });
  it('saves explicit feedback, forwards only to owner and deduplicates retries', async () => {
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'participants.json'), 'utf8'));
    write('participants.json', { ...registry, owner_telegram_user_id: 99 });
    expect(await lab.handleFeedback(t, '42', 'I HAVE FEEDBACK, about the bot: make menus clearer', 700)).toBe(true);
    const ownerCalls = () => vi.mocked(t.push).mock.calls.filter(([id]) => id === '99');
    expect(ownerCalls()).toHaveLength(1); expect(ownerCalls()[0][1].text).toContain('make menus clearer');
    const source = fs.readdirSync(path.join(root, 'feedback')).find(f => /^[a-f0-9]{64}\.json$/.test(f))!;
    const entry = JSON.parse(fs.readFileSync(path.join(root, 'feedback', source), 'utf8'));
    expect(entry.target).toBe('bot'); expect(entry.participant_key).toBe('alice');
    expect(fs.readFileSync(path.join(root, 'feedback', source.replace('.json', '.md')), 'utf8')).toContain('make menus clearer');
    await lab.handleFeedback(t, '42', 'I HAVE FEEDBACK, about the bot: make menus clearer', 700);
    expect(ownerCalls()).toHaveLength(1); expect(fs.existsSync(path.join(root, 'conversations'))).toBe(false);
  });
  it('retains failed feedback without replay and acknowledges honestly', async () => {
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'participants.json'), 'utf8'));
    write('participants.json', { ...registry, owner_telegram_user_id: 99 });
    vi.mocked(t.push).mockImplementation(async id => { if (id === '99') throw new Error('ambiguous send'); });
    await lab.handleFeedback(t, '77', 'У меня есть отзыв: О курсе: хочу больше примеров', 701);
    expect(vi.mocked(t.push).mock.calls.at(-1)?.[1].text).toContain('доставку Глебу подтвердить не удалось');
    await lab.handleFeedback(t, '77', 'У меня есть отзыв: О курсе: хочу больше примеров', 701);
    expect(vi.mocked(t.push).mock.calls.filter(([id]) => id === '99')).toHaveLength(1);
    const source = fs.readdirSync(path.join(root, 'feedback')).find(f => /^[a-f0-9]{64}\.json$/.test(f))!;
    expect(JSON.parse(fs.readFileSync(path.join(root, 'feedback', source), 'utf8')).participant_key).toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(root, 'feedback', source), 'utf8')).target).toBe('course');
  });
  it('captures the next feedback response durably while preserving slash commands and cancellation', async () => {
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'participants.json'), 'utf8'));
    write('participants.json', { ...registry, owner_telegram_user_id: 99 });
    await lab.handleFeedback(t, '42', 'I have feedback', 1);
    const restored = new LabCompanion(root);
    expect(await restored.handleFeedback(t, '42', '/start', 2)).toBe(false);
    expect(await restored.handleFeedback(t, '42', 'The course and bot are useful', 3)).toBe(true);
    const source = fs.readdirSync(path.join(root, 'feedback')).find(f => /^[a-f0-9]{64}\.json$/.test(f))!;
    expect(JSON.parse(fs.readFileSync(path.join(root, 'feedback', source), 'utf8')).target).toBe('unspecified');
    await restored.handle(t, '42', 'feedback');
    expect(await restored.handleFeedback(t, '42', 'отмена', 4)).toBe(true);
    expect(await restored.handleFeedback(t, '42', 'normal answer', 5)).toBe(false);
  });
  it('simulates preview feedback without forwarding or saving and rejects groups', async () => {
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'participants.json'), 'utf8'));
    write('participants.json', { ...registry, owner_telegram_user_id: 99 });
    await lab.userView(t, '99', 'alice'); vi.mocked(t.push).mockClear();
    await lab.handle(t, '99', 'feedback');
    await lab.handleFeedback(t, '99', 'О боте: тест', 1);
    expect(fs.existsSync(path.join(root, 'feedback'))).toBe(false);
    expect(vi.mocked(t.push).mock.calls.at(-1)?.[1].text).toContain('Настоящее сообщение Глебу не отправлено');
    expect(await lab.handleFeedback(t, '-100', 'I have feedback: secret', 2)).toBe(false);
    expect(await lab.handleFeedback(t, '42', 'I have feedbackish text', 3)).toBe(false);
  });
  it('isolates own private content and context', async () => {
    await lab.handle(t, '42', 'recommendations'); expect(t.push).toHaveBeenCalledWith('42', expect.objectContaining({ text: 'Alice only', card: labMenu() }));
    const context = lab.context(t, '42'); expect(context).toContain('Alice homework'); expect(context).not.toContain('Bob'); expect(context.length).toBeLessThanOrEqual(12000);
  });
  it('gives repeated user pulls distinct dedupe identities', async () => {
    await lab.handle(t, '42', 'recommendations'); await lab.handle(t, '42', 'recommendations');
    const calls = vi.mocked(t.push).mock.calls;
    expect(calls[0][1].dedupeKey).toBeTruthy();
    expect(calls[0][1].dedupeKey).not.toBe(calls[1][1].dedupeKey);
  });
  it('owner previews a confirmed profile exclusively into owner chat without persistent writes', async () => {
    const file = path.join(root, 'participants.json'); const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
    write('participants.json', { ...registry, owner_telegram_user_id: 100000001 });
    const before = fs.readdirSync(root).sort();
    expect(await lab.preview(t, '100000001', 'alice')).toBe(true);
    expect(t.push).toHaveBeenCalledWith('100000001', expect.objectContaining({ text: 'Тест для владельца: alice (recommendations)\n\nAlice only' }));
    expect(fs.readdirSync(root).sort()).toEqual(before);
    expect(fs.existsSync(path.join(root, 'subscriptions.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'receipts'))).toBe(false);
  });
  it('keeps legacy owner preview selected for subsequent menu clicks without participant writes', async () => {
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'participants.json'), 'utf8'));
    write('participants.json', { ...registry, owner_telegram_user_id: 99 });
    await lab.preview(t, '99', 'alice'); await lab.handle(t, '99', 'homework'); await lab.handle(t, '99', 'subscribe');
    expect(vi.mocked(t.push).mock.calls.at(-2)?.[1].text).toContain('Alice homework');
    expect(vi.mocked(t.push).mock.calls.every(([id]) => id === '99')).toBe(true);
    expect(fs.existsSync(path.join(root, 'subscriptions.json'))).toBe(false);
    expect(lab.context(t, '99')).toContain('OWNER PREVIEW');
  });
  it('guides an owner without selection to available participant keys', async () => {
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'participants.json'), 'utf8'));
    write('participants.json', { ...registry, owner_telegram_user_id: 99 });
    for (const action of ['start', 'menu', 'recommendations', 'homework', 'subscribe']) {
      await lab.handle(t, '99', action);
      const text = vi.mocked(t.push).mock.calls.at(-1)?.[1].text;
      expect(text).toContain('/userview alice'); expect(text).toContain('bob'); expect(text).not.toContain('не подтверждён');
    }
    expect(fs.existsSync(path.join(root, 'subscriptions.json'))).toBe(false);
  });
  it('links contact copy from fallback and stored Markdown while retaining existing links and receipt identity', async () => {
    const linked = 'Напишите [@glebkalinin](https://t.me/glebkalinin)';
    expect(labContactLinks('[goal-driven-ai](/goal-driven-ai-01/materials/plugin)')).toBe('[goal-driven-ai](https://agency-lab.glebkalinin.com/goal-driven-ai-01/materials/plugin)');
    expect(labContactLinks('напиши Глебу; ' + linked)).toBe('напиши [@glebkalinin](https://t.me/glebkalinin); ' + linked);
    expect(labContactLinks('[Напишите Глебу](https://t.me/glebkalinin)')).toBe('[Напишите Глебу](https://t.me/glebkalinin)');
    await lab.handle(t, '99', 'recommendations'); expect(vi.mocked(t.push).mock.calls.at(-1)?.[1].text).toContain(linked);
    write('alice.md', 'Напишите Глебу для помощи.'); await lab.handle(t, '42', 'recommendations');
    expect(vi.mocked(t.push).mock.calls.at(-1)?.[1].text).toBe(linked + ' для помощи.');
    lesson(); const raw = 'Напишите Глебу после занятия.'; write('lessons/one/participants/alice/recommendations.md', raw);
    await lab.handle(t, '42', 'start'); await lab.tick(t, async () => true);
    expect(vi.mocked(t.push).mock.calls.at(-1)?.[1].text).toBe(linked + ' после занятия.');
    const hash = createHash('sha256').update(raw).digest('hex');
    expect(fs.readdirSync(path.join(root, 'receipts'))).toEqual([hash + '-42.json']);
    expect(fs.readFileSync(path.join(root, 'lessons/one/participants/alice/recommendations.md'), 'utf8')).toBe(raw);
    await lab.tick(t, async () => true); expect(fs.readdirSync(path.join(root, 'receipts'))).toHaveLength(1);
  });
  it('rejects participant cross-preview, group, candidate, unknown kind and duplicate identity', async () => {
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'participants.json'), 'utf8'));
    write('participants.json', { ...registry, owner_telegram_user_id: 100000001 });
    expect(await lab.preview(t, '42', 'bob')).toBe(false);
    expect(await lab.preview(t, '-1001', 'bob')).toBe(false);
    expect(await lab.preview(t, '100000001', 'alice', '../bob')).toBe(false);
    registry.participants[0].identity_status = 'candidate';
    write('participants.json', { ...registry, owner_telegram_user_id: 100000001 });
    expect(await lab.preview(t, '100000001', 'alice')).toBe(false);
    registry.participants[0].identity_status = 'confirmed'; registry.participants[1].telegram_user_id = 42;
    write('participants.json', { ...registry, owner_telegram_user_id: 100000001 });
    expect(await lab.preview(t, '100000001', 'alice')).toBe(false);
    expect(t.push).not.toHaveBeenCalled();
  });
  it('views selected participant menu, content and context only in owner chat, then switches and exits', async () => {
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'participants.json'), 'utf8'));
    write('participants.json', { ...registry, owner_telegram_user_id: 99 });
    expect(await lab.userView(t, '99')).toBe(true);
    expect(await lab.userView(t, '99', 'alice')).toBe(true);
    await lab.handle(t, '99', 'recommendations');
    expect(t.push).toHaveBeenLastCalledWith('99', expect.objectContaining({ text: expect.stringContaining('Alice only'), card: labMenu({ subscribed: true }) }));
    expect(lab.context(t, '99')).toContain('OWNER PREVIEW'); expect(lab.context(t, '99')).not.toContain('Bob only');
    await lab.userView(t, '99', 'bob'); await lab.handle(t, '99', 'recommendations');
    expect(t.push).toHaveBeenLastCalledWith('99', expect.objectContaining({ text: expect.stringContaining('Bob only') }));
    expect(lab.context(t, '99')).not.toContain('Alice only');
    expect(vi.mocked(t.push).mock.calls.every(([id]) => id === '99')).toBe(true);
    await lab.userView(t, '99', 'off'); expect(lab.context(t, '99')).toBe('');
  });
  it('simulates subscriptions without changing bytes or creating receipts', async () => {
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'participants.json'), 'utf8'));
    write('participants.json', { ...registry, owner_telegram_user_id: 99 });
    write('subscriptions.json', { '42': false }); const before = fs.readFileSync(path.join(root, 'subscriptions.json'));
    await lab.userView(t, '99', 'alice'); await lab.handle(t, '99', 'subscribe'); await lab.handle(t, '99', 'start');
    expect(vi.mocked(t.push).mock.calls.at(-1)?.[1].text).toContain('включены');
    await lab.handle(t, '99', 'unsubscribe');
    expect(fs.readFileSync(path.join(root, 'subscriptions.json'))).toEqual(before);
    expect(fs.existsSync(path.join(root, 'receipts'))).toBe(false);
  });
  it('rejects unauthorized selection and revokes preview when registry identity changes', async () => {
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'participants.json'), 'utf8'));
    write('participants.json', { ...registry, owner_telegram_user_id: 99 });
    expect(await lab.userView(t, '42', 'bob')).toBe(false);
    expect(await lab.handle(t, '42', 'lesson')).toBe(false);
    await lab.userView(t, '99', 'missing'); expect(lab.context(t, '99')).toBe('');
    await lab.userView(t, '99', 'alice');
    registry.participants[0].identity_status = 'candidate'; write('participants.json', { ...registry, owner_telegram_user_id: 99 });
    expect(lab.context(t, '99')).toBe('');
    await lab.handle(t, '99', 'recommendations'); expect(vi.mocked(t.push).mock.calls.at(-1)?.[1].text).not.toContain('Alice only');
  });
  it('previews exact newest approved outgoing lesson body without delivery effects', async () => {
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'participants.json'), 'utf8'));
    write('participants.json', { ...registry, owner_telegram_user_id: 99 });
    await lab.handle(t, '99', 'lesson'); expect(vi.mocked(t.push).mock.calls.at(-1)?.[1].text).toContain('/userview KEY');
    await lab.userView(t, '99', 'alice'); await lab.handle(t, '99', 'lesson');
    expect(vi.mocked(t.push).mock.calls.at(-1)?.[1].text).toContain('пока нет');
    lesson(); await lab.userView(t, '99', 'lesson');
    expect(vi.mocked(t.push).mock.calls.at(-1)?.[1].text).toBe('Просмотр участника: alice · /userview off\n\nNew advice for Alice');
    expect(fs.existsSync(path.join(root, 'subscriptions.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'receipts'))).toBe(false);
  });
  it('groups and unrelated transports never receive personal material', async () => {
    await lab.handle(t, '-1001', 'recommendations'); expect(t.push).toHaveBeenCalledWith('-1001', expect.objectContaining({ text: expect.stringContaining('личный чат') })); expect(lab.context(t, '-1001')).toBe('');
    expect(await lab.handle({ ...t, name: 'telegram:other' }, '42', 'recommendations')).toBe(false);
  });
  it('unknown profile gets public instructions but cannot subscribe', async () => {
    await lab.handle(t, '99', 'models'); expect(t.push).toHaveBeenLastCalledWith('99', expect.objectContaining({ text: 'Offline model instructions' }));
    await lab.handle(t, '99', 'start'); expect(fs.existsSync(path.join(root, 'subscriptions.json'))).toBe(false);
    expect(t.push).toHaveBeenLastCalledWith('99', expect.objectContaining({ card: labMenu() }));
    await lab.handle(t, '99', 'notifications');
    expect(fs.existsSync(path.join(root, 'subscriptions.json'))).toBe(false);
    expect(t.push).toHaveBeenLastCalledWith('99', expect.objectContaining({ card: labMenu() }));
    await lab.handle(t, '99', 'subscribe'); expect(lab.context(t, '99')).not.toContain('Alice only');
  });
  it('duplicate Telegram IDs and keys fail closed', async () => {
    write('participants.json', { participants: [{ key: 'alice', identity_status: 'confirmed', telegram_user_id: 42 }, { key: 'bob', identity_status: 'confirmed', telegram_user_id: 42 }] });
    expect(lab.context(t, '42')).toBe('');
    await lab.handle(t, '42', 'recommendations'); expect(t.push).toHaveBeenLastCalledWith('42', expect.objectContaining({ text: expect.stringContaining('не подтверждён') }));
  });
  it('rejects traversal and symlink source paths', async () => {
    write('participants.json', { participants: [{ key: 'alice', identity_status: 'confirmed', telegram_user_id: 42, recommendation_file: '../secret' }] });
    await lab.handle(t, '42', 'recommendations'); expect(t.push).toHaveBeenLastCalledWith('42', expect.objectContaining({ text: expect.stringContaining('готовится') }));
    profiles(); fs.unlinkSync(path.join(root, 'alice.md')); fs.symlinkSync(path.join(root, 'bob.md'), path.join(root, 'alice.md'));
    await lab.handle(t, '42', 'recommendations'); expect(t.push).toHaveBeenLastCalledWith('42', expect.objectContaining({ text: expect.stringContaining('готовится') }));
  });
  it('start opts in once and preserves explicit optout', async () => {
    await lab.handle(t, '42', 'start'); expect(JSON.parse(fs.readFileSync(path.join(root, 'subscriptions.json'), 'utf8'))['42']).toBe(true);
    expect(t.push).toHaveBeenLastCalledWith('42', expect.objectContaining({ card: labMenu({ subscribed: true }) }));
    await lab.handle(t, '42', 'unsubscribe'); await lab.handle(t, '42', 'start'); expect(JSON.parse(fs.readFileSync(path.join(root, 'subscriptions.json'), 'utf8'))['42']).toBe(false);
  });
  it('requires finalization, approval, and exact transcript hash', async () => {
    await lab.handle(t, '42', 'start'); vi.mocked(t.push).mockClear();
    for (const override of [{ status: 'preliminary' }, { approved: false }, { transcript_sha256: '0'.repeat(64) }]) {
      lesson(override); await lab.tick(t, async () => true); expect(t.push).not.toHaveBeenCalled();
    }
    expect(lab.context(t, '42')).not.toContain('PRIVATE TRANSCRIPT');
  });
  it('sends only confirmed subscribed eligible recipient and suppresses repeats', async () => {
    lesson(); await lab.handle(t, '42', 'start'); vi.mocked(t.push).mockClear(); const eligible = vi.fn().mockResolvedValue(true);
    await lab.tick(t, eligible); await lab.tick(t, eligible);
    expect(t.push).toHaveBeenCalledTimes(1); expect(t.push).toHaveBeenCalledWith('42', expect.objectContaining({ text: 'New advice for Alice' }));
    expect(fs.statSync(path.join(root, 'receipts')).mode & 0o077).toBe(0);
    await lab.handle(t, '42', 'recommendations'); expect(t.push).toHaveBeenLastCalledWith('42', expect.objectContaining({ text: 'New advice for Alice' }));
  });
  it('does not resend identical personal text after a source revision or another lesson', async () => {
    lesson({ published_at: '2026-10-09T12:00:00Z' }); await lab.handle(t, '42', 'start'); vi.mocked(t.push).mockClear();
    await lab.tick(t, async () => true);
    write('lessons/two/transcript.md', 'A different published summary');
    write('lessons/two/participants/alice/recommendations.md', 'New advice for Alice');
    write('lessons/two/manifest.json', { status: 'finalized', approved: true, transcript_file: 'transcript.md', transcript_sha256: createHash('sha256').update('A different published summary').digest('hex'), published_at: '2026-10-10T12:00:00Z', recipient_files: { alice: 'participants/alice/recommendations.md' } });
    await lab.tick(t, async () => true); expect(t.push).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(path.join(root, 'receipts'))).toHaveLength(1);
  });
  it('prefers actual publication chronology over local manifest write order', async () => {
    lesson({ published_at: '2026-10-10T12:00:00Z' });
    write('lessons/older/transcript.md', 'Older summary');
    write('lessons/older/participants/alice/recommendations.md', 'Older advice');
    write('lessons/older/manifest.json', { status: 'finalized', approved: true, transcript_file: 'transcript.md', transcript_sha256: createHash('sha256').update('Older summary').digest('hex'), published_at: '2026-10-09T12:00:00Z', recipient_files: { alice: 'participants/alice/recommendations.md' } });
    await lab.handle(t, '42', 'recommendations');
    expect(t.push).toHaveBeenLastCalledWith('42', expect.objectContaining({ text: 'New advice for Alice' }));
  });
  it('does not retry ambiguous failures, unsubscribed, or failed eligibility', async () => {
    lesson(); await lab.handle(t, '42', 'start'); vi.mocked(t.push).mockClear();
    await lab.tick(t, async () => { throw new Error('membership unavailable'); }); expect(t.push).not.toHaveBeenCalled();
    vi.mocked(t.push).mockRejectedValueOnce(new Error('timeout')); await lab.tick(t, async () => true); await lab.tick(t, async () => true); expect(t.push).toHaveBeenCalledTimes(1);
    const receipt = fs.readFileSync(path.join(root, 'receipts', fs.readdirSync(path.join(root, 'receipts'))[0]), 'utf8'); expect(receipt).toContain('blocked_attempt');
    await lab.handle(t, '43', 'start'); await lab.handle(t, '43', 'unsubscribe'); vi.mocked(t.push).mockClear(); await lab.tick(t, async () => true); expect(t.push).not.toHaveBeenCalled();
  });
  it('rejects another participant lesson path and overlong UTF16 content', async () => {
    lesson({ recipient_files: { alice: 'participants/bob/recommendations.md' } }); await lab.handle(t, '42', 'start'); vi.mocked(t.push).mockClear(); await lab.tick(t, async () => true); expect(t.push).not.toHaveBeenCalled();
    lesson(); write('lessons/one/participants/alice/recommendations.md', '😀'.repeat(2049)); await lab.tick(t, async () => true); expect(t.push).not.toHaveBeenCalled();
  });
});
