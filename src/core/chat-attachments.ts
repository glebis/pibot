import {createHash,randomUUID} from 'node:crypto';
import {constants,lstatSync,mkdirSync,openSync,writeFileSync,closeSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import type {ImageContent} from '@earendil-works/pi-ai';

export type ChatAttachment={name:string;mimeType:string;dataBase64:string};
export type ValidatedAttachment=ChatAttachment&{bytes:Buffer;sha256:string;image:boolean};
export const CHAT_ATTACHMENT_FILE_LIMIT=4*1024*1024;
export const CHAT_ATTACHMENT_TOTAL_LIMIT=8*1024*1024;
export class ChatAttachmentError extends Error {}
function invalid(message:string):never{throw new ChatAttachmentError(message);}
function imageMime(bytes:Buffer):string|undefined{
 if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
 if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
 if(bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
 if(bytes.length>=6&&['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)))return 'image/gif';
}
/** Validate all bytes before filesystem writes or execution receipts. Paths are never accepted. */
export function validateChatAttachments(value:unknown,allowTools:boolean):ValidatedAttachment[]{
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>4)invalid('Attachments: attach at most four files.');
 let total=0;
 return value.map((item:unknown)=>{
  if(!item||typeof item!=='object'||Array.isArray(item))invalid('Attachment is invalid.');
  const a=item as Record<string,unknown>;
  if(Object.keys(a).some(k=>!['name','mimeType','dataBase64'].includes(k))||typeof a.name!=='string'||!a.name||a.name.length>180||/[\\/\x00-\x1f\x7f]/.test(a.name)||['.','..'].includes(a.name)||typeof a.mimeType!=='string'||!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(a.mimeType)||typeof a.dataBase64!=='string')invalid('Attachment name, type or data is invalid.');
  const {name,mimeType,dataBase64}=a as ChatAttachment;
  if(!dataBase64.length||dataBase64.length>Math.ceil(CHAT_ATTACHMENT_FILE_LIMIT/3)*4||dataBase64.length%4||/[^A-Za-z0-9+/=]/.test(dataBase64)||dataBase64.slice(0,-2).includes('='))invalid('Attachment data must be canonical base64, at most 4 MiB per file.');
  const bytes=Buffer.from(dataBase64,'base64');total+=bytes.length;
  if(!bytes.length||bytes.length>CHAT_ATTACHMENT_FILE_LIMIT||bytes.toString('base64')!==dataBase64||total>CHAT_ATTACHMENT_TOTAL_LIMIT)invalid('Attachments exceed the 4 MiB file or 8 MiB total limit.');
  const detected=imageMime(bytes),image=mimeType.startsWith('image/');
  if((image&&(!['image/png','image/jpeg','image/webp','image/gif'].includes(mimeType)||detected!==mimeType))||(!image&&detected))invalid('Image type does not match its contents or is unsupported.');
  if(!image&&!allowTools)invalid('Files require Allow tools so the agent can read attachments.');
  return {name,mimeType,dataBase64,bytes,sha256:createHash('sha256').update(bytes).digest('hex'),image};
 });
}
export const chatAttachmentFingerprint=(attachments:ValidatedAttachment[])=>attachments.map(({name,mimeType,sha256})=>({name,mimeType,sha256}));
/** Generic files persist privately because saved agent conversations reference them later. */
export function prepareChatAttachments(dataDir:string,attachments:ValidatedAttachment[]):{text:string;images:ImageContent[]}{
 const images:ImageContent[]=[],lines:string[]=[];
 for(const a of attachments){
  if(a.image){images.push({type:'image',data:a.dataBase64,mimeType:a.mimeType});lines.push(`Image attached: ${JSON.stringify(a.name)} (${a.mimeType}).`);continue;}
  try{
  const root=realpathSync(dataDir),rootStat=lstatSync(root);
  if(!rootStat.isDirectory()||rootStat.uid!==process.getuid?.()||(rootStat.mode&0o022))invalid('Attachment private storage is unavailable.');
  const dir=join(root,'bb-attachments');mkdirSync(dir,{mode:0o700,recursive:true});
  const st=lstatSync(dir);
  if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077)||realpathSync(dir)!==dir)invalid('Attachment private storage is unavailable.');
  const file=join(dir,randomUUID());const fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,a.bytes);}finally{closeSync(fd);}
  lines.push(`File attached: ${JSON.stringify(a.name)} (${a.mimeType}, ${a.bytes.length} bytes).\n[file stored at ${file} — read tool]`);
  }catch(error){if(error instanceof ChatAttachmentError)throw error;throw new ChatAttachmentError('Attachment private storage is unavailable.');}
 }
 return {text:lines.join('\n\n'),images};
}
