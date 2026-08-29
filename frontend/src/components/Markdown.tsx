import { Markdown as MarkdownImplementation } from "./MarkdownImplementation";
export * from "./MarkdownImplementation";

/**
 * Public prose boundary for Agent Work Results, Evidence and Report artifacts.
 * The proven parser/safety implementation stays isolated underneath; product UI
 * consumes Agent prose rather than a conversation/answer-document renderer.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="agent-prose min-w-0 break-words" data-testid="agent-prose">
      <MarkdownImplementation text={text} />
    </div>
  );
}
