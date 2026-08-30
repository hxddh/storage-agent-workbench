"""Durable Agent Task runtime (v0.94).

The Agent Task is the application, and this package is where that stops being a
projection and becomes the runtime's own shape:

- ``store``    — durable repositories for agent_tasks / task_executions /
                 execution_events / work_results / task_decisions /
                 task_artifacts / task_context_versions.
- ``runtime``  — the execution supervisor: the ONE submission lifecycle. It owns
                 background execution workers keyed by durable task identity,
                 consumes Steer/Stop signals against the CURRENT execution, and
                 publishes durable structured progress events.
- ``hub``      — the in-process live layer over the durable event log (answer
                 deltas + wakeups). Durable events live in SQLite; the hub only
                 accelerates delivery and carries the transient delta stream.
- ``context``  — the typed, versioned Storage Task Context snapshot.
- ``recovery`` — sidecar-restart semantics: executions a dead process left
                 queued/running are stamped ``interrupted`` (a durable state the
                 user can resume), never silently forgotten.
- ``artifacts``— the first-class Artifact registrar (reports, evidence imports,
                 analyses index into one task-scoped artifact model).

Compatibility: sessions/session_messages/runs/tool_calls remain the durable
storage vocabulary; ``agent_tasks.id`` equals the session id so every adapter
keeps addressing the same object. The legacy ``/sessions`` message endpoints
delegate here — there is no second submit path and no second agent.
"""

from . import artifacts, context, event_stream, hub, recovery, runtime, store  # noqa: F401

__all__ = ["artifacts", "context", "event_stream", "hub", "recovery", "runtime", "store"]
