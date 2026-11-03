export interface Endpoint { url:string; token:string }
/** Only explicit origins; credentials never follow redirects or arbitrary RPC URLs. */
export function endpoint(url:string, token:string|undefined):Endpoint {
  let u:URL; try { u=new URL(url); } catch { throw new Error('Enter a valid PiBot service URL in plugin settings.'); }
  const local=['127.0.0.1','localhost','[::1]'].includes(u.hostname);
  if((u.protocol!=='https:'&&!(u.protocol==='http:'&&local))||u.username||u.password||u.pathname!=='/'||u.search||u.hash)
    throw new Error('Use an HTTPS origin or a loopback HTTP origin, without paths or credentials.');
  if(!token?.trim()||/[\r\n]/.test(token)) throw new Error('Add the service bearer token in plugin settings.');
  return {url:u.origin,token:token.trim()};
}
export class ServiceError extends Error { constructor(public status:number) {
  super(status===401||status===403?'PiBot rejected authentication or the selected chat binding. Check plugin settings.':status===409?'PiBot is busy or this session is no longer current. No automatic retry was made.':status===404?'This PiBot endpoint or session is unavailable. Check the service version and reconnect.':`PiBot service failed (${status}). Check its health before retrying.`);
} }
export async function request(target:Endpoint,path:string,method='GET',body?:unknown,signal?:AbortSignal,timeoutMs=50_000):Promise<unknown> {
  const controller=new AbortController();
  const abort=()=>controller.abort(); signal?.addEventListener('abort',abort,{once:true}); if(signal?.aborted)abort();
  const timeout=setTimeout(abort,timeoutMs);
  try {
    const r=await fetch(`${target.url}${path}`,{method,redirect:'error',signal:controller.signal,
      headers:{authorization:`Bearer ${target.token}`,accept:'application/json',...(body===undefined?{}:{'content-type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(!r.ok){await r.body?.cancel();throw new ServiceError(r.status);}
    if(!r.headers.get('content-type')?.includes('application/json')){await r.body?.cancel();throw new Error('PiBot returned a non-JSON response. Check the service URL.');}
    const reader=r.body?.getReader(); if(!reader)throw new Error('Empty service response.');
    const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1_048_576){await reader.cancel();throw new Error('PiBot response exceeded the size limit.');}chunks.push(value);}}
    finally{reader.releaseLock();}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch(error) {
    if(error instanceof ServiceError)throw error;
    if(error instanceof Error&&/PiBot|Empty service/.test(error.message))throw error;
    throw new Error('Could not reach PiBot or confirm the request outcome. No automatic retry was made.');
  } finally {clearTimeout(timeout);signal?.removeEventListener('abort',abort);}
}
