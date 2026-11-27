"""Translate A2A task snapshots and human answers to and from MCP Tasks."""

import hashlib
import json
from dataclasses import dataclass
from uuid import NAMESPACE_URL, uuid5

from a2a.types import a2a_pb2 as a2a
from google.protobuf.json_format import MessageToDict, ParseDict
from google.protobuf.struct_pb2 import Value
from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError, ValidationError
from referencing import Registry
from referencing.exceptions import Unresolvable

from .agent import STRUCTURED, AdapterError


def text_parts(parts):
    return "\n".join(p.text for p in parts if p.WhichOneof("content") == "text")


def content(parts):
    """Display inline results; never resolve file parts or external links."""
    blocks = []
    remaining = 16_000
    for part in parts:
        kind = part.WhichOneof("content")
        if kind == "text":
            text = part.text
        elif kind == "data":
            text = json.dumps(MessageToDict(part.data), ensure_ascii=False)
        else:
            text = f"[{kind or 'empty'} part: {part.filename or part.media_type or 'attachment'}]"
        if len(text) > remaining:
            blocks.append({"type": "text", "text": text[:remaining] + "… [truncated]"})
            break
        blocks.append({"type": "text", "text": text})
        remaining -= len(text)
        if len(blocks) == 64:
            break
    return {"resultType": "complete", "content": blocks or [{"type": "text", "text": ""}]}


@dataclass
class Question:
    key: str
    prompt: str
    form: dict
    schema: dict | None
    tag: dict | None
    sequence: dict
    notice: bool = False

    def request(self):
        return {
            "method": "elicitation/create",
            "params": {"mode": "form", "message": self.prompt, "requestedSchema": self.form},
        }

    def reply(self, task, answer):
        if answer.get("action") != "accept":
            raise AdapterError("No answer sent. Answer the pending question or cancel the task.")
        if self.notice:
            return None
        values = answer.get("content")
        if not isinstance(values, dict):
            raise AdapterError("Expected a form answer.")
        if self.schema is None:
            if not isinstance(values.get("reply"), str):
                raise AdapterError("Expected a text reply.")
            part = a2a.Part(text=values["reply"])
        else:
            if self.sequence.keys() & values.keys():
                raise AdapterError("The question sequence cannot be supplied by the client.")
            if values.keys() - self.form["properties"].keys():
                raise AdapterError("The answer contains fields outside the reviewed form.")
            values = {**values, **self.sequence}
            try:
                # Remote references are never fetched while validating an agent's schema.
                Draft202012Validator(self.schema, registry=Registry()).validate(values)
            except (ValidationError, SchemaError, Unresolvable) as exc:
                raise AdapterError("The answer does not satisfy the agent's schema.") from exc
            part = a2a.Part(data=ParseDict(values, Value()))
            part.metadata.update({STRUCTURED: self.tag})
        return a2a.Message(
            message_id=str(uuid5(NAMESPACE_URL, self.key)),
            role=a2a.ROLE_USER,
            context_id=task.context_id,
            task_id=task.id,
            parts=[part],
            extensions=[STRUCTURED] if self.tag else [],
        )


def tool_details(parts):
    """Show the remote tool and arguments as quoted data in Serve permission forms."""
    for part in parts:
        if part.WhichOneof("content") != "data":
            continue
        data = MessageToDict(part.data)
        tool = data.get("toolCall") if isinstance(data, dict) else None
        if isinstance(tool, dict):
            details = {k: tool[k] for k in ("title", "kind", "input") if k in tool}
            if details:
                return json.dumps(details, ensure_ascii=True, separators=(", ", ": "))
    return ""


# Mirror the flat forms supported by the Tasks clients. The remote schema is
# checked before it reaches either a native host renderer or jsonschema.
FORM_KEYS = {"type", "properties", "required", "additionalProperties", "$schema", "title", "description"}
FIELD_KEYS = {
    "type", "title", "description", "default", "enum", "enumNames", "oneOf", "anyOf", "items", "const",
    "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "uniqueItems",
}


def supported_field(field, depth=0):
    if depth > 2 or not isinstance(field, dict) or field.keys() - FIELD_KEYS:
        return False
    if field.get("type") not in (None, "string", "integer", "number", "boolean", "array"):
        return False
    if "items" in field and not supported_field(field["items"], depth + 1):
        return False
    for keyword in ("oneOf", "anyOf"):
        choices = field.get(keyword, [])
        if not isinstance(choices, list) or len(choices) > 64:
            return False
        if not all(supported_field(choice, depth + 1) for choice in choices):
            return False
    return True


def supported_form(schema):
    fields = schema.get("properties", {})
    return (
        not schema.keys() - FORM_KEYS
        and len(json.dumps(schema)) <= 32_768
        and len(fields) <= 32
        and isinstance(schema.get("additionalProperties", True), bool)
        and schema.get("$schema", "https://json-schema.org/draft/2020-12/schema")
        == "https://json-schema.org/draft/2020-12/schema"
        and all(supported_field(field) for field in fields.values())
    )


