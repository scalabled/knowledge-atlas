import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Safe-ish Markdown for Ask library answers and Grok research reports. */
export default function MarkdownView({ content, className = '' }: { content: string; className?: string }) {
  if (!content.trim()) return null
  return (
    <div className={`md-body ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
          ),
          // Avoid giant nested lists blowing the panel height; still readable
          img: ({ src, alt }) => (
            <a href={src} target="_blank" rel="noreferrer noopener" className="md-img-link">{alt || src}</a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
