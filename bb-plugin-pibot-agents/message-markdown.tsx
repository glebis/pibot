import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { UrlLink } from '@get-bb/plugin-sdk/app';

// Bundle the parser with the plugin: a failed host lazy chunk must not hide text.
// react-markdown escapes raw HTML and applies its safe URL transform by default.
export function MessageMarkdown({content}:{content:string}) {
 return <div className="pb-message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
  a:({href,children,title})=>href?<UrlLink href={href} title={title}>{children}</UrlLink>:<span>{children}</span>,
 }}>{content}</ReactMarkdown></div>;
}