def question(task, structured):
    status = task.status
    message = status.message
    # Retries of one A2A question may keep its extension id while emitting a
    # fresh message with validation errors. MCP needs a new key for that form.
    identity = [task.id, task.context_id, status.state, MessageToDict(message)]
    key = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    prompt = text_parts(message.parts)
    empty = {"type": "object", "properties": {}}

    def notice(explanation):
        return Question(key, explanation, empty, None, None, {}, notice=True)

    if status.state == a2a.TASK_STATE_AUTH_REQUIRED:
        return notice("The agent requires out-of-band authentication. Complete it with the configured agent.")
    if len(prompt) > 4000:
        return notice("The question is too long to review here. Read it at the configured agent.")
    details = tool_details(message.parts)
    if len(details) > 2400:
        return notice("The remote permission details are too long to review in this form. Inspect the task at the agent.")
    if details:
        prompt += "\nRemote tool request: " + details
    schemas = []
    for part in message.parts:
        tag = MessageToDict(part.metadata).get(STRUCTURED)
        if isinstance(tag, dict) and tag.get("type") == "input_schema":
            schemas.append((part, tag))
    if not schemas:
        form = {"type": "object", "properties": {"reply": {"type": "string"}}, "required": ["reply"]}
        return Question(key, prompt or "What should the agent do next?", form, None, None, {})
    if not structured:
        return notice("The agent did not advertise Structured Input on its card. Answer at the configured agent.")
    if len(schemas) != 1 or schemas[0][0].WhichOneof("content") != "data":
        return notice("The agent sent an invalid Structured Input request. It is still waiting.")
    part, tag = schemas[0]
    schema = MessageToDict(part.data)
    if (
        not isinstance(schema, dict)
        or schema.get("type") != "object"
        or not isinstance(schema.get("properties", {}), dict)
    ):
        return notice("This client can display object forms only. The agent is still waiting.")
    try:
        if not supported_form(schema):
            return notice("This form exceeds the supported fields or limits. Answer it at the configured agent.")
        Draft202012Validator.check_schema(schema)
    except SchemaError:
        return notice("The agent sent an invalid input schema. It is still waiting.")
    form = {k: v for k, v in schema.items() if k not in ("description", "title")}
    fields = dict(schema.get("properties", {}))
    sequence = {}
    # A2A Serve binds each permission to a numeric seq. It is routing data,
    # never a user choice. All other constraints remain visible to the host.
    seq = fields.get("seq")
    if (
        isinstance(seq, dict)
        and isinstance(seq.get("const"), (int, float))
        and not isinstance(seq["const"], bool)
    ):
        sequence = {"seq": fields.pop("seq")["const"]}
        if "required" in form:
            form["required"] = [k for k in form["required"] if k != "seq"]
    form["properties"] = fields
    reply_tag = {"type": "structured_input"}
    if "id" in tag:
        if not isinstance(tag["id"], str):
            return notice("The agent sent an invalid input request ID.")
        reply_tag["id"] = tag["id"]
    return Question(
        key,
        prompt or schema.get("description") or schema.get("title") or "Answer the agent's question.",
        form,
        schema,
        reply_tag,
        sequence,
    )


STATES = {
    a2a.TASK_STATE_SUBMITTED: "working",
    a2a.TASK_STATE_WORKING: "working",
    a2a.TASK_STATE_INPUT_REQUIRED: "input_required",
    a2a.TASK_STATE_AUTH_REQUIRED: "input_required",
    a2a.TASK_STATE_COMPLETED: "completed",
    a2a.TASK_STATE_FAILED: "failed",
    a2a.TASK_STATE_REJECTED: "failed",
    a2a.TASK_STATE_CANCELED: "cancelled",
}


def snapshot(task, record, structured):
    if task.id != record["remote"] or task.context_id != record["context"]:
        raise AdapterError("The agent returned a different task or context.")
    state = STATES.get(task.status.state)
    if state is None:
        raise AdapterError("The agent returned an unknown task state.")
    updated = task.status.timestamp.ToJsonString() if task.status.HasField("timestamp") else record["created"]
    view = {
        "taskId": record["handle"],
        "status": state,
        "createdAt": record["created"],
        "lastUpdatedAt": updated,
        "ttlMs": None,
        "pollIntervalMs": 2000,
    }
    summary = text_parts(task.status.message.parts)[:4000]
    if summary:
        view["statusMessage"] = summary
    if state == "completed":
        parts = (part for artifact in task.artifacts for part in artifact.parts)
        view["result"] = content(parts if task.artifacts else task.status.message.parts)
    elif state == "failed":
        view["error"] = {
            "code": -32000,
            "message": summary or "The A2A agent failed or rejected the request.",
        }
    elif state == "input_required":
        q = question(task, structured)
        view["inputRequests"] = {q.key: q.request()}
    return view
