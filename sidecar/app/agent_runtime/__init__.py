"""Controlled LLM agent planner (Phase 07).

An OPTIONAL planner mode that lets an LLM (via the OpenAI Agents SDK) plan and
explain over the EXISTING whitelisted, read-only tools. The agent never sees
credentials, never calls boto3/shell directly, and can only invoke allowlisted
tools through the shared ``tool_runner``. All inputs/outputs are sanitized and
bounded before they enter the LLM context, SSE, reports, or logs. Deterministic
mode remains the default and is unaffected.
"""
