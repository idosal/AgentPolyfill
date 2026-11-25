# Interop target: FastMCP 4.2.6 with fastmcp-tasks 4.2.6 (SEP-2663). The Tasks protocol side
# (capability, CreateTaskResult, tasks/get|update|cancel, Mcp-Name checks) is entirely FastMCP's;
# these few tools only give it work to do.
import asyncio
import sys
import mcp_types

from fastmcp import Context, FastMCP
from fastmcp_tasks import TasksExtension

mcp = FastMCP("fastmcp-tasks-interop")
mcp.add_extension(TasksExtension())


@mcp.tool(task=True)
async def slow_add(a: int, b: int, seconds: float = 3) -> str:
    """Adds two numbers, slowly, as a background task."""
    await asyncio.sleep(seconds)
    return f"{a} + {b} = {a + b}"


@mcp.tool(task=True)
async def greet(ctx: Context):
    """Asks the user for their name during the task, then greets them."""
    answers = ctx.input_responses
    if not answers or "name" not in answers:
        return mcp_types.InputRequiredResult(input_requests={"name": mcp_types.ElicitRequest(params=mcp_types.ElicitRequestFormParams(message="What is your name?", requested_schema={"type": "object", "properties": {"name": {"type": "string", "title": "Your name"}}, "required": ["name"]}))})
    r = answers["name"]
    if getattr(r, "action", None) != "accept":
        return f"No name given ({getattr(r, 'action', '?')})."
    return f"Hello, {(r.content or {}).get('name')}!"


@mcp.tool(task=True)
async def summarize_with_your_model(ctx: Context):
    """Asks the client to run its model (sampling) during the task."""
    if not ctx.input_responses:
        return mcp_types.InputRequiredResult(input_requests={"s1": mcp_types.CreateMessageRequest(params=mcp_types.CreateMessageRequestParams(messages=[mcp_types.SamplingMessage(role="user", content=mcp_types.TextContent(type="text", text="Summarize this."))], max_tokens=50))})
    return "got a sample"


@mcp.tool(task=True)
async def long_job(seconds: float = 120) -> str:
    """A job that takes a long time (to cancel)."""
    await asyncio.sleep(seconds)
    return "finished"


@mcp.tool
def echo(text: str) -> str:
    """Answers at once, with no task."""
    return text


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 47930
    mcp.run(transport="http", host="127.0.0.1", port=port, show_banner=False)
