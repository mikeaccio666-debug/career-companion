import ReactMarkdown from 'react-markdown';
import PrivateFileLink from './PrivateFileLink';
import PrivateImage from './PrivateImage';

/** Private result links in assistant prose use the same route policy as attachment cards. */
export default function ChatMarkdown({ children }: { children: string }) {
  return <ReactMarkdown components={{
    a: ({ href, children: content }) => href?.startsWith('/api/platform/')
      ? <PrivateFileLink url={href}>{content}</PrivateFileLink>
      : <a href={href}>{content}</a>,
    img: ({ src, alt }) => typeof src === 'string' && src.startsWith('/api/platform/')
      ? <PrivateImage url={src} alt={alt || '会话图片'} />
      : <img src={src} alt={alt} loading="lazy" />,
  }}>{children}</ReactMarkdown>;
}
