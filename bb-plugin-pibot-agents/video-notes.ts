export type VideoNotePart={kind:'text';text:string}|{kind:'video';filePath:string;index:number};
/** Only PiBot's exact attachment wrapper is interpreted as media. No file access here. */
export function videoNoteParts(text:string):VideoNotePart[]{
 const pattern=/\[Video note attachment: ("(?:[^"\\\r\n]|\\.){1,4096}")\. Original video retained privately; save, forward to an editing agent, or edit only when requested\. Do not echo its private path unless explicitly asked\.\]/g;
 const parts:VideoNotePart[]=[];let end=0,index=0;
 for(const match of text.matchAll(pattern)){
  let filePath:unknown;try{filePath=JSON.parse(match[1]);}catch{continue;}
  if(typeof filePath!=='string')continue;
  if(match.index!>end)parts.push({kind:'text',text:text.slice(end,match.index)});
  parts.push({kind:'video',filePath,index:index++});end=match.index!+match[0].length;
 }
 if(end<text.length)parts.push({kind:'text',text:text.slice(end)});
 return parts;
}
