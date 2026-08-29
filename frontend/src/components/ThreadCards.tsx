/**
 * Public conversation-content boundary.
 *
 * v0.92 makes the assistant answer an explicit technical-document artifact while
 * the remaining proposal/finding/triage/run renderers continue behind the proven
 * implementation module. An explicit export wins over the star export below, so
 * Thread imports migrate to AnswerDocument without rewriting the legacy renderer
 * collection in one risky step.
 */
export { AnswerDocument as MessageCard } from "./AnswerDocument";
export * from "./ThreadCardsImplementation";
