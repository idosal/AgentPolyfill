---
name: mcp-tasks-guide
description: Start and check operator-enabled jobs from a connected MCP Tasks publisher.
---

Use the named job tool directly when available. Use list_task_tools to find enabled jobs. Call run_task once. Use check_task with the returned handle and honor retryAfterMs. Ask the user before cancelling a job.
