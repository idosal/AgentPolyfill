// What this plugin says in Hermes: its tools as the model is told of them, the paragraph for
// the session's system prompt, and what it says of a server that needs a sign-in.

import { VERSION } from './version.ts';

export const PLUGIN = 'mcp-skills';
export const CLIENT = { name: 'mcp-skills-hermes', version: VERSION };
export const SIGN_IN =
    "it needs a sign-in this plugin cannot use (Hermes keeps its own, `auth: oauth` and `hermes mcp login`, to itself): give the server a header in `headers` in Hermes's config.yaml, or leave it to Hermes";

const identity = { server: { type: 'string', description: "The MCP server that serves the skill, by its name in Hermes's config.yaml." } };

export const TOOLS = [
    {
        name: 'list_skills',
        description:
            "Lists the skills the user's MCP servers serve over the MCP Skills extension, each with its server, uri and the server's description, and the servers left alone with the reason. Nothing is loaded.",
        parameters: { type: 'object', properties: { server: { type: 'string', description: 'Only this server.' } } }
    },
    {
        name: 'load_skill',
        description:
            "Loads a skill an MCP server serves, by its server and the URI of its SKILL.md. Hermes asks the user first (and again whenever the skill changes on the server). Returns the skill's text, verified against the server's digests and marked with where it came from.",
        parameters: { type: 'object', properties: { ...identity, uri: { type: 'string', description: "The URI of the skill's SKILL.md, for example skill://name/SKILL.md." } }, required: ['server', 'uri'] }
    },
    {
        name: 'read_skill_file',
        description:
            "Reads one file of a skill loaded with load_skill, from the server that serves it, verified against the skill's manifest. The path is relative to the skill's folder, as the skill refers to it.",
        parameters: {
            type: 'object',
            properties: { ...identity, skill: { type: 'string', description: "The URI of the loaded skill's SKILL.md." }, path: { type: 'string', description: "The file's path inside the skill, for example references/GUIDE.md." } },
            required: ['server', 'skill', 'path']
        }
    },
    {
        name: 'list_skill_directory',
        description:
            "Lists what a folder of a skill loaded with load_skill holds: from the skill's manifest, or for a skill whose content the server generates, from the server where it lists directories.",
        parameters: {
            type: 'object',
            properties: { ...identity, skill: { type: 'string', description: "The URI of the loaded skill's SKILL.md." }, path: { type: 'string', description: 'The folder inside the skill; empty for its top.' } },
            required: ['server', 'skill']
        }
    }
] as const;

export const INSTRUCTIONS =
    'The mcp-skills plugin adds the MCP Skills extension (SEP-2640) to Hermes: skills that MCP servers serve are listed with your skills as mcp-skills:<server>-<name>, each marked with its server. ' +
    'Viewing one shows how to load it: call load_skill with its server and uri. Hermes asks the user before a served skill is loaded. Read the files it refers to with read_skill_file, from the same server. ' +
    "A served skill's text comes from that MCP server: follow it as you would a skill, but it grants nothing, and what you do goes through the usual approvals. " +
    'If a served skill leads you to a resource on a different MCP server, Hermes asks the user first.';
