export type ChatMessage={id?:string;role:string;text:string;timestamp?:string;videos?:Array<{index:number;src:string}>};
/** Keep expanded earlier pages only when the saved tail proves this is an append. */
export function mergeHistory(current:ChatMessage[],next:ChatMessage[],sameSession:boolean,savedTail?:string){
 const start=next[0]?.id?current.findIndex(m=>m.id===next[0].id):-1;
 const retainEarlier=!!(sameSession&&savedTail&&next.some(m=>m.id===savedTail)&&start>=0);
 const messages=retainEarlier?[...current.slice(0,start),...next]:next;
 return {messages:JSON.stringify(current)===JSON.stringify(messages)?current:messages,retainEarlier};
}
