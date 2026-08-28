/**
 * Public conversation-content boundary.
 *
 * Message, proposal, finding, triage and run-card implementations are isolated
 * from the thread state machine. The goal is not another barrel for its own sake:
 * v0.91 needs the conversation flow to be replaceable independently from the
 * 28 KB collection of renderers it currently uses.
 */
export * from "./ThreadCardsImplementation";
