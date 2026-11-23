#!/usr/bin/env bash
# Fetches the spec this case works from, at a pinned commit of the MCP specification repository.
set -eu
curl -fsSL 'https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/b0be8f0f2481be8d5ea5294cf3fa57cd03cedc48/seps/2640-skills-extension.md' -o sep-2640.md
