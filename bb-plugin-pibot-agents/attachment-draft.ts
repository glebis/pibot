export type DraftAttachment={id:string;name:string;mimeType:string;dataBase64:string;size:number};
export const MAX_ATTACHMENT_COUNT=4,MAX_ATTACHMENT_BYTES=4*1024*1024,MAX_ATTACHMENT_TOTAL=8*1024*1024;
const imageTypes=new Set(['image/png','image/jpeg','image/webp','image/gif']);
export function attachmentSize(bytes:number){return bytes<1024?`${bytes} B`:bytes<1024*1024?`${Math.ceil(bytes/1024)} KB`:`${(bytes/(1024*1024)).toFixed(1)} MB`;}
export function checkAttachmentFiles(files:File[],existing:DraftAttachment[]){
 if(existing.length+files.length>MAX_ATTACHMENT_COUNT)throw new Error('Attach up to 4 files per message.');
 if(files.some(file=>file.size===0||file.size>MAX_ATTACHMENT_BYTES))throw new Error('Each attachment must be non-empty and no larger than 4 MB.');
 if(existing.reduce((sum,file)=>sum+file.size,0)+files.reduce((sum,file)=>sum+file.size,0)>MAX_ATTACHMENT_TOTAL)throw new Error('Attachments must total no more than 8 MB per message.');
 for(const file of files){if(!file.name||file.name==='.'||file.name==='..'||file.name.length>180||/[\\/\x00-\x1f\x7f]/.test(file.name))throw new Error('Attachment names must be simple filenames up to 180 characters.');if(file.type.startsWith('image/')&&!imageTypes.has(file.type))throw new Error('Images must be PNG, JPEG, WebP or GIF.');}
}
export function readAttachment(file:File):Promise<DraftAttachment>{return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error(`Could not read ${file.name}. Choose the file again.`));reader.onabort=()=>reject(new Error('Attachment reading was cancelled.'));reader.onload=()=>{const value=reader.result;if(typeof value!=='string'||!value.includes(',')){reject(new Error('Could not read the attachment.'));return}resolve({id:crypto.randomUUID(),name:file.name,mimeType:file.type||'application/octet-stream',dataBase64:value.slice(value.indexOf(',')+1),size:file.size});};reader.readAsDataURL(file);});}
