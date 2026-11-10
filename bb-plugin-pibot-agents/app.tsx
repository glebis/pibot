import { useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { definePluginApp, useRpc, useRealtime, useRealtimeConnectionState, experimental_Icon, experimental_VoiceInputTextarea } from '@get-bb/plugin-sdk/app';
import type { ExperimentalVoiceInputTextareaProps } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './server';
import './app.css';
import {MessageMarkdown} from './message-markdown';
import {mergeHistory,type ChatMessage} from './history-view';
import {attachmentSize,checkAttachmentFiles,readAttachment,type DraftAttachment} from './attachment-draft';
import {leadingMessageMarker} from './message-markers';
import {MessageMarker} from './message-marker';
import {videoNoteParts} from './video-notes';
import {VideoNotePlayer} from './video-note-player';

type Agent = {id:string;description:string;model:string;providers:string[];capabilities:string[]};
type Task = {id:string;agentId:string;title:string;status:string;createdAt:number};
type Overview = {agents:Agent[];processes:{takenAt:number;daemon:{pid:number;uptimeSec:number;rssKb:number};turns:{id:string;agentId:string;kind:string;startedAt:number}[];tasks:{active:Task[];recent:Task[]};children:{pid:number;ppid:number;depth:number;command:string;elapsedSec:number;rssKb:number}[];goals:{chatKey:string;objective:string;turnsUsed:number;maxTurns:number;createdAt:number;lastTurnAt:number}[];voiceCalls:{agentId:string;chatKey:string}[];childrenError?:string}};
const message = (e:unknown) => e instanceof Error ? e.message : String(e);
const age = (seconds:number) => seconds < 60 ? `${Math.floor(seconds)}s` : seconds < 3600 ? `${Math.floor(seconds/60)}m` : `${Math.floor(seconds/3600)}h`;
const noun = (count:number|undefined,word:string) => count===1?word:`${word}s`;
const Icon = experimental_Icon;


// Recognize only the exact trailing voice wrapper. Keep it reviewable in the UI.
const ATTACHED_VOICE_CONTEXT = "[Live voice call: the owner hears your reply spoken and is waiting. Answer in 1–3 short spoken sentences, within about 15 seconds. Links, code and files cannot be spoken — name them in one short spoken sentence and put the details into your reply text: whatever your reply holds beyond the spoken part is delivered to the Telegram chat the call started from. For anything slower — research, asking another agent, multi-step tool work — call start_task if you have it and say the result will arrive in the chat; otherwise say you'll follow up there. Only the tools the owner enabled for this call are available. Ask clarifying questions out loud, not with buttons.]";
function mediaSummaryText(text:string){return videoNoteParts(text).map(part=>part.kind==='text'?part.text:'Video note attached.').join('');}
function RichMessageContent({text,videos}:{text:string;videos?:ChatMessage['videos']}) {
 return <>{videoNoteParts(text).map((part,index)=>part.kind==='text'?<MessageMarkdown key={`text-${index}`} content={part.text}/>:<VideoNotePlayer key={`video-${part.index}`} src={videos?.find(video=>video.index===part.index)?.src}/>)}</>;
}
function MessageText({role,text,videos}:{role:string;text:string;videos?:ChatMessage['videos']}) {
 // PiBot adds this clock envelope for the model. The message header already shows time.
 if(role==='you')text=text.replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|[12]\d|3[01]), \d{4}, (?:0?[1-9]|1[0-2]):[0-5]\d[ \u00a0\u202f](?:AM|PM)\]\r?\n\r?\n/,'');
 const marker=leadingMessageMarker(text);
 if(marker?.kind==='heartbeat'||marker?.kind==='goal')return <details className="pb-heartbeat"><summary><MessageMarker kind={marker.kind} label={marker.label}/><span className="pb-heartbeat-preview">{mediaSummaryText(marker.body).replace(/\s+/g,' ').slice(0,180)}</span></summary><RichMessageContent text={marker.body} videos={videos}/></details>;
 const suffix='\n\n'+ATTACHED_VOICE_CONTEXT;
 if(role!=='you'||!text.endsWith(suffix))return <RichMessageContent text={text} videos={videos}/>;
 return <><RichMessageContent text={text.slice(0,-suffix.length)} videos={videos}/><details className="pb-voice-context"><summary>Attached voice context</summary><p>{ATTACHED_VOICE_CONTEXT}</p></details></>;
}

function useMacSpeech(report:(error:string)=>void) {
 const rpc=useRpc<typeof rpcContract>();
 const [reading,setReading]=useState<string|null>(null),[starting,setStarting]=useState(false),[playback,setPlayback]=useState<string|null>(null);
 const owned=useRef<string|null>(null),generation=useRef(0),playbackGeneration=useRef(0),mounted=useRef(true),reportRef=useRef(report);reportRef.current=report;
 const stop=async()=>{generation.current++;const id=owned.current;if(!id){if(mounted.current){setReading(null);setStarting(false)}return true}try{await rpc.call('stopSpeech',{playbackId:id});if(owned.current===id){owned.current=null;if(mounted.current){setPlayback(null);setReading(null);setStarting(false)}}return true}catch(e){if(mounted.current)reportRef.current(`Could not stop reading: ${message(e)}`);return false}};
 const speak=async(key:string,text:string)=>{if(reading===key){await stop();return}if(owned.current&&!await stop())return;const current=++generation.current;setReading(key);setStarting(true);try{const result=await rpc.call('speak',{text});if(!mounted.current||current!==generation.current){await rpc.call('stopSpeech',{playbackId:result.playbackId});return}owned.current=result.playbackId;playbackGeneration.current=current;setPlayback(result.playbackId);setStarting(false)}catch(e){if(mounted.current&&current===generation.current){setReading(null);setStarting(false);reportRef.current(`Read aloud failed: ${message(e)}`)}}};
 useEffect(()=>{if(!playback)return;let disposed=false;let timer:ReturnType<typeof setTimeout>;const poll=async()=>{try{const result=await rpc.call('speechStatus',{playbackId:playback});if(disposed||owned.current!==playback||generation.current!==playbackGeneration.current)return;if(result.status!=='speaking'){owned.current=null;setPlayback(null);setReading(null);if(result.status==='failed')reportRef.current('Local speech playback failed.');return}}catch(e){if(disposed||owned.current!==playback||generation.current!==playbackGeneration.current)return;reportRef.current(`Could not check speech playback: ${message(e)}`)}if(!disposed)timer=setTimeout(poll,700)};timer=setTimeout(poll,700);return()=>{disposed=true;clearTimeout(timer)}},[rpc,playback]);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;const id=owned.current;if(id)void rpc.call('stopSpeech',{playbackId:id}).catch(()=>{})}},[rpc]);
 return {reading,starting,speak,stop};
}

