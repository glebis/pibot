import * as fs from 'node:fs';
import * as path from 'node:path';
import { CoordinatorStore } from './store.js';
import { Coordinator } from './coordinator.js';
import { ContractsAuthority } from './authority.js';
import { CoordinatorTelegramSender } from './telegram-sender.js';
import type { DurableTelegramIngress } from './telegram-ingress.js';
import type { Authority, Sender } from './types.js';

export interface CoordinatorConfig {
  ownerId: string; coordinatorId: string; mandateId: string;
  botId: string; chatId: string; userId: string;
  socketPath: string; tokenFile: string; dataDir: string;
}
/** Opt-in file is owner-only and contains identities/paths, never bot credentials. */
export function loadCoordinatorConfig(file: string | undefined): CoordinatorConfig | undefined {
  if (!file) return undefined;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let value: unknown;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0 || st.size > 12000) throw new Error('Coordinator config must be a private owner file');
    value = JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
  const c = value as CoordinatorConfig;
  if (!c || ['ownerId','coordinatorId','mandateId','botId','chatId','userId','socketPath','tokenFile','dataDir'].some(k => typeof (c as any)[k] !== 'string' || !(c as any)[k] || (c as any)[k].length > 1000)) throw new Error('Invalid coordinator config');
  if (![c.botId,c.chatId,c.userId].every(x => /^[1-9]\d{0,19}$/.test(x)) || c.chatId !== c.userId || ![c.socketPath,c.tokenFile,c.dataDir].every(path.isAbsolute)) throw new Error('Coordinator requires explicit private recipient and absolute paths');
  return c;
}
type Update = {update_id:number; callback_query?:{id?:string;data?:string;from?:{id?:number};message?:{chat?:{id?:number;type?:string}}}};
export class CoordinatorRuntime implements DurableTelegramIngress {
  readonly store: CoordinatorStore;
  readonly coordinator: Coordinator;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = true;
  private pending: Promise<void> = Promise.resolve();
  private healthy = true;
  private ticking = false;
  constructor(readonly config: CoordinatorConfig, token: string, dependencies?: {authority?:Authority;sender?:Sender}) {
    this.store = new CoordinatorStore(config.dataDir);
    try { this.coordinator = new Coordinator({store:this.store,authority:dependencies?.authority ?? new ContractsAuthority(config),sender:dependencies?.sender ?? new CoordinatorTelegramSender(token,config.botId)}); }
    catch (e) { this.store.close(); throw e; }
  }
  private relevant(value: unknown): value is Update {
    const u = value as Update;
    return !!u && Number.isSafeInteger(u.update_id) && typeof u.callback_query?.data === 'string' && u.callback_query.data.startsWith('pc:');
  }
  private intended(update: Update): boolean {
    const q = update.callback_query;
    return q?.message?.chat?.type === 'private' && String(q.from?.id) === this.config.userId && String(q.message.chat.id) === this.config.chatId;
  }
  captureBatch(updates: unknown[]): void {
    // Capture only our control namespace; never copy general messages into this ledger.
    this.store.captureUpdates(this.config.botId,updates.filter(u => this.relevant(u) && this.intended(u)) as {update_id:number;[key:string]:unknown}[]);
  }
  async handle(value: unknown): Promise<boolean> {
    if (!this.relevant(value)) return false;
    if (!this.intended(value)) return true;
    this.captureBatch([value]);
    const q = value.callback_query!;
    if (q.message?.chat?.type === 'private' && Number.isSafeInteger(q.from?.id) && Number.isSafeInteger(q.message.chat.id)) {
      this.coordinator.respond({eventId:`${this.config.botId}:${value.update_id}`,token:q.data!.slice(3),recipient:{botId:this.config.botId,chatId:String(q.message.chat.id),userId:String(q.from!.id)}});
    }
    this.store.markUpdateProcessed(this.config.botId,value.update_id);
    return true;
  }
  inspect() { return {...this.coordinator.inspect(),workerHealthy:this.healthy,sourceMode:'manual-contract-reference',callsEnabled:false}; }
  create(input: {sourceContractId:string;question:string;choices:string[];deadline:number}) {
    const c = this.config;
    return this.coordinator.create({sourceContractId:input.sourceContractId,question:input.question,choices:input.choices,deadline:input.deadline,mandateId:c.mandateId,ownerId:c.ownerId,coordinatorId:c.coordinatorId,recipient:{botId:c.botId,chatId:c.chatId,userId:c.userId}});
  }
  async start(): Promise<void> {
    if (!this.stopped) return;
    // Replay prior captured callbacks before allowing any outbound attempt.
    for (const update of this.store.pendingUpdates(this.config.botId)) await this.handle(update);
    this.stopped = false;
    const run = () => { if (this.stopped || this.ticking) return; this.ticking = true; this.pending = this.coordinator.tick().then(() => {this.healthy=true;}, () => {this.healthy=false;}).finally(() => {this.ticking=false;}); };
    run(); this.timer = setInterval(run,1000); this.timer.unref();
  }
  async stopDispatch(): Promise<void> { this.stopped=true; this.coordinator.stop(); if(this.timer)clearInterval(this.timer); await this.pending; }
  /** Called only after Telegram polling has stopped, including its final captured batch. */
  close(): void { this.store.close(); }
}
