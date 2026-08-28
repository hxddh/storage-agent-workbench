import { memo, type ComponentProps } from "react";
import { MessageCard as LegacyMessageCard } from "./ThreadCardsImplementation";

type MessageCardProps = ComponentProps<typeof LegacyMessageCard>;

function documentShape(content: string | null): "plain" | "structured" | "data-rich" {
  const text = content ?? "";
  if (/^\s*\|.+\|\s*$/m.test(text) || /```[\s\S]*```/.test(text)) return "data-rich";
  if (/^#{1,3}\s+\S/m.test(text) || /^\s*(?:[-*]|\d+\.)\s+\S/m.test(text)) return "structured";
  return "plain";
}

/**
 * Public answer artifact boundary for v0.92.
 *
 * User turns remain conversation input. Assistant turns are explicitly technical
 * documents so layout, evidence linking, review actions and future document
 * navigation can evolve without teaching the historical ThreadCards collection
 * about Agent OS concerns.
 *
 * The proven message implementation is intentionally reused underneath while
 * transport/UI ownership is migrated. This changes the semantic product boundary
 * now without duplicating streaming, copy, regenerate or live-trace behavior.
 */
export const AnswerDocument = memo(function AnswerDocument(props: MessageCardProps) {
  if (props.role === "user") return <LegacyMessageCard {...props} />;

  return (
    <article
      className="answer-document"
      data-testid="answer-document"
      data-streaming={props.streaming ? "true" : "false"}
      data-document-shape={documentShape(props.content)}
      aria-label="Agent answer"
    >
      <LegacyMessageCard {...props} />
    </article>
  );
});
