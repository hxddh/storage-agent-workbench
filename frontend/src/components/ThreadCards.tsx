/**
 * Public Agent-task content boundary.
 *
 * Direction and Work Result are the primary task primitives. Specialized
 * execution, proposal, finding and triage renderers remain exported from the
 * implementation module because they represent real tool/runtime artifacts,
 * not alternate chat surfaces.
 */
export { AnswerDocument as MessageCard, AnswerDocument as AgentTaskContent } from "./AnswerDocument";
export * from "./ThreadCardsImplementation";
