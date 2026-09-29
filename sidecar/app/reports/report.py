"""The Task report: a Markdown document projected from the task's items.

Conclusion first, one findings list, the Agent's next steps, the record of
each Direction, coverage and gaps from the tool trace, outputs and attached
evidence, usage, and an always-present Safety section. Only this module's own
words are localized (en/zh); the Agent's words are reproduced as recorded.
Redacted and bounded; no raw rows, no secrets, no chain-of-thought (none is
ever stored). A section with nothing behind it is not written.
"""

from __future__ import annotations

from collections import Counter
from typing import Any

from ..core import store
from ..engines import datasets
from ..security.redaction import redact_text

_SEV = {"high": 0, "medium": 1, "low": 2, "info": 3}
_EXCERPT = 800
_MAX_TURNS = 40

_COPY = {
    "goal": ("Goal", "目标"),
    "conclusion": ("Conclusion", "结论"),
    "findings": ("Findings", "发现"),
    "next": ("Next steps", "后续步骤"),
    "record": ("What was done", "工作记录"),
    "coverage": ("Coverage and gaps", "覆盖范围与缺口"),
    "tools": ("Tools used", "使用的工具"),
    "outputs": ("Outputs", "产出"),
    "evidence": ("Attached evidence", "附加证据"),
    "usage": ("Usage", "用量"),
    "safety": ("Safety", "安全"),
    "created": ("Created", "创建于"),
    "directions": ("Directions", "指示"),
    "tool_calls": ("tool calls", "次工具调用"),
    "failed": ("failed or refused", "失败或被拒绝"),
    "no_gaps": ("Every tool call returned.", "所有工具调用均已返回。"),
    "stopped": ("Stopped by the user; the answer covers the work done before the stop.",
                "被用户停止；回答只覆盖停止前完成的工作。"),
    "interrupted": ("Interrupted by a restart.", "因重启而中断。"),
    "failed_turn": ("Did not finish", "未完成"),
    "no_answer": ("(no answer recorded)", "（未记录回答）"),
    "requests": ("model requests", "次模型请求"),
    "tokens_in": ("input tokens", "输入 token"),
    "tokens_out": ("output tokens", "输出 token"),
    "safety_1": ("Storage was only read: Storage Agent has no tool that writes to, deletes from or reconfigures "
                 "storage. Any fix in this report is text for you to apply.",
                 "存储只被读取：Storage Agent 没有任何写入、删除或修改存储配置的工具。报告中的修复均为供你执行的文本。"),
    "safety_2": ("Credentials stayed in the encrypted local vault and never reached the model, this report or "
                 "the logs.", "凭据始终保存在本地加密保险库中，从未进入模型、本报告或日志。"),
    "safety_3": ("Evidence imports are bounded to 500 files / 256 MiB per call and audited; raw log and inventory "
                 "rows never reach the model.", "证据导入每次最多 500 个文件 / 256 MiB 且有审计；原始日志与清单行不会进入模型。"),
}


def _t(key: str, lang: str) -> str:
    en, zh = _COPY[key]
    return zh if lang == "zh" else en


def _clip(text: Any, n: int = _EXCERPT) -> str:
    s = redact_text(str(text or "")).strip()
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def _oneline(text: Any, n: int = 300) -> str:
    return " ".join(_clip(text, n).split())


