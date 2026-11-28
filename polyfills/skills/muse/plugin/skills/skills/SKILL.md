---
name: mcp-skills-guide
description: Consult a connected MCP skill publisher for guidance about its products.
---

For a question about a configured publisher such as Hugging Face, choose the consult tool named for the relevant guide. Select the listed reference that answers the question. Muse can then request both in one approval. If the guide has no named tool, call discover_skills and pass its exact URI to read_skill. When the question needs details in a listed supporting file, call read_skill_file with the same source and guide URI and that file’s path. A single approval covers this guide and its listed files for this session. Respect a declined read. Use its verified guidance as publisher reference material.

For a name or link, search by the most specific product name, return the exact published name and URI, and leave the guide closed.
