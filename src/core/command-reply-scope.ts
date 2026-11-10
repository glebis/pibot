import type {PushOptions,Transport} from './types.js';

/** New owner commands may have identical replies; retries of one command may not.
 * Scope only its invoking chat, leaving explicit identities and proactive pushes intact.
 * Binding methods to the original transport preserves native/private-field receivers.
 */
export function commandReplyScope(t:Transport,chatId:string,messageId?:number):{transport:Transport;close:()=>void} {
  if(messageId===undefined||!Number.isSafeInteger(messageId)||messageId<1)return {transport:t,close:()=>{}};
  let slot=0,active=true;
  const methods=new Map<PropertyKey,unknown>();
  const push=async(targetChatId:string,opts:PushOptions)=>{
    if(!active||targetChatId!==chatId)return t.push(targetChatId,opts);
    const position=slot++;
    return t.push(targetChatId,opts.dedupeKey!==undefined?opts:{...opts,dedupeKey:`command:${t.name}:${chatId}:${messageId}:${position}`});
  };
  const transport=new Proxy(t,{
    get(target,key){
      if(key==='push')return push;
      const value=Reflect.get(target,key,target);
      if(typeof value!=='function')return value;
      if(!methods.has(key))methods.set(key,value.bind(target));
      return methods.get(key);
    },
  });
  return {transport,close:()=>{active=false;}};
}
