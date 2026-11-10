import {z} from 'zod';

export const MAX_ATTACHMENT_BYTES=4*1024*1024;
export const MAX_TOTAL_ATTACHMENT_BYTES=8*1024*1024;
export const MAX_ATTACHMENTS=4;
export const attachmentSchema=z.object({
 name:z.string().min(1).max(180).refine(name=>name!=='.'&&name!=='..'&&!/[\\/\x00-\x1f\x7f]/.test(name),'Use a filename without folders or control characters.'),
 mimeType:z.string().max(120).regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i),
 dataBase64:z.string().min(4).max(4*Math.ceil(MAX_ATTACHMENT_BYTES/3)).refine(data=>data.length%4===0&&/^[A-Za-z0-9+/]*={0,2}$/.test(data),'Invalid attachment encoding.'),
}).strict();
export function attachmentBytes(a:{dataBase64:string}){return a.dataBase64.length*3/4-(a.dataBase64.endsWith('==')?2:a.dataBase64.endsWith('=')?1:0);}
export const attachmentsSchema=z.array(attachmentSchema).max(MAX_ATTACHMENTS).superRefine((files,ctx)=>{
 if(files.some(f=>attachmentBytes(f)>MAX_ATTACHMENT_BYTES))ctx.addIssue({code:'custom',message:'Each file must be 4 MB or smaller.'});
 if(files.reduce((n,f)=>n+attachmentBytes(f),0)>MAX_TOTAL_ATTACHMENT_BYTES)ctx.addIssue({code:'custom',message:'Attachments must total 8 MB or less.'});
 if(files.some(f=>f.mimeType.startsWith('image/')&&!['image/png','image/jpeg','image/webp','image/gif'].includes(f.mimeType)))ctx.addIssue({code:'custom',message:'Images must be PNG, JPEG, WebP or GIF.'});
});
export type ChatAttachment=z.infer<typeof attachmentSchema>;
