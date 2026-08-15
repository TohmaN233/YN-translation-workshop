import ReactMarkdown from "react-markdown";

interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
}

export function MarkdownBody({ children, className, isStreaming }: MarkdownBodyProps) {
  return (
    <div
      className={["markdown-body", className].filter(Boolean).join(" ")}
      data-streaming={isStreaming ? "true" : undefined}
    >
      <ReactMarkdown
        components={{
          code({ className: codeClassName, children: codeChildren, ...props }) {
            const language = codeClassName?.replace("language-", "").toLowerCase() ?? "";
            const raw = String(codeChildren);
            const isBlock = codeClassName?.includes("language-") || raw.includes("\n");
            if (isBlock) {
              return (
                <div className="markdown-code-block">
                  <div className="markdown-code-header">
                    <span className="markdown-code-lang">{language || "text"}</span>
                  </div>
                  <pre>{raw.replace(/\n$/, "")}</pre>
                </div>
              );
            }
            return <code className="markdown-inline-code" {...props}>{codeChildren}</code>;
          },
          pre({ children: preChildren }) {
            return <>{preChildren}</>;
          },
          table({ children: tableChildren }) {
            return (
              <div className="markdown-table-wrap">
                <table>{tableChildren}</table>
              </div>
            );
          }
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