def _findings(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Every conclusion's findings, latest first, de-duplicated on their words."""
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for it in reversed(items):
        if it["type"] != "conclusion":
            continue
        for f in it["payload"].get("findings") or []:
            key = " ".join(str(f.get("title", "")).lower().split())
            if key and key not in seen:
                seen.add(key)
                out.append(f)
    return sorted(out, key=lambda f: _SEV.get(f.get("severity", "info"), 3))


def render(conn: Any, task_id: str, *, lang: str = "en") -> str:
    lang = "zh" if lang == "zh" else "en"
    task = store.get_task(conn, task_id)
    if task is None:
        return ""
    chain = store.branch(conn, task_id)
    items = store.items_for_turns(conn, [t["id"] for t in chain])
    by_turn: dict[str, list[dict[str, Any]]] = {}
    for it in items:
        by_turn.setdefault(it["turn_id"], []).append(it)

    calls = [i for i in items if i["type"] == "tool_call"]
    outputs = [i for i in items if i["type"] == "tool_output"]
    conclusions = [i for i in items if i["type"] == "conclusion"]
    latest = conclusions[-1]["payload"] if conclusions else None

    lines: list[str] = [f"# {redact_text(task['title'])}", ""]
    lines.append(f"_{_t('created', lang)} {task['created_at']} · {len(chain)} {_t('directions', lang)} · "
                 f"{len(calls)} {_t('tool_calls', lang)}_")

    def section(key: str, body: list[str]) -> None:
        if body:
            lines.extend(["", f"## {_t(key, lang)}", "", *body])

    first = next((i["payload"]["text"] for i in items if i["type"] == "user_message"), "")
    section("goal", [_clip(first)] if first else [])
    section("conclusion", [_clip(latest.get("answer"), 400)] if latest and latest.get("answer") else [])
    section("findings", [
        f"- **{f.get('severity', 'info').upper()}** — {_oneline(f.get('title'), 240)}"
        + (f"  \n  {_oneline(f.get('detail'), 600)}" if f.get("detail") else "")
        for f in _findings(items)])
    section("next", [f"- {_oneline(s, 200)}" for s in (latest or {}).get("next_steps") or []])

    record: list[str] = []
    for n, turn in enumerate(chain[-_MAX_TURNS:], 1):
        its = by_turn.get(turn["id"], [])
        record.append(f"### {n}. {_oneline(turn['direction'], 200)}")
        tools_here = Counter(i["payload"]["name"] for i in its if i["type"] == "tool_call")
        if tools_here:
            record.append("")
            record.append(", ".join(f"`{name}` ×{c}" if c > 1 else f"`{name}`" for name, c in tools_here.items()))
        answer = next((i["payload"]["text"] for i in reversed(its) if i["type"] == "agent_message"), "")
        record.append("")
        if turn["status"] == "cancelled":
            record.append(f"_{_t('stopped', lang)}_")
            record.append("")
        elif turn["status"] == "interrupted":
            record.append(f"_{_t('interrupted', lang)}_")
            record.append("")
        elif turn["status"] == "failed":
            record.append(f"_{_t('failed_turn', lang)}: {_oneline(turn.get('error'), 200)}_")
            record.append("")
        record.append(_clip(answer) if answer else f"_{_t('no_answer', lang)}_")
        record.append("")
    section("record", record[:-1] if record else [])

    failed = [o for o in outputs if not o["payload"].get("ok", True)]
    cov = [f"- {_oneline(o['payload'].get('name'), 60)}: {_oneline(o['payload'].get('summary'), 200)}"
           for o in failed[:25]]
    section("coverage", cov or ([_t("no_gaps", lang)] if calls else []))

    counts = Counter(c["payload"]["name"] for c in calls)
    section("tools", [f"| {'Tool' if lang == 'en' else '工具'} | {'Calls' if lang == 'en' else '次数'} |", "|---|---:|"]
            + [f"| `{name}` | {c} |" for name, c in counts.most_common(25)] if counts else [])

    arts = store.list_artifacts(conn, task_id)
    section("outputs", [f"- {_oneline(a['title'], 160)} ({a['kind']}, {a['created_at']})" for a in arts[:30]])
    files = datasets.list_for_task(conn, task_id)
    section("evidence", [f"- {_oneline(d['filename'], 120)} — {d['dataset_type']}, {d['origin']}"
                         + (f", {d['row_count']} rows" if d.get("row_count") else "") for d in files[:50]])

    usage = Counter()
    for t in chain:
        for k, v in (store.loads(t["usage_json"], {}) or {}).items():
            if isinstance(v, int):
                usage[k] += v
    section("usage", [f"- {usage['requests']} {_t('requests', lang)} · {usage['input_tokens']:,} "
                      f"{_t('tokens_in', lang)} · {usage['output_tokens']:,} {_t('tokens_out', lang)}"]
            if usage.get("requests") else [])
    section("safety", [f"- {_t('safety_1', lang)}", f"- {_t('safety_2', lang)}", f"- {_t('safety_3', lang)}"])
    return "\n".join(lines).rstrip() + "\n"