function useLiveCall(onTranscript:(role:string,text:string)=>void) {
 const rpc=useRpc<typeof rpcContract>();
 const [state,setState]=useState<'idle'|'starting'|'active'|'stopping'|'stop-failed'>('idle');
 const [status,setStatus]=useState(''),[muted,setMuted]=useState(false),[playbackBlocked,setPlaybackBlocked]=useState(false);
 const audio=useRef<HTMLAudioElement>(null),mounted=useRef(true),transcript=useRef(onTranscript);transcript.current=onTranscript;
 type Call={cancelled:boolean;starting:boolean;callId?:string;peer?:RTCPeerConnection;stream?:MediaStream;output?:HTMLAudioElement;timer?:ReturnType<typeof setTimeout>;abort:AbortController;releasing?:Promise<void>};
 const current=useRef<Call|null>(null);
 const localCleanup=(call:Call)=>{call.abort.abort();clearTimeout(call.timer);call.stream?.getTracks().forEach(track=>track.stop());if(call.peer){call.peer.ontrack=null;call.peer.onconnectionstatechange=null;call.peer.ondatachannel=null;call.peer.close()}const element=call.output||audio.current;if(element){element.pause();element.srcObject=null}if(mounted.current){setMuted(false);setPlaybackBlocked(false)}};
 const release=async(call:Call)=>{
  if(call.releasing)return call.releasing;
  if(!call.callId){if(!call.starting&&current.current===call){current.current=null;if(mounted.current)setState('idle')}return}
  call.releasing=(async()=>{try{await rpc.call('audioEnd',{callId:call.callId!});call.callId=undefined;if(!call.starting&&current.current===call){current.current=null;if(mounted.current)setState('idle')}}catch(e){if(mounted.current&&current.current===call){setStatus(`Microphone stopped; remote close failed: ${message(e)}`);setState('stop-failed')}}finally{call.releasing=undefined}})();return call.releasing;
 };
 const stop=async(reason='Call ended.')=>{const call=current.current;if(!call)return;call.cancelled=true;localCleanup(call);if(mounted.current){setState('stopping');setStatus(reason)}await release(call)};
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;const call=current.current;if(call){call.cancelled=true;localCleanup(call);void release(call)}}},[]);
 const start=async(agentId:string,allowTools:boolean)=>{
  if(current.current)return;
  const call:Call={cancelled:false,starting:true,abort:new AbortController()};current.current=call;setState('starting');setStatus('Checking and starting local voice interface…');
  try{
   await rpc.call('prepareAudio',null);
   if(call.cancelled||!mounted.current)return;
   setStatus('Allow microphone access…');
   const stream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});call.stream=stream;
   if(call.cancelled||!mounted.current){localCleanup(call);return}
   const peer=new RTCPeerConnection({iceServers:[]});call.peer=peer;
   const receive=(event:MessageEvent)=>{if(call.cancelled||!mounted.current||typeof event.data!=='string'||event.data.length>65536)return;let payload:unknown;try{payload=JSON.parse(event.data)}catch{return}if(!payload||typeof payload!=='object')return;const p=payload as Record<string,unknown>;if(p.type==='end'){void stop('Call ended by the service.');return}if(typeof p.text!=='string'||p.text.length>4000)return;if(p.type==='status')setStatus(p.text.slice(0,500));if(p.type==='user'||p.type==='assistant')transcript.current(p.type==='user'?'you':'agent',p.text)};
   peer.createDataChannel('chat').onmessage=receive;peer.ondatachannel=event=>{event.channel.onmessage=receive};
   peer.ontrack=event=>{if(call.cancelled||!mounted.current)return;const element=audio.current;if(element){call.output=element;element.srcObject=event.streams[0]||new MediaStream([event.track]);void element.play().catch(()=>{if(mounted.current&&!call.cancelled)setPlaybackBlocked(true)})}};
   peer.onconnectionstatechange=()=>{if(call.cancelled||!mounted.current)return;if(peer.connectionState==='connected'){setState('active');setStatus('Connected. Listening.')}if(['failed','disconnected','closed'].includes(peer.connectionState))void stop('Voice connection ended.')};
   stream.getTracks().forEach(track=>peer.addTrack(track,stream));setStatus('Connecting to PiBot…');
   await peer.setLocalDescription(await peer.createOffer());
   await new Promise<void>((resolve,reject)=>{let deadline:ReturnType<typeof setTimeout>;const clean=()=>{clearTimeout(deadline);peer.removeEventListener('icegatheringstatechange',changed);call.abort.signal.removeEventListener('abort',aborted)};const changed=()=>{if(peer.iceGatheringState==='complete'){clean();resolve()}};const aborted=()=>{clean();reject(new Error('Call cancelled'))};peer.addEventListener('icegatheringstatechange',changed);call.abort.signal.addEventListener('abort',aborted,{once:true});deadline=setTimeout(()=>{clean();reject(new Error('ICE gathering timed out after 10 seconds'))},10000);if(call.abort.signal.aborted)aborted();else changed()});
   if(call.cancelled||!mounted.current)return;
   if(!peer.localDescription?.sdp)throw new Error('The browser did not create an audio offer.');
   const answer=await rpc.call('audioOffer',{agentId,sdp:peer.localDescription.sdp,type:'offer',allowTools});call.callId=answer.callId;
   if(call.cancelled||!mounted.current){localCleanup(call);return}
   await peer.setRemoteDescription({type:answer.type,sdp:answer.sdp});
   if(call.cancelled||!mounted.current)return;
   call.timer=setTimeout(()=>void stop('15-minute call limit reached.'),15*60*1000);
  }catch(e){if(!call.cancelled&&mounted.current){setStatus(`Could not start voice: ${message(e)}`)}call.cancelled=true;localCleanup(call)}
  finally{call.starting=false;if(call.cancelled||!mounted.current)await release(call)}
 };
 return {state,status,muted,playbackBlocked,audio,start,stop,locked:state!=='idle',toggleMute:()=>{const stream=current.current?.stream;if(!stream)return;const next=!muted;stream.getAudioTracks().forEach(track=>{track.enabled=!next});setMuted(next)},play:()=>{void audio.current?.play().then(()=>setPlaybackBlocked(false),()=>setStatus('Playback blocked. Use the audio controls to play the reply.'))}};
}

