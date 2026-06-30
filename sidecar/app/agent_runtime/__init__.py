"""Conversational session agent runtime.

The single LLM in the product (via the OpenAI Agents SDK) investigates over the
EXISTING whitelisted, read-only tools. The agent never sees credentials, never
calls boto3/shell directly, and can only invoke allowlisted tools. All
inputs/outputs are sanitized and bounded before they enter the LLM context, SSE,
reports, or logs. The deterministic ``runs/`` compute it invokes has no LLM.
"""
