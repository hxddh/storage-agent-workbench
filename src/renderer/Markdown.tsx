import { Copy } from 'lucide-react'
import { isValidElement, type ReactNode, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Dict } from './i18n'
import { copyText } from './lib/export'

/** A fenced block as the agent wrote it, with the one action a reader needs. */
export function CodeBlock({ text, language, t }: { text: string; language?: string; t: Dict }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{language ?? 'text'}</span>
        <button
          className="text-action"
          type="button"
          onClick={async () => {
            if (await copyText(text)) {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }
          }}
        >
          <Copy size={12} aria-hidden="true" />
          {copied ? t.copied : t.copy}
        </button>
      </div>
      <pre className="code">
        <code>{text}</code>
      </pre>
    </div>
  )
}

function codeOf(children: ReactNode): { text: string; language?: string } {
  const child = Array.isArray(children) ? children[0] : children
  if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
    const language = /language-([\w-]+)/.exec(child.props.className ?? '')?.[1]
    return {
      text: String(child.props.children ?? '').replace(/\n$/, ''),
      ...(language ? { language } : {}),
    }
  }
  return { text: String(children ?? '') }
}

export default function Markdown({
  text,
  components,
  t,
}: {
  text: string
  components?: Parameters<typeof ReactMarkdown>[0]['components']
  t: Dict
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        pre: ({ children }) => {
          const code = codeOf(children)
          return <CodeBlock text={code.text} language={code.language} t={t} />
        },
        table: ({ children }) => (
          <div className="table-wrap prose-table">
            <table className="data">{children}</table>
          </div>
        ),
        ...components,
      }}
    >
      {text}
    </ReactMarkdown>
  )
}
