import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import {attachmentsSchema} from './attachments';
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const agentId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const task = z.object({id,agentId:z.string(),title:z.string().max(240),status:z.string(),createdAt:z.number()});
export const processesSchema = z.object({
  takenAt:z.number(), daemon:z.object({pid:z.number(),uptimeSec:z.number(),rssKb:z.number()}),
  turns:z.array(z.object({id:z.string(),agentId:z.string(),kind:z.string(),startedAt:z.number()})).max(200),
  tasks:z.object({active:z.array(task).max(200),recent:z.array(task).max(100)}),
  children:z.array(z.object({pid:z.number(),ppid:z.number(),depth:z.number(),command:z.string(),elapsedSec:z.number(),rssKb:z.number()})).max(300),
  goals:z.array(z.object({chatKey:z.string().default(''),objective:z.string().default(''),turnsUsed:z.number(),maxTurns:z.number(),createdAt:z.number(),lastTurnAt:z.number()})).max(100),
  voiceCalls:z.array(z.object({agentId:z.string(),chatKey:z.string().default('')})).max(100),childrenError:z.string().optional(),
});
export const agentSchema = z.object({id:agentId,description:z.string(),model:z.string(),providers:z.array(z.string()),capabilities:z.array(z.string())});
export const bindingsSchema = z.object({bindings:z.array(z.object({agentId,chatKey:z.string().min(1).max(200)})).max(200)});
export const rpcContract = defineRpcContract({
  config:{input:z.null(),output:z.object({dashboardConfigured:z.boolean(),bridgeConfigured:z.boolean(),audioConfigured:z.boolean(),audioStartable:z.boolean().optional(),dashboardDiscoveryError:z.string().optional(),dashboardUrl:z.string().optional(),bridgeUrl:z.string().optional(),audioUrl:z.string().optional(),autoDiscoverDashboard:z.boolean().optional(),localPibotRoot:z.string().optional(),detectedPibotRoot:z.string().optional(),localAgentsDir:z.string().optional(),detectedAgentsDir:z.string().optional()})},
  discoverLocal:{input:z.null(),output:z.object({connected:z.boolean()})},
  configure:{input:z.object({dashboardUrl:z.string().max(2000),bridgeUrl:z.string().max(2000),audioUrl:z.string().max(2000),autoDiscoverDashboard:z.boolean(),localPibotRoot:z.string().max(4096),localAgentsDir:z.string().max(4096).optional(),dashboardToken:z.string().max(1024).optional(),bridgeToken:z.string().max(1024).optional(),audioToken:z.string().max(1024).optional(),clearDashboardToken:z.boolean().optional(),clearBridgeToken:z.boolean().optional(),clearAudioToken:z.boolean().optional()}).strict(),output:z.object({saved:z.boolean()})},
  overview:{input:z.null(),output:z.object({agents:z.array(agentSchema).max(200),processes:processesSchema})},
  bindings:{input:z.null(),output:bindingsSchema},
  conversations:{input:z.object({agentId}).strict(),output:z.object({conversations:z.array(z.object({agentId,chatKey:z.string().min(1).max(200),canSend:z.boolean(),kind:z.enum(['bb','telegram','saved']).optional()})).max(200),nativeAvailable:z.boolean().optional(),liveUnavailable:z.boolean().optional()})},
  createAgent:{input:z.object({id:agentId,description:z.string().trim().min(1).max(500)}).strict(),output:z.object({id:agentId})},
  cancelTask:{input:z.object({id}).strict(),output:z.object({cancelled:z.boolean()})},
  speak:{input:z.object({text:z.string().trim().min(1).max(16000)}).strict(),output:z.object({playbackId:id})},
  speechStatus:{input:z.object({playbackId:id}).strict(),output:z.object({status:z.enum(['speaking','finished','stopped','failed'])})},
  stopSpeech:{input:z.object({playbackId:id}).strict(),output:z.object({stopped:z.boolean()})},
  history:{input:z.object({agentId,chatKey:z.string().min(1).max(200),before:z.string().max(256).optional()}).strict(),output:z.object({sessionId:z.string().nullable(),messages:z.array(z.object({id:z.string(),role:z.enum(['user','assistant']),text:z.string().max(16000),timestamp:z.string().optional(),videos:z.array(z.object({index:z.number().int().min(0).max(49),src:z.string().regex(/^\/api\/v1\/plugins\/pibot-agents\/http\/video\?id=[A-Za-z0-9_-]{16,128}$/)})).max(50).optional()})).max(50),before:z.string().nullable(),hasMore:z.boolean(),truncated:z.boolean().optional(),watchKey:z.string().regex(/^[a-f0-9]{64}$/).optional()})},
  chat:{input:z.object({agentId,chatKey:z.string().min(1).max(200),allowTools:z.boolean(),text:z.string().trim().max(4000),attachments:attachmentsSchema.optional(),requestId:id}).strict().refine(v=>!!v.text||!!v.attachments?.length,'Write a message or attach a file.'),output:z.object({text:z.string().max(2000),pendingApproval:z.boolean().optional()})},
  openChat:{input:z.object({agentId,chatKey:z.string().min(1).max(200),allowTools:z.boolean()}).strict(),output:z.object({sessionId:id,greeting:z.string().optional()})},
  send:{input:z.object({sessionId:id,text:z.string().trim().min(1).max(4000),requestId:id}).strict(),output:z.object({text:z.string().max(2000),pendingApproval:z.boolean().optional()})},
  closeChat:{input:z.object({sessionId:id}).strict(),output:z.object({closed:z.boolean()})},
  prepareAudio:{input:z.null(),output:z.object({ready:z.boolean()})},
  audioOffer:{input:z.object({agentId,sdp:z.string().startsWith('v=0').max(60000),type:z.literal('offer'),allowTools:z.boolean()}).strict(),output:z.object({sdp:z.string().max(60000),type:z.literal('answer'),pc_id:z.string().optional(),callId:id})},
  audioEnd:{input:z.object({callId:id}).strict(),output:z.object({closed:z.boolean()})},
});
export type Overview = {agents:z.infer<typeof agentSchema>[],processes:z.infer<typeof processesSchema>};
