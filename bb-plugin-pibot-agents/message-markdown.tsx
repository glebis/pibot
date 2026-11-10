import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { UrlLink } from '@get-bb/plugin-sdk/app';
import {Children,createContext,useContext,type ComponentPropsWithoutRef} from 'react';
import {leadingMessageMarker} from './message-markers';
import {MessageMarker} from './message-marker';

const CodeBlock=createContext(false);
const InsideLink=createContext(false);
function MessageCode({children,...props}:ComponentPropsWithoutRef<'code'>){
 const block=useContext(CodeBlock);
 const linked=useContext(InsideLink);
 const text=typeof children==='string'?children:'';
 let href:string|undefined;
 if(!block&&!linked&&/^https?:\/\/\S+$/i.test(text)){
  try{const url=new URL(text);if(url.hostname)href=text}catch{}
 }
 const code=<code {...props}>{children}</code>;
 return href?<UrlLink href={href}>{code}</UrlLink>:code;
}

// Bundle the parser with the plugin: a failed host lazy chunk must not hide text.
// react-markdown escapes raw HTML and applies its safe URL transform by default.
export function MessageMarkdown({content}:{content:string}) {
 return <div className="pb-message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
  a:({href,children,title})=><InsideLink.Provider value={true}>{href?<UrlLink href={href} title={title}>{children}</UrlLink>:<span>{children}</span>}</InsideLink.Provider>,
  pre:({node,children,...props})=><CodeBlock.Provider value={true}><pre {...props}>{children}</pre></CodeBlock.Provider>,
  code:({node,...props})=><MessageCode {...props}/>,
  p:({children})=>{const parts=Children.toArray(children),first=parts[0],marker=typeof first==='string'?leadingMessageMarker(first):null;return <p>{marker?<><MessageMarker kind={marker.kind} label={marker.label}/>{marker.body}{parts.slice(1)}</>:children}</p>},
 }}>{content}</ReactMarkdown></div>;
}