type ConnectionConfig={dashboardUrl?:string;bridgeUrl?:string;audioUrl?:string;autoDiscoverDashboard?:boolean;localPibotRoot?:string;detectedPibotRoot?:string;localAgentsDir?:string;detectedAgentsDir?:string;dashboardConfigured:boolean;bridgeConfigured:boolean;audioConfigured:boolean};
function ConnectionSettings({locked,refresh,onSaved,open,onOpenChange}:{locked:boolean;refresh:number;onSaved:()=>void;open:boolean;onOpenChange:(open:boolean)=>void}) {
 const rpc=useRpc<typeof rpcContract>();
 const [config,setConfig]=useState<ConnectionConfig|null>(null),[urls,setUrls]=useState({dashboardUrl:'',bridgeUrl:'',audioUrl:''}),[tokens,setTokens]=useState({dashboardToken:'',bridgeToken:'',audioToken:''});
 const [clear,setClear]=useState({clearDashboardToken:false,clearBridgeToken:false,clearAudioToken:false}),[discover,setDiscover]=useState(true),[root,setRoot]=useState(''),[agentsDir,setAgentsDir]=useState('');
 const [pending,setPending]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');const busy=useRef(false);
 useEffect(()=>{let disposed=false;void rpc.call('config',null).then(c=>{if(disposed)return;setConfig(c);setUrls({dashboardUrl:c.dashboardUrl||'',bridgeUrl:c.bridgeUrl||'',audioUrl:c.audioUrl||''});setDiscover(c.autoDiscoverDashboard!==false);setRoot(c.localPibotRoot||'');setAgentsDir(('localAgentsDir' in c&&typeof c.localAgentsDir==='string')?c.localAgentsDir:'');setError('')},e=>{if(!disposed)setError(message(e))});return()=>{disposed=true}},[rpc,refresh]);
 const save=async()=>{if(locked||busy.current||!config)return;busy.current=true;setPending(true);setError('');setNotice('');try{await rpc.call('configure',{...urls,autoDiscoverDashboard:discover,localPibotRoot:root,localAgentsDir:agentsDir,...clear,...(tokens.dashboardToken.trim()?{dashboardToken:tokens.dashboardToken.trim()}:{}),...(tokens.bridgeToken.trim()?{bridgeToken:tokens.bridgeToken.trim()}:{}),...(tokens.audioToken.trim()?{audioToken:tokens.audioToken.trim()}:{} )});setTokens({dashboardToken:'',bridgeToken:'',audioToken:''});setClear({clearDashboardToken:false,clearBridgeToken:false,clearAudioToken:false});setNotice('Connections saved. Checking service readiness…');onSaved()}catch(e){setError(message(e))}finally{busy.current=false;setPending(false)}};
 const connectLocal=async()=>{if(locked||busy.current)return;busy.current=true;setPending(true);setError('');setNotice('');try{const result=await rpc.call('discoverLocal',null);if(!result.connected)throw new Error('Local PiBot could not be connected. Review the checkout and service configuration below.');setNotice('Local PiBot credentials connected. Checking service readiness…');onSaved()}catch(e){setError(message(e))}finally{busy.current=false;setPending(false)}};
 return <details className="pb-connections" id="connection-settings" open={open} onToggle={e=>onOpenChange(e.currentTarget.open)}><summary>Configure connections <span>Service URLs, credentials and local discovery</span></summary><div className="pb-connections-body"><p className="pb-footnote">Configure PiBot here. Blank token fields keep saved credentials; secrets are never loaded into this form.</p><div className="pb-local-connect"><div><strong>Local PiBot checkout</strong><code>{config?.detectedPibotRoot||'No local checkout detected yet'}</code><small>Connect local PiBot imports the dashboard and chat bridge credentials from its encrypted settings. Voice remains a separate connection.</small></div><button type="button" disabled={locked||pending||!config} onClick={()=>void connectLocal()}>Connect local PiBot</button></div>
 <form onSubmit={e=>{e.preventDefault();void save()}}><fieldset disabled={locked||pending||!config}><div className="pb-connection-fields">{([{name:'Dashboard',url:'dashboardUrl',token:'dashboardToken',clear:'clearDashboardToken',ready:config?.dashboardConfigured},{name:'Chat bridge',url:'bridgeUrl',token:'bridgeToken',clear:'clearBridgeToken',ready:config?.bridgeConfigured},{name:'Voice service',url:'audioUrl',token:'audioToken',clear:'clearAudioToken',ready:config?.audioConfigured}] as const).map(service=><section className="pb-connection-service" key={service.name}><div className="pb-section"><h3>{service.name}</h3><span className={'pb-chip pb-service-state '+(config?(service.ready?'ready':'missing'):'pending')}>{config?(service.ready?'Configured':'Needs setup'):'Loading…'}</span></div><label>Service URL<input type="url" value={urls[service.url]} onChange={e=>setUrls(previous=>({...previous,[service.url]:e.target.value}))} placeholder="http://127.0.0.1:…"/></label>{/^https?:\/\//.test(urls[service.url])&&<a className="pb-inline-link" href={urls[service.url]} target="_blank" rel="noopener noreferrer">Open {service.name.toLowerCase()} ↗</a>}<label>Replace token<input type="password" autoComplete="new-password" value={tokens[service.token]} onChange={e=>setTokens(previous=>({...previous,[service.token]:e.target.value}))} placeholder="Leave blank to keep saved token" disabled={clear[service.clear]}/></label><label className="pb-checkbox"><input type="checkbox" checked={clear[service.clear]} onChange={e=>setClear(previous=>({...previous,[service.clear]:e.target.checked}))}/> Clear saved token</label></section>)}</div><label className="pb-checkbox pb-auto-discover"><input type="checkbox" checked={discover} onChange={e=>setDiscover(e.target.checked)}/> Discover the dashboard token automatically from local encrypted settings</label><details className="pb-advanced"><summary>Advanced · override local checkout</summary><label>Local PiBot folder<input value={root} onChange={e=>setRoot(e.target.value)} placeholder="Leave blank to use the detected checkout"/></label><label>Agent storage folder override<input value={agentsDir} onChange={e=>setAgentsDir(e.target.value)} placeholder="Leave blank to use PiBot’s agent storage"/></label><p className="pb-footnote">{config?.detectedAgentsDir?`Detected storage: ${config.detectedAgentsDir}`:"Blank uses PIBOT_AGENTS_DIR or ~/.local/share/pibot/agents."}</p></details><div className="pb-settings-save"><button className="pb-primary" type="submit">{pending?'Saving…':'Save connections'}</button><small>{locked?'End the live call before changing connections.':'Changes apply to new connections.'}</small></div></fieldset></form>{error&&<p className="pb-alert" role="alert">{error}<button type="button" disabled={pending||locked} onClick={onSaved}>Retry configuration</button></p>}{notice&&<p className="pb-footnote" role="status">{notice}</p>}</div></details>
}

function AgentsPage({VoiceInput}:{VoiceInput:ComponentType<ExperimentalVoiceInputTextareaProps>}) {
 const rpc = useRpc<typeof rpcContract>();
 const [data,setData]=useState<Overview|null>(null),[loadError,setLoadError]=useState(''),[error,setError]=useState('');
 const [selected,setSelected]=useState(''),[search,setSearch]=useState(''),[binding,setBinding]=useState('');
 const [conversations,setConversations]=useState<{agentId:string;chatKey:string;canSend:boolean;kind?:'bb'|'telegram'|'saved'}[]>([]),[conversationsError,setConversationsError]=useState(''),[nativeReady,setNativeReady]=useState(false);
 const [bindings,setBindings]=useState<{agentId:string;chatKey:string}[]>([]);
 const [attachments,setAttachments]=useState<DraftAttachment[]>([]),[readingAttachments,setReadingAttachments]=useState(false);
 const attachmentDrafts=useRef<Record<string,DraftAttachment[]>>({}),attachmentReads=useRef<Partial<Record<string,Promise<void>>>>({}),fileInput=useRef<HTMLInputElement>(null);
 const [draft,setDraft]=useState(''),[voice,setVoice]=useState(false),[pending,setPending]=useState(false),[allowTools,setAllowTools]=useState(false);
 const [messages,setMessages]=useState<ChatMessage[]>([]),[newAgent,setNewAgent]=useState(false),[agentId,setAgentId]=useState(''),[description,setDescription]=useState('');
 const [settingsOpen,setSettingsOpen]=useState(false);
 const [historyState,setHistoryState]=useState<'idle'|'loading'|'ready'|'error'>('idle'),[historyError,setHistoryError]=useState(''),[historyBefore,setHistoryBefore]=useState<string|null>(null),[historyHasMore,setHistoryHasMore]=useState(false),[historyTruncated,setHistoryTruncated]=useState(false);
 const historyGeneration=useRef(0),chatScroll=useRef<HTMLDivElement>(null),preserveScroll=useRef<{height:number;top:number;keep?:boolean}|null>(null),drafts=useRef<Record<string,string>>({}),draftTarget=useRef('');
 const [refresh,setRefresh]=useState(0),[configured,setConfigured]=useState<boolean|null>(null),[dashboardConfigured,setDashboardConfigured]=useState<boolean|null>(null),[configError,setConfigError]=useState(''),[discoveryError,setDiscoveryError]=useState(''),[bindingsError,setBindingsError]=useState(''),[audioConfigured,setAudioConfigured]=useState<boolean|null>(null);
 const live=useLiveCall((role,text)=>setMessages(previous=>[...previous.slice(-99),{role,text}]));
 const bindingSelections=useRef<Record<string,string>>({});
 const pendingRef=useRef(false),pendingTargets=useRef(new Set<string>()),targetErrors=useRef<Record<string,string>>({});
 const [sendingTargets,setSendingTargets]=useState<Set<string>>(()=>new Set());
 const speech=useMacSpeech(setError);
 const alive=useRef(true),bottom=useRef<HTMLDivElement>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[rpc]);
 useEffect(()=>{let disposed=false;let timer:ReturnType<typeof setTimeout>;const poll=async()=>{try{const c=await rpc.call('config',null);if(!disposed){setDashboardConfigured(c.dashboardConfigured);setDiscoveryError(('dashboardDiscoveryError' in c && typeof c.dashboardDiscoveryError==='string')?c.dashboardDiscoveryError:'');setConfigured(c.bridgeConfigured);setAudioConfigured(c.audioConfigured||c.audioStartable===true);setConfigError('')}}catch(e){if(!disposed)setConfigError(message(e))}finally{if(!disposed)timer=setTimeout(poll,5000)}};void poll();return()=>{disposed=true;clearTimeout(timer)}},[rpc,refresh]);
 useEffect(()=>{if(dashboardConfigured!==true){setLoadError('');return}let disposed=false;let timer:ReturnType<typeof setTimeout>;const poll=async()=>{try {const result=await rpc.call('overview',null);if(!disposed){setData(result);setLoadError('');setSelected(previous=>previous || result.agents[0]?.id || '')}}catch(e){if(!disposed)setLoadError(message(e))}finally{if(!disposed)timer=setTimeout(poll,5000)}};void poll();return()=>{disposed=true;clearTimeout(timer)}},[rpc,refresh,dashboardConfigured]);
 useEffect(()=>{if(configured!==true){setBindings([]);setBindingsError('');return}let disposed=false;let timer:ReturnType<typeof setTimeout>;const poll=async()=>{try{const b=await rpc.call('bindings',null);if(!disposed){setBindings(b.bindings);setBindingsError('')}}catch(e){if(!disposed)setBindingsError(message(e))}finally{if(!disposed)timer=setTimeout(poll,5000)}};void poll();return()=>{disposed=true;clearTimeout(timer)}},[rpc,refresh,configured]);
 useEffect(()=>{if(!selected||dashboardConfigured!==true){setConversations([]);return}let disposed=false;let timer:ReturnType<typeof setTimeout>;setConversations([]);const poll=async()=>{try{const result=await rpc.call('conversations',{agentId:selected});if(!disposed){setConversations(result.conversations);setNativeReady(result.nativeAvailable===true);setConversationsError('')}}catch(e){if(!disposed)setConversationsError(message(e))}finally{if(!disposed)timer=setTimeout(poll,5000)}};void poll();return()=>{disposed=true;clearTimeout(timer)}},[rpc,selected,dashboardConfigured,refresh]);
 useEffect(()=>{if(dashboardConfigured!==null&&configured!==null)setSettingsOpen(dashboardConfigured===false||(configured===false&&!nativeReady))},[dashboardConfigured,configured,nativeReady]);
 useEffect(()=>{if(!settingsOpen)return;const close=(event:KeyboardEvent)=>{if(event.key==='Escape')setSettingsOpen(false)};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close)},[settingsOpen]);
 useEffect(()=>{const scroll=chatScroll.current,old=preserveScroll.current;if(scroll&&old){scroll.scrollTop=old.keep?old.top:old.top+scroll.scrollHeight-old.height;preserveScroll.current=null}else bottom.current?.scrollIntoView({block:'nearest'})},[messages,pending]);
 const agent=data?.agents.find(a=>a.id===selected);const liveAvailable=bindings.filter(b=>b.agentId===selected);const available=conversations.some(c=>c.agentId===selected)?conversations.filter(c=>c.agentId===selected):liveAvailable.map(b=>({...b,canSend:true,kind:'telegram' as const}));const chatKey=available.some(b=>b.chatKey===binding)?binding:available[0]?.chatKey || '';const conversation=available.find(c=>c.chatKey===chatKey);const historyConnected=conversation?.kind==='telegram'||!conversation?.kind?configured===true:dashboardConfigured===true;const canSend=conversation?.canSend===true&&historyConnected;
 const historyMeta=useRef<{sessionId:string|null;tailId?:string}>({sessionId:null}),historyWatchKey=useRef(''),historyLoading=useRef(false),historyDirty=useRef(false);
 const currentMessages=useRef(messages);currentMessages.current=messages;
 const requestHistoryRefresh=useRef(()=>{});
 const historyTarget=useRef('');historyTarget.current=`${selected}:${chatKey}`;
 const sending=sendingTargets.has(historyTarget.current);
 const supportsAttachments=canSend&&chatKey===`bb:${selected}:owner`;
 const addAttachments=(files:File[])=>{
  if(!files.length)return;const target=historyTarget.current;
  if(!supportsAttachments||voice||live.locked){targetErrors.current[target]='Attachments are available in your independent BB chat. Choose BB chat to attach files.';setError(targetErrors.current[target]);return}
  setReadingAttachments(true);targetErrors.current[target]='';setError('');
  const previous=attachmentReads.current[target]||Promise.resolve();
  const work=previous.then(async()=>{checkAttachmentFiles(files,attachmentDrafts.current[target]||[]);const added=await Promise.all(files.map(readAttachment));if(!alive.current)return;const existing=attachmentDrafts.current[target]||[];checkAttachmentFiles(files,existing);attachmentDrafts.current[target]=[...existing,...added];if(historyTarget.current===target)setAttachments(attachmentDrafts.current[target]);}).catch(e=>{targetErrors.current[target]=message(e);if(alive.current&&historyTarget.current===target)setError(targetErrors.current[target]);}).finally(()=>{if(attachmentReads.current[target]===work){delete attachmentReads.current[target];if(alive.current&&historyTarget.current===target)setReadingAttachments(false)}});
  attachmentReads.current[target]=work;
 };
 const removeAttachment=(id:string)=>{const target=historyTarget.current;attachmentDrafts.current[target]=(attachmentDrafts.current[target]||[]).filter(file=>file.id!==id);setAttachments(attachmentDrafts.current[target]);};
 const loadHistory=async(before?:string,background=false)=>{
  if(!selected||!chatKey||!historyConnected||live.locked)return;
  const target=`${selected}:${chatKey}`,generation=++historyGeneration.current;historyLoading.current=true;if(!background)setHistoryState('loading');setHistoryError('');
  try{const result=await rpc.call('history',{agentId:selected,chatKey,...(before?{before}:{})});if(!alive.current||generation!==historyGeneration.current||target!==historyTarget.current)return;
   historyWatchKey.current=result.watchKey||'';
   const next=result.messages.map(m=>({id:m.id,role:m.role==='user'?'you':'agent',text:m.text,timestamp:m.timestamp,...(m.videos?{videos:m.videos}:{})}));
   if(before){const scroll=chatScroll.current;if(scroll)preserveScroll.current={height:scroll.scrollHeight,top:scroll.scrollTop};const previous=currentMessages.current;const ids=new Set(previous.map(m=>m.id).filter(Boolean));const expanded=[...next.filter(m=>!ids.has(m.id)),...previous];currentMessages.current=expanded;setMessages(expanded)}else{const merged=mergeHistory(currentMessages.current,next,background&&historyMeta.current.sessionId===result.sessionId,historyMeta.current.tailId);const scroll=chatScroll.current;if(background&&merged.retainEarlier&&merged.messages!==currentMessages.current&&scroll&&scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight>64)preserveScroll.current={height:scroll.scrollHeight,top:scroll.scrollTop,keep:true};currentMessages.current=merged.messages;setMessages(merged.messages);if(!merged.retainEarlier){setHistoryBefore(result.before);setHistoryHasMore(result.hasMore)}historyMeta.current={sessionId:result.sessionId,tailId:next.at(-1)?.id};}
   if(before){setHistoryBefore(result.before);setHistoryHasMore(result.hasMore)}setHistoryTruncated(result.truncated===true);setHistoryState('ready');
  }catch(e){if(alive.current&&generation===historyGeneration.current&&target===historyTarget.current){setHistoryState('error');setHistoryError(message(e))}}
  finally{if(generation===historyGeneration.current){historyLoading.current=false;if(historyDirty.current)queueMicrotask(()=>requestHistoryRefresh.current())}}
 };
 requestHistoryRefresh.current=()=>{if(!alive.current||!selected||!chatKey||!historyConnected)return;historyDirty.current=true;if(historyLoading.current||pendingTargets.current.has(historyTarget.current)||live.locked)return;historyDirty.current=false;void loadHistory(undefined,true)};
 useRealtime('history-changed',payload=>{if(payload&&typeof payload==='object'&&'key' in payload&&typeof payload.key==='string'&&(!historyWatchKey.current||payload.key===historyWatchKey.current))requestHistoryRefresh.current()});
 const realtimeState=useRealtimeConnectionState(),previousRealtimeState=useRef(realtimeState);
 useEffect(()=>{if(realtimeState==='connected'&&previousRealtimeState.current!=='connected')requestHistoryRefresh.current();previousRealtimeState.current=realtimeState},[realtimeState]);
 useEffect(()=>{const refresh=()=>requestHistoryRefresh.current();const visible=()=>{if(document.visibilityState==='visible')refresh()};window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',visible);const timer=setInterval(refresh,60_000);return()=>{clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',visible)}},[]);
 useEffect(()=>{if(live.locked)return;historyMeta.current={sessionId:null};historyWatchKey.current='';historyLoading.current=false;historyDirty.current=false;setMessages([]);setHistoryBefore(null);setHistoryHasMore(false);setHistoryTruncated(false);setHistoryError('');setHistoryState('idle');void loadHistory();return()=>{historyGeneration.current++}},[rpc,selected,chatKey,historyConnected,live.locked]);
 useEffect(()=>{void speech.stop();const target=`${selected}:${chatKey}`;draftTarget.current=target;setDraft(drafts.current[target]||'');setAttachments(attachmentDrafts.current[target]||[]);setReadingAttachments(!!attachmentReads.current[target]);setError(targetErrors.current[target]||'')},[selected,chatKey]);
 const action=async(fn:()=>Promise<void>)=>{if(pendingRef.current)return;pendingRef.current=true;setPending(true);setError('');try{await fn()}catch(e){if(alive.current)setError(message(e))}finally{pendingRef.current=false;if(alive.current)setPending(false);if(historyDirty.current)requestHistoryRefresh.current()}};
 const send=()=>{
  const text=draft.trim(),target=`${selected}:${chatKey}`,submittedDraft=draft,submittedAttachments=attachmentDrafts.current[target]||[];
  if(!selected||!chatKey||(!text&&!submittedAttachments.length)||voice||live.locked||!canSend||pendingTargets.current.has(target)||attachmentReads.current[target])return;
  if(submittedAttachments.length&&(!supportsAttachments||(!allowTools&&submittedAttachments.some(file=>!file.mimeType.startsWith('image/'))))){targetErrors.current[target]=supportsAttachments?'Enable Allow tools so the agent can read attached files. Images do not require tools.':'Choose BB chat to send attachments.';setError(targetErrors.current[target]);return}
  const owner={agentId:selected,chatKey,allowTools,text,requestId:crypto.randomUUID(),...(submittedAttachments.length?{attachments:submittedAttachments.map(({name,mimeType,dataBase64})=>({name,mimeType,dataBase64}))}:{})};
  pendingTargets.current.add(target);setSendingTargets(new Set(pendingTargets.current));targetErrors.current[target]='';setError('');
  historyGeneration.current++;historyLoading.current=false;
  void (async()=>{try{
   const result=await rpc.call('chat',owner);
   if(drafts.current[target]===submittedDraft)drafts.current[target]='';
   const submittedIds=new Set(submittedAttachments.map(file=>file.id));attachmentDrafts.current[target]=(attachmentDrafts.current[target]||[]).filter(file=>!submittedIds.has(file.id));
   if(result.pendingApproval)targetErrors.current[target]=conversation?.kind==='bb'?'A decision is waiting. Reply in this chat to answer.':'This reply is waiting for approval. Review it in PiBot.';
   if(alive.current&&historyTarget.current===target){
    historyGeneration.current++;historyLoading.current=false;
    setDraft(drafts.current[target]||'');setAttachments(attachmentDrafts.current[target]||[]);
    const visibleText=[text,submittedAttachments.length?'Attached files: '+submittedAttachments.map(file=>file.name).join(', '):''].filter(Boolean).join('\n\n');
    const next=[...currentMessages.current,{role:'you',text:visibleText},{role:'agent',text:result.text}];currentMessages.current=next;setMessages(next);setError(targetErrors.current[target]||'');
   }
  }catch(e){targetErrors.current[target]=message(e);if(alive.current&&historyTarget.current===target)setError(targetErrors.current[target])}
  finally{pendingTargets.current.delete(target);if(alive.current){setSendingTargets(new Set(pendingTargets.current));if(historyTarget.current===target)requestHistoryRefresh.current()}}
  })();
 };
 const tasks=data?.processes.tasks.active || [];
 const setupRequired=dashboardConfigured===false||(configured===false&&!nativeReady);
 const showSetup=dashboardConfigured!==true||configured!==true||audioConfigured!==true;
 const statusTone = configError ? 'warn' : dashboardConfigured === null ? 'pending' : setupRequired ? 'setup' : loadError ? 'warn' : data ? 'ok' : 'pending';
 const statusText = configError ? 'Configuration unavailable' : dashboardConfigured === null ? 'Connecting…' : setupRequired ? 'Setup required' : loadError ? 'Connection interrupted' : data ? 'Connected' : 'Connecting…';
 return <div className="pibot pb-chat-first">
  <header className="pb-topbar">
   <div className="pb-brand">
    <span className="pb-brand-mark" aria-hidden="true"><Icon name="Network"/></span>
    <strong>PiBot</strong>
    <div className="pb-health" data-tone={statusTone} role="status"><i aria-hidden="true"/><span>{statusText}</span></div>
   </div>
   <div className="pb-inline-stats" aria-label="Activity">
    <span><b>{data?.agents.length??'—'}</b>{noun(data?.agents.length,'agent')}</span>
    <span><b>{data?.processes.turns.length??'—'}</b>{noun(data?.processes.turns.length,'turn')}</span>
    <span><b>{data?tasks.length:'—'}</b>{noun(data?tasks.length:undefined,'run')}</span>
   </div>
   <a className="pb-inline-link pb-connections-toggle" href="#connection-settings" aria-expanded={settingsOpen} onClick={()=>setSettingsOpen(!settingsOpen)}>
    <Icon name="SlidersHorizontal" aria-hidden="true"/>
    {settingsOpen?'Hide connections':'Connections'}
   </a>
  </header>
  {settingsOpen&&<button className="pb-panel-scrim" aria-label="Close connections" onClick={()=>setSettingsOpen(false)}/>}
  <div className={'pb-connection-panel '+(settingsOpen?'is-open':'')} inert={!settingsOpen}>
   <div className="pb-connection-inner">
    {showSetup&&settingsOpen&&<div className="pb-setup-compact" role="status"><strong>Connect PiBot</strong><span>Dashboard: {dashboardConfigured===null?'checking':dashboardConfigured?'configured':'needs setup'}</span><span>Chat: {configured===null?'checking':configured?'configured':'needs setup'}</span><span>Voice: {audioConfigured===null?'checking':audioConfigured?'configured':'optional'}</span>{dashboardConfigured===false&&discoveryError&&<p>Dashboard discovery: {discoveryError}</p>}</div>}
    <ConnectionSettings locked={live.locked} refresh={refresh} onSaved={()=>setRefresh(x=>x+1)} open={settingsOpen} onOpenChange={setSettingsOpen}/>
   </div>
  </div>
  {configError&&<div className="pb-alert" role="alert"><Icon name="AlertTriangle" aria-hidden="true"/><span className="pb-alert-text">Could not read configuration: {configError}</span><button onClick={()=>setRefresh(x=>x+1)}>Retry</button></div>}
  {dashboardConfigured===true&&loadError&&<div className="pb-alert" role="alert"><Icon name="AlertTriangle" aria-hidden="true"/><span className="pb-alert-text">{data?'Showing the last snapshot. ':''}{loadError}</span><button onClick={()=>setRefresh(x=>x+1)}>Retry</button></div>}
  <main className="pb-grid">
   <aside className="pb-roster" aria-label="Agents">
    <div className="pb-section">
     <div className="pb-section-title"><h2>Agents</h2>{data&&<span className="pb-count">{data.agents.length}</span>}</div>
     <button className="pb-icon-button" aria-label="Create agent" title="Create agent" disabled={dashboardConfigured!==true||!data||pending||live.locked} onClick={()=>setNewAgent(!newAgent)}><Icon name="Plus" aria-hidden="true"/></button>
    </div>
    <label className="pb-search"><Icon name="Search" aria-hidden="true"/><input aria-label="Search agents" placeholder="Find agent…" value={search} onChange={e=>setSearch(e.target.value)}/></label>
    {newAgent&&<form className="pb-create" onSubmit={e=>{e.preventDefault();if(dashboardConfigured!==true||!data||live.locked)return;void action(async()=>{const result=await rpc.call('createAgent',{id:agentId.trim(),description:description.trim()});setSelected(result.id);setNewAgent(false);setAgentId('');setDescription('');setRefresh(x=>x+1)})}}><input required pattern="(?!.*--)[a-z0-9][a-z0-9-]{0,30}[a-z0-9]" minLength={2} maxLength={32} title="2–32 lowercase letters, numbers or single hyphens; start and end with a letter or number" aria-label="Agent ID" placeholder="agent-id" value={agentId} onChange={e=>setAgentId(e.target.value)}/><input required maxLength={500} aria-label="Agent description" placeholder="What does it do?" value={description} onChange={e=>setDescription(e.target.value)}/><button disabled={pending||live.locked||dashboardConfigured!==true||!data}>Create agent</button></form>}
    <div className="pb-agent-list">
     {data?.agents.filter(a=>(a.id+' '+a.description).toLowerCase().includes(search.toLowerCase())).map(a=>{const busy=data.processes.turns.some(t=>t.agentId===a.id)||[...sendingTargets].some(target=>target.startsWith(a.id+':'));return <button className={'pb-agent '+(selected===a.id?'selected':'')} key={a.id} aria-current={selected===a.id?'true':undefined} disabled={voice||live.locked} onClick={()=>{historyGeneration.current++;setMessages([]);setBinding(bindingSelections.current[a.id]||'');setSelected(a.id);setError('')}}><span className="pb-node" data-busy={busy?'true':undefined}>{a.id.slice(0,2).toUpperCase()}</span><span className="pb-agent-copy"><strong>{a.id}</strong><small title={a.description}>{a.description||'Agent'}</small></span><i className={busy?'busy':''} title={busy?'Working now':undefined} aria-hidden="true"/></button>})}
     {data?.agents.length===0&&<div className="pb-empty"><Icon name="Bot" aria-hidden="true"/><p>No agents found.</p><small>Create an agent to start a conversation.</small></div>}
     {!data&&<div className="pb-skeleton-list" aria-hidden="true">{[0,1,2,3].map(i=><div className="pb-skeleton-row" key={i}><span className="pb-skeleton pb-skeleton-avatar"/><span className="pb-skeleton-copy"><span className="pb-skeleton pb-skeleton-line"/><span className="pb-skeleton pb-skeleton-line short"/></span></div>)}</div>}
     {!data&&<p className="pb-footnote" role="status">{dashboardConfigured===false?'Connect the dashboard to load agents.':'Loading agents…'}</p>}
    </div>
    <p className="pb-footnote">{live.locked?'End the call to switch agents.':voice?'Finish dictation to switch agents.':'Switch agents freely; each chat keeps its draft.'}</p>
   </aside>
   <section className="pb-detail" key={selected}>
    <div className="pb-detail-head">
     <div className="pb-detail-identity">
      {agent&&<span className="pb-node pb-node-lg" aria-hidden="true">{agent.id.slice(0,2).toUpperCase()}</span>}
      <div className="pb-detail-copy"><h2>{agent?.id||'Select an agent'}</h2><p title={agent?.description}>{agent?.description}</p></div>
     </div>
     <span className="pb-chip pb-state-chip" data-state={live.locked?'live':sending?'working':'open'}>{live.locked?'Live voice':sending?'Working':'Ready'}</span>
    </div>
    {agent&&<div className="pb-model-line" title={[agent.model,...agent.providers,...agent.capabilities].filter(Boolean).join(' · ')}><code>{agent.model||'Default model'}</code><span>{agent.providers.join(', ')}{agent.capabilities.length?` · ${agent.capabilities.length} capabilities`:''}</span></div>}
    <div className="pb-chat-binding"><span className="pb-saved-label">Conversation</span><select aria-label="PiBot chat binding" value={chatKey} onChange={e=>{bindingSelections.current[selected]=e.target.value;setBinding(e.target.value)}} disabled={voice||live.locked}><option value="" disabled>Select chat</option>{available.map(b=><option key={b.chatKey} value={b.chatKey}>{b.kind==='bb'?'BB chat':b.canSend?b.chatKey:`${b.chatKey} · saved, read-only`}</option>)}</select><button disabled={!agent||!chatKey||sending||live.locked||historyState==='loading'} onClick={()=>void loadHistory()}>Load session</button></div>
    <div className="pb-conversation" ref={chatScroll} role="log" aria-live="polite" aria-busy={sending||historyState==='loading'}>
     {conversation?.canSend===false&&<p className="pb-history-status" role="status">Saved conversation · read-only. Choose BB chat to send messages to this agent.</p>}
     {historyTruncated&&<p className="pb-history-status" role="status">Earlier history is unavailable beyond this session’s saved boundary.</p>}
     {historyHasMore&&historyBefore&&<button className="pb-load-earlier" disabled={historyState==='loading'||sending||live.locked} onClick={()=>void loadHistory(historyBefore)}><Icon name="ChevronUp" aria-hidden="true"/>Load earlier messages</button>}
     {historyState==='loading'&&<div className="pb-history-loading"><p className="pb-history-status" role="status">Loading current chat history…</p><div className="pb-skeleton-list" aria-hidden="true">{[0,1,2].map(i=><div className="pb-skeleton-row" key={i}><span className="pb-skeleton pb-skeleton-avatar"/><span className="pb-skeleton-copy"><span className="pb-skeleton pb-skeleton-line"/><span className="pb-skeleton pb-skeleton-line short"/></span></div>)}</div></div>}
     {historyError&&<div className="pb-alert" role="alert"><Icon name="AlertTriangle" aria-hidden="true"/><span className="pb-alert-text">Chat history unavailable: {historyError}</span><button disabled={sending||live.locked} onClick={()=>void loadHistory()}>Retry history</button></div>}
     {messages.map((m,i)=>{const readKey=m.id||`message-${i}`;return <article key={m.id||i} className={'pb-message '+m.role}><div className="pb-message-meta"><label>{m.role==='you'?'You':selected}</label>{m.timestamp&&<time dateTime={m.timestamp}>{new Date(m.timestamp).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</time>}{m.role==='agent'&&<button className="pb-read" disabled={live.locked} onClick={()=>void speech.speak(readKey,mediaSummaryText(m.text))}>{speech.reading===readKey?speech.starting?'Starting… · Stop reading':'Stop reading':'Read aloud'}</button>}</div><div className="pb-message-body"><MessageText role={m.role} text={m.text} videos={m.videos}/></div></article>})}
     {!messages.length&&historyState!=='loading'&&!historyError&&<div className="pb-welcome"><span className="pb-welcome-mark" aria-hidden="true"><Icon name="MessageSquare"/></span><h3>{historyState==='ready'?'No messages in the current chat yet':'Your agent’s current chat'}</h3><p>{historyState==='ready'?'Type or dictate a message below to begin.':!chatKey?'Choose an agent and chat binding to load its history.':'Load the session to view existing messages.'}</p></div>}
     {sending&&<div className="pb-working" role="status"><span className="pb-typing" aria-hidden="true"><i/><i/><i/></span><span>Working…</span></div>}
     <div ref={bottom}/>
    </div>
    {error&&<p className="pb-alert" role="alert"><Icon name="AlertTriangle" aria-hidden="true"/><span className="pb-alert-text">{error}</span></p>}
    {conversationsError&&<p className="pb-alert" role="alert">Could not load conversations: {conversationsError}</p>}
    {agent&&!available.length&&!conversationsError&&<p className="pb-footnote" role="status">BB chat requires the PiBot chat update. Saved conversations will appear here when available.</p>}
    {configured===true&&bindingsError&&<p className="pb-alert" role="alert"><Icon name="AlertTriangle" aria-hidden="true"/><span className="pb-alert-text">Could not load chat bindings: {bindingsError}</span><button onClick={()=>setRefresh(x=>x+1)}>Retry</button></p>}
    <div className="pb-composer" onDragOver={e=>{if(Array.from(e.dataTransfer.types).includes('Files'))e.preventDefault()}} onDrop={e=>{if(e.dataTransfer.files.length){e.preventDefault();e.stopPropagation();addAttachments(Array.from(e.dataTransfer.files))}}} onPasteCapture={e=>{const files=Array.from(e.clipboardData.files);if(files.length){e.preventDefault();addAttachments(files)}}}>
     <audio ref={live.audio} controls={live.playbackBlocked} className="pb-call-audio" aria-label="Agent voice playback"/>
     {live.locked?<div className="pb-live-call" data-state={live.state}><div className="pb-live-copy"><span className="pb-live-orb" aria-hidden="true"><i/><i/><i/></span><div><strong>{live.state==='starting'?'Starting live voice…':live.state==='active'?'Live voice':'Ending live voice'}</strong><p role="status">{live.status}</p></div></div><div className="pb-call-actions"><button disabled={live.state!=='active'} onClick={live.toggleMute}>{live.muted?'Unmute mic':'Mute mic'}</button>{live.playbackBlocked&&<button onClick={live.play}>Play agent audio</button>}<button onClick={()=>void live.stop()}>{live.state==='stop-failed'?'Retry remote close':'End call'}</button></div></div>:<><input ref={fileInput} type="file" multiple hidden aria-label="Choose attachments" disabled={!supportsAttachments||voice} onChange={e=>{addAttachments(Array.from(e.currentTarget.files||[]));e.currentTarget.value=''}}/>{attachments.length>0&&<ul className="pb-attachment-drafts" aria-label="Draft attachments">{attachments.map(file=><li key={file.id}>{file.mimeType.startsWith('image/')?<img src={`data:${file.mimeType};base64,${file.dataBase64}`} alt={`Preview of ${file.name}`}/>:<Icon name="File" aria-hidden="true"/>}<span title={file.name}><strong>{file.name}</strong><small>{attachmentSize(file.size)}</small></span><button type="button" aria-label={`Remove ${file.name}`} onClick={()=>removeAttachment(file.id)}><Icon name="X" aria-hidden="true"/></button></li>)}</ul>}{readingAttachments&&<small className="pb-attachment-status" role="status">Reading attachments…</small>}<div className="pb-native-voice" data-voice={voice?'true':undefined}><VoiceInput className="pb-draft-input" value={draft} onValueChange={value=>{drafts.current[historyTarget.current]=value;setDraft(value)}} onVoiceInputActiveChange={setVoice} placeholder={conversation?.canSend===false?'Saved conversation is read-only':agent&&chatKey?'Message your agent…':'Choose an agent and chat to begin…'} aria-label="Message draft" onKeyDown={event=>{if(event.key==='Enter'&&event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.repeat&&!event.nativeEvent.isComposing){event.preventDefault();event.stopPropagation();send()}}} rows={2} disabled={!agent||!chatKey||!canSend}/></div><div className="pb-send-row"><button type="button" className="pb-attach" aria-label="Attach files or images" title={supportsAttachments?'Attach files or images · paste or drop · 4 files, 4 MB each, 8 MB total':'Attachments are available in independent BB chat'} disabled={!supportsAttachments||voice} onClick={()=>fileInput.current?.click()}><Icon name="Paperclip" aria-hidden="true"/></button><label className="pb-checkbox pb-tools-toggle"><input type="checkbox" checked={allowTools} onChange={e=>setAllowTools(e.target.checked)}/> Allow tools</label><small>{voice?'Listening / transcribing…':sending?'This chat is working; you can switch agents':'Alt+Enter to send'}</small><button className="pb-live-start" disabled={!agent||sending||voice||liveAvailable.length!==1||!liveAvailable.some(b=>b.chatKey===chatKey)||audioConfigured!==true||configured!==true} onClick={()=>{void (async()=>{if(!await speech.stop())return;setMessages([]);await live.start(selected,allowTools)})()}}>Live voice ◉</button><button className="pb-primary" disabled={sending||voice||readingAttachments||!agent||!chatKey||!canSend||(!draft.trim()&&!attachments.length)} onClick={send}>Send ↑</button></div>{live.status&&<p className="pb-footnote pb-idle-voice-status" role="status">{live.status}</p>}</>}

    </div>
   </section>
  </main>
  <div className="pb-ancillary">
   <details className="pb-runs">
    <summary><Icon name="Activity" aria-hidden="true"/><span>Delegated runs</span><span className="pb-summary-meta">{data?`${tasks.length} active`:'Awaiting connection'}</span></summary>
    <div className="pb-run-grid">{tasks.map(t=><article className="pb-run" key={t.id}><div className="pb-run-top"><span className="pb-chip" data-state={t.status}>{t.status}</span><code>{t.agentId}</code></div><h3>{t.title}</h3><footer><code>{t.id}</code><button disabled={pending} onClick={()=>void action(async()=>{const result=await rpc.call('cancelTask',{id:t.id});if(!result.cancelled)throw new Error('The run could not be cancelled. It may already have finished.');setRefresh(x=>x+1)})}>Cancel run</button></footer></article>)}</div>
    {!tasks.length&&<div className="pb-empty"><Icon name="Activity" aria-hidden="true"/><p>{data?'No delegated runs are active.':'Waiting for an activity snapshot…'}</p></div>}
    {!!data?.processes.tasks.recent.length&&<details className="pb-subdetails"><summary>Recent runs · {data.processes.tasks.recent.length}</summary>{data.processes.tasks.recent.map(t=><div className="pb-recent" key={t.id}><code>{t.agentId}</code><span>{t.title}</span><small>{t.status}</small></div>)}</details>}
   </details>
   <details className="pb-processes">
    <summary><Icon name="Activity" aria-hidden="true"/><span>Process tree</span><span className="pb-summary-meta">{data?.processes.children.length??'—'} children</span></summary>
    {data&&<div className="pb-process pb-process-root"><span title="PiBot daemon"><i aria-hidden="true"/>PiBot daemon</span><code>PID {data.processes.daemon.pid}</code><small>{age(data.processes.daemon.uptimeSec)} · {Math.round(data.processes.daemon.rssKb/1024)} MB</small></div>}
    {data?.processes.children.map(p=><div key={p.pid} className="pb-process" style={{paddingLeft:`${Math.min(p.depth,8)*18+14}px`}}><span title={p.command}>└ {p.command}</span><code>PID {p.pid} ← {p.ppid}</code><small>{age(p.elapsedSec)} · {Math.round(p.rssKb/1024)} MB</small></div>)}
    {data?.processes.childrenError&&<p className="pb-alert"><Icon name="AlertTriangle" aria-hidden="true"/><span className="pb-alert-text">{data.processes.childrenError}</span></p>}
   </details>
  </div>
 </div>

}
export default definePluginApp(app=>{const VoiceInput=experimental_VoiceInputTextarea;app.slots.navPanel({id:'agents',title:'PiBot agents',icon:'Network',path:'agents',component:()=> <AgentsPage VoiceInput={VoiceInput}/>})});
