/** Display labels for PiBot's own prompt/event markers; ordinary bracketed prose stays prose. */
export function leadingMessageMarker(text:string){
 const match=/^\[(heartbeat|cascade(?:-recover)?|scheduler|goal|compaction-resume|silent-turn|handoff from[^\]\r\n]{1,120})\](?=\s|$)[ \t]*(?:\r?\n)?/i.exec(text);
 if(!match)return null;
 const label=match[1],kind=label.toLowerCase().startsWith('handoff from')?'handoff':label.toLowerCase();
 return {label:`[${label}]`,kind,body:text.slice(match[0].length)};
}
