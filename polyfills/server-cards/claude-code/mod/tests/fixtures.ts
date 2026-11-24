// Snapshots taken 2026-11-24.
// official: ext-server-card examples/ServerCard @ 28db12c9b4.
// live: Server Cards and catalogs as their publishers served them that day.
export const fixtures = {
 "official": {
  "valid": {
   "minimal": {
    "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    "name": "example-org/minimal",
    "version": "1.0.0",
    "description": "Smallest valid Server Card."
   },
   "remote-extensions-info": {
    "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    "name": "example-org/with-extensions-info",
    "version": "1.0.0",
    "description": "Server Card whose remote publishes extension information.",
    "remotes": [
     {
      "type": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "supportedProtocolVersions": [
       "2026-07-28"
      ],
      "extensionsInfo": {
       "io.modelcontextprotocol/events": {
        "webhooks": {
         "signingKeys": {
          "keys": [
           {
            "kty": "OKP",
            "crv": "Ed25519",
            "kid": "2026-10",
            "x": "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"
           }
          ]
         },
         "egressIpRanges": [
          "203.0.113.0/24",
          "2001:db8::/32"
         ]
        }
       }
      }
     }
    ]
   },
   "templated-remote": {
    "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    "name": "example-org/with-remote",
    "version": "2.1.0",
    "description": "Server Card with a templated remote endpoint and headers.",
    "title": "Example Remote Server",
    "websiteUrl": "https://example.com",
    "remotes": [
     {
      "type": "streamable-http",
      "url": "https://{tenant}.example.com/mcp",
      "headers": [
       {
        "name": "Authorization",
        "description": "Bearer token for the remote endpoint.",
        "isRequired": true,
        "isSecret": true,
        "value": "Bearer {token}",
        "variables": {
         "token": {
          "description": "API token issued by Example Inc.",
          "isRequired": true,
          "isSecret": true
         }
        }
       }
      ],
      "variables": {
       "tenant": {
        "description": "Tenant subdomain.",
        "isRequired": true,
        "default": "default"
       }
      },
      "supportedProtocolVersions": [
       "2025-06-18",
       "2025-11-25"
      ]
     }
    ]
   }
  },
  "invalid": {
   "date-versioned-schema": {
    "$schema": "https://static.modelcontextprotocol.io/schemas/2025-11-25/server-card.schema.json",
    "name": "example-org/wrong-schema-url",
    "version": "1.0.0",
    "description": "Uses date-versioned schema URL; only /v1/ URLs are valid."
   },
   "bad-name-pattern": {
    "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    "name": "no-slash-in-name",
    "version": "1.0.0",
    "description": "Name must contain exactly one slash separating namespace and server name."
   },
   "wrong-schema-name": {
    "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server.schema.json",
    "name": "example-org/wrong-schema-name",
    "version": "1.0.0",
    "description": "References the removed registry server.json schema; only server-card.schema.json is valid in v1."
   },
   "missing-name": {
    "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    "version": "1.0.0",
    "description": "Missing required `name` field."
   },
   "non-object-extension-info": {
    "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    "name": "example-org/bad-extension",
    "version": "1.0.0",
    "description": "Extension information must be an object, not a boolean.",
    "remotes": [
     {
      "type": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "extensionsInfo": {
       "io.modelcontextprotocol/tasks": true
      }
     }
    ]
   },
   "missing-schema": {
    "name": "example-org/no-schema",
    "version": "1.0.0",
    "description": "Missing the required `$schema` field."
   }
  }
 },
 "live": {
  "api.githubcopilot.com_mcp_server-card": {
   "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
   "name": "io.github.github/github-mcp-server",
   "version": "github-mcp-server/remote-ebf3fb61f828cd6a46622e1703ac0d56ca769b9a",
   "description": "Connect AI assistants to GitHub - manage repos, issues, PRs, and workflows through natural language.",
   "title": "GitHub",
   "websiteUrl": "https://github.com/github/github-mcp-server",
   "repository": {
    "url": "https://github.com/github/github-mcp-server",
    "source": "github",
    "id": "942771284"
   },
   "remotes": [
    {
     "type": "streamable-http",
     "url": "https://api.githubcopilot.com/mcp/"
    }
   ]
  },
  "hf-rembg": {
   "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
   "name": "hf-space-hysts-mcp-rembg",
   "title": "Rembg",
   "description": "image background removal",
   "version": "1.0.0",
   "remotes": [
    {
     "type": "streamable-http",
     "url": "https://hysts-mcp-rembg.hf.space/gradio_api/mcp/"
    }
   ],
   "websiteUrl": "https://huggingface.co/spaces/hysts-mcp/rembg",
   "_meta": {
    "source": "huggingface-space",
    "spaceId": "hysts-mcp/rembg",
    "hubUrl": "https://huggingface.co/spaces/hysts-mcp/rembg",
    "appUrl": "https://hysts-mcp-rembg.hf.space",
    "sdk": "gradio",
    "tags": [
     "gradio",
     "mcp-server",
     "region:us"
    ],
    "runtimeStage": "RUNNING",
    "sdkVersion": "6.2.0"
   }
  },
  "huggingface.co_mcp_server-card": {
   "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
   "name": "huggingface.co/mcp",
   "version": "0.4.39",
   "description": "Official MCP server for the Hugging Face Hub.",
   "title": "Hugging Face",
   "websiteUrl": "https://huggingface.co/mcp",
   "remotes": [
    {
     "type": "streamable-http",
     "url": "https://huggingface.co/mcp"
    }
   ]
  },
  "mcp.buildkite.com_mcp_server-card": {
   "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
   "name": "com.buildkite/remote-mcp-server",
   "title": "Buildkite",
   "description": "Connect AI clients to Buildkite workflows and CI/CD data.",
   "version": "0.0.0-BUILD-982",
   "websiteUrl": "https://buildkite.com",
   "remotes": [
    {
     "type": "streamable-http",
     "url": "https://mcp.buildkite.com/mcp"
    }
   ]
  },
  "mcp.context7.com_mcp_server-card": {
   "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
   "name": "io.github.upstash/context7",
   "title": "Context7",
   "description": "Up-to-date, version-specific documentation and code examples for software libraries.",
   "version": "4.7.3",
   "websiteUrl": "https://context7.com",
   "icons": [
    {
     "src": "https://context7.com/context7-icon-green.svg",
     "mimeType": "image/svg+xml",
     "sizes": [
      "any"
     ]
    },
    {
     "src": "https://context7.com/context7-icon-green.png",
     "mimeType": "image/png",
     "sizes": [
      "512x512"
     ]
    }
   ],
   "remotes": [
    {
     "type": "streamable-http",
     "url": "https://mcp.context7.com/mcp",
     "headers": [
      {
       "name": "Authorization",
       "description": "Optional. A Context7 API key from https://context7.com/dashboard raises the rate limit.",
       "isRequired": false,
       "isSecret": true,
       "value": "Bearer {api_key}",
       "variables": {
        "api_key": {
         "description": "Context7 API key",
         "isSecret": true,
         "placeholder": "ctx7sk-..."
        }
       }
      }
     ]
    }
   ]
  },
  "mcp.exa.ai_mcp_server-card": {
   "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
   "name": "ai.exa/exa",
   "version": "3.5.1",
   "title": "Exa",
   "description": "Official Exa MCP for web search, content fetching, and multi-step research.",
   "websiteUrl": "https://exa.ai",
   "icons": [
    {
     "src": "https://exa.ai/images/logo/exa-logomark-blue.svg",
     "mimeType": "image/svg+xml",
     "sizes": [
      "any"
     ]
    },
    {
     "src": "https://exa.ai/images/favicon-32x32.png",
     "mimeType": "image/png",
     "sizes": [
      "32x32"
     ]
    }
   ],
   "repository": {
    "url": "https://github.com/exa-labs/exa-mcp-server",
    "source": "github"
   },
   "remotes": [
    {
     "type": "streamable-http",
     "url": "https://mcp.exa.ai/mcp",
     "headers": [
      {
       "name": "x-api-key",
       "description": "Exa API key. Optional: without it (or OAuth) the server runs at limited usage and without agent tools.",
       "isRequired": false,
       "isSecret": true
      }
     ],
     "supportedProtocolVersions": [
      "2025-11-25",
      "2025-06-18",
      "2025-03-26",
      "2024-11-05",
      "2024-10-07"
     ]
    }
   ],
   "transport": {
    "type": "streamable-http",
    "endpoint": "https://mcp.exa.ai/mcp"
   }
  },
  "mcp.netlify.com_mcp_server-card": {
   "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
   "name": "com.netlify/mcp",
   "title": "Netlify",
   "description": "Create, deploy, and manage Netlify projects, deploys, environment variables, forms, and teams.",
   "version": "1.22.1",
   "websiteUrl": "https://docs.netlify.com/build/build-with-ai/netlify-mcp-server/",
   "repository": {
    "url": "https://github.com/netlify/netlify-mcp",
    "source": "github"
   },
   "icons": [
    {
     "src": "https://www.netlify.com/favicon/icon.svg",
     "mimeType": "image/svg+xml",
     "sizes": [
      "any"
     ]
    },
    {
     "src": "https://www.netlify.com/favicon/apple-touch-icon.png",
     "mimeType": "image/png",
     "sizes": [
      "180x180"
     ]
    }
   ],
   "remotes": [
    {
     "type": "streamable-http",
     "url": "https://mcp.netlify.com/mcp"
    }
   ]
  },
  "mcp.notion.com_mcp_server-card": {
   "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
   "name": "com.notion/mcp",
   "title": "Notion MCP",
   "description": "Search, read, and update pages in your Notion workspace.",
   "version": "1.2.0",
   "websiteUrl": "https://developers.notion.com/docs/mcp",
   "icons": [
    {
     "src": "https://mcp.notion.com/notion-logo-block-sticker.svg",
     "mimeType": "image/svg+xml"
    }
   ],
   "remotes": [
    {
     "type": "streamable-http",
     "url": "https://mcp.notion.com/mcp"
    }
   ]
  },
  "neon.com_.well-known_mcp_docs-server-card": {
   "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
   "name": "com.neon/docs-mcp",
   "title": "Neon Docs",
   "description": "Search and read Neon documentation over MCP. No authentication required.",
   "repository": {
    "url": "https://github.com/neondatabase/mcp-server-neon",
    "source": "github",
    "subfolder": "landing"
   },
   "version": "1.0.0",
   "websiteUrl": "https://neon.com/docs/ai/neon-mcp-server",
   "icons": [
    {
     "src": "https://neon.com/brand/neon-logomark-light-color.svg",
     "mimeType": "image/svg+xml",
     "sizes": [
      "any"
     ],
     "theme": "light"
    },
    {
     "src": "https://neon.com/brand/neon-logomark-dark-color.svg",
     "mimeType": "image/svg+xml",
     "sizes": [
      "any"
     ],
     "theme": "dark"
    }
   ],
   "remotes": [
    {
     "type": "streamable-http",
     "url": "https://neon.com/docs/mcp"
    }
   ]
  },
  "neon.com_.well-known_mcp_server-card": {
   "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
   "name": "com.neon/mcp",
   "version": "2.0.0",
   "description": "Official Neon MCP server for managing Neon projects and Lakebase Postgres databases.",
   "title": "Neon",
   "websiteUrl": "https://neon.com/docs/ai/neon-mcp-server",
   "repository": {
    "url": "https://github.com/neondatabase/mcp-server-neon",
    "source": "github"
   },
   "icons": [
    {
     "src": "https://neon.com/brand/neon-logomark-light-color.svg",
     "mimeType": "image/svg+xml",
     "sizes": [
      "any"
     ],
     "theme": "light"
    },
    {
     "src": "https://neon.com/brand/neon-logomark-dark-color.svg",
     "mimeType": "image/svg+xml",
     "sizes": [
      "any"
     ],
     "theme": "dark"
    }
   ],
   "url": "https://mcp.neon.tech/mcp",
   "transport": "http",
   "remotes": [
    {
     "type": "streamable-http",
     "url": "https://mcp.neon.tech/mcp"
    }
   ],
   "serverInfo": {
    "name": "Neon MCP",
    "version": "1.0.0"
   },
   "endpoint": "https://mcp.neon.tech/mcp",
   "authentication": {
    "type": "oauth2",
    "authorization_server": "https://mcp.neon.tech"
   },
   "capabilities": {
    "tools": {},
    "resources": {}
   }
  },
  "supabase.com_.well-known_mcp_server-card": {
   "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
   "name": "com.supabase/mcp",
   "title": "Supabase",
   "version": "0.18.0",
   "description": "MCP server for interacting with the Supabase platform",
   "websiteUrl": "https://supabase.com/mcp",
   "repository": {
    "url": "https://github.com/supabase/mcp",
    "source": "github",
    "subfolder": "packages/mcp-server-supabase"
   },
   "icons": [
    {
     "src": "https://supabase.com/favicon/android-icon-192x192.png",
     "mimeType": "image/png",
     "sizes": [
      "192x192"
     ]
    },
    {
     "src": "https://supabase.com/images/supabase-logo-icon.svg",
     "mimeType": "image/svg+xml",
     "sizes": [
      "any"
     ]
    }
   ],
   "remotes": [
    {
     "type": "streamable-http",
     "url": "https://mcp.supabase.com/mcp"
    }
   ]
  },
  "zapier.com_.well-known_mcp_server-card": {
   "name": "com.zapier/mcp",
   "version": "1.0.0",
   "description": "Connect AI agents to 9,000+ app integrations and 40,000+ actions via the Model Context Protocol. Execute actions across Slack, Gmail, Google Sheets, Jira, GitHub, HubSpot, and thousands more.",
   "title": "Zapier MCP",
   "websiteUrl": "https://docs.zapier.com/mcp/home",
   "repository": {
    "url": "https://github.com/zapier/zapier-mcp",
    "source": "github"
   },
   "remotes": [
    {
     "type": "streamable-http",
     "url": "https://mcp.zapier.com/api/v1/connect",
     "supportedProtocolVersions": [
      "2025-11-25",
      "2025-06-18",
      "2025-03-26",
      "2024-11-05",
      "2024-10-07"
     ]
    }
   ],
   "capabilities": {
    "tools": {
     "listChanged": false
    }
   },
   "auth": {
    "type": "oauth2",
    "authorizationUrl": "https://mcp.zapier.com/oauth/authorize",
    "tokenUrl": "https://mcp.zapier.com/api/v1/oauth/token",
    "authorizationServers": [
     "https://mcp.zapier.com"
    ],
    "scopes": [
     "openid",
     "profile",
     "email"
    ]
   }
  }
 },
 "catalogs": {
  "buildkite.com": {
   "specVersion": "1.0",
   "host": {
    "displayName": "Buildkite",
    "identifier": "buildkite.com",
    "documentationUrl": "https://buildkite.com/docs/apis/mcp-server"
   },
   "entries": [
    {
     "identifier": "urn:air:buildkite.com:mcp:buildkite",
     "displayName": "Buildkite MCP Server",
     "type": "application/mcp-server-card+json",
     "url": "https://mcp.buildkite.com/mcp/server-card",
     "description": "Buildkite's hosted MCP server. Lets AI agents investigate failed builds, read job logs, find flaky tests, and manage pipelines, builds, artifacts, annotations, clusters, and Test Engine results in Buildkite.",
     "tags": [
      "buildkite",
      "ci",
      "cd",
      "ci-cd",
      "pipelines",
      "builds",
      "test-engine",
      "mcp-server"
     ],
     "representativeQueries": [
      "why did my latest Buildkite build fail",
      "show the logs for the failed job in this CI build",
      "find flaky tests in my Buildkite test suite",
      "trigger a new build of my pipeline on the main branch",
      "list the pipelines in my Buildkite organization"
     ]
    }
   ]
  },
  "huggingface.co": {
   "specVersion": "1.0",
   "host": {
    "displayName": "Hugging Face",
    "identifier": "huggingface.co",
    "documentationUrl": "https://github.com/huggingface/hf-discover"
   },
   "entries": [
    {
     "identifier": "urn:air:huggingface.co:registry:discover",
     "displayName": "Hugging Face Discover Registry",
     "type": "application/ai-registry+json",
     "url": "https://huggingface-hf-discover.hf.space",
     "description": "Search indexed Hugging Face Skills, Space skills and MCP-enabled Spaces.",
     "tags": [
      "huggingface",
      "registry",
      "search",
      "skills",
      "spaces",
      "mcp-server"
     ]
    },
    {
     "identifier": "urn:air:huggingface.co:mcp:hub",
     "displayName": "Hugging Face Hub MCP Server",
     "type": "application/mcp-server-card+json",
     "url": "https://huggingface.co/mcp/server-card"
    }
   ]
  },
  "supabase.com": {
   "specVersion": "1.0",
   "host": {
    "displayName": "Supabase",
    "identifier": "https://supabase.com",
    "documentationUrl": "https://supabase.com/docs"
   },
   "entries": [
    {
     "identifier": "urn:air:supabase.com:mcp:server",
     "displayName": "Supabase MCP server",
     "type": "application/json",
     "url": "https://mcp.supabase.com/mcp",
     "description": "The Supabase MCP server endpoint (streamable HTTP, OAuth-protected) for managing projects, database schema, and queries from MCP clients.",
     "tags": [
      "mcp",
      "server",
      "agents"
     ],
     "representativeQueries": [
      "connect my agent to Supabase over MCP",
      "run a query against my Supabase project from an MCP client",
      "manage my Supabase project from my coding agent"
     ]
    },
    {
     "identifier": "urn:air:supabase.com:mcp:server-card",
     "displayName": "Supabase MCP server card",
     "type": "application/mcp-server-card+json",
     "url": "https://supabase.com/.well-known/mcp/server-card.json",
     "description": "MCP Server Card for the hosted Supabase MCP server: its registry name and streamable HTTP remote.",
     "tags": [
      "mcp",
      "server-card",
      "agents"
     ],
     "representativeQueries": [
      "find the Supabase MCP server URL and transport",
      "discover the Supabase MCP server before connecting an MCP client"
     ]
    },
    {
     "identifier": "urn:air:supabase.com:metadata:mcp-oauth",
     "displayName": "Supabase MCP OAuth metadata",
     "type": "application/json",
     "url": "https://api.supabase.com/.well-known/oauth-protected-resource/mcp",
     "description": "OAuth protected-resource metadata for connecting clients to the Supabase MCP server.",
     "tags": [
      "mcp",
      "oauth",
      "authorization",
      "metadata"
     ],
     "representativeQueries": [
      "authenticate an MCP client to the Supabase MCP server with OAuth",
      "what OAuth scopes does the Supabase MCP server support"
     ]
    },
    {
     "identifier": "urn:air:supabase.com:api:management",
     "displayName": "Supabase Management API",
     "type": "application/openapi+json",
     "url": "https://api.supabase.com/api/v1-json",
     "description": "OpenAPI 3.0 description of the Supabase Management API for managing organizations, projects, branches, and configuration.",
     "tags": [
      "api",
      "openapi",
      "projects",
      "management"
     ],
     "representativeQueries": [
      "create a new Supabase project",
      "list the branches of my Supabase project",
      "update the Postgres config of a Supabase project"
     ]
    },
    {
     "identifier": "urn:air:supabase.com:docs:llms-txt",
     "displayName": "Supabase llms.txt",
     "type": "text/plain",
     "url": "https://supabase.com/llms.txt",
     "description": "Index of Supabase documentation and content available as agent-readable markdown.",
     "tags": [
      "documentation",
      "llms",
      "markdown"
     ],
     "representativeQueries": [
      "how do I set up Supabase auth in Next.js",
      "Supabase Row Level Security documentation"
     ]
    },
    {
     "identifier": "urn:air:supabase.com:skills:index",
     "displayName": "Supabase Agent Skills",
     "type": "application/json",
     "url": "https://supabase.com/.well-known/agent-skills/index.json",
     "description": "Agent Skills discovery index for installable Supabase and Postgres skills.",
     "tags": [
      "skills",
      "agents",
      "postgres"
     ],
     "representativeQueries": [
      "write RLS policies for my Supabase tables",
      "create a Postgres migration for my Supabase project"
     ]
    }
   ]
  },
  "github.com": {
   "specVersion": "1.0",
   "entries": [
    {
     "identifier": "urn:air:github.com:mcp:github-mcp-server",
     "type": "application/mcp-server-card+json",
     "url": "https://api.githubcopilot.com/mcp/server-card"
    }
   ]
  },
  "neon.tech": {
   "specVersion": "1.0",
   "host": {
    "displayName": "Neon",
    "identifier": "neon.com",
    "documentationUrl": "https://neon.com/docs",
    "logoUrl": "https://neon.com/brand/neon-logomark-dark-color.svg"
   },
   "entries": [
    {
     "identifier": "urn:air:neon.com:mcp:neon",
     "displayName": "Neon MCP Server",
     "type": "application/mcp-server-card+json",
     "url": "https://neon.com/.well-known/mcp/server-card.json",
     "description": "Neon MCP server for managing Neon Postgres projects, branches, databases, and running SQL from AI agents and MCP clients.",
     "tags": [
      "postgres",
      "database",
      "mcp",
      "neon"
     ]
    },
    {
     "identifier": "urn:air:neon.com:mcp:neon-docs",
     "displayName": "Neon Docs MCP Server",
     "type": "application/mcp-server-card+json",
     "url": "https://neon.com/.well-known/mcp/docs-server-card.json",
     "description": "Search and read Neon documentation over MCP. No authentication required.",
     "tags": [
      "docs",
      "documentation",
      "mcp",
      "neon"
     ]
    },
    {
     "identifier": "urn:air:neon.com:skill:neon-postgres",
     "displayName": "Lakebase Postgres",
     "type": "application/agent-skills+md",
     "url": "https://neon.com/.well-known/agent-skills/neon-postgres/SKILL.md",
     "description": "Guides and best practices for working with Lakebase Postgres on Neon: connections, pooled vs direct, schema migrations, branching (including schema-only, reset-from-parent, and branch-per-PR workflows), autoscaling, scale-to-zero, instant restore, read replicas, IP allow lists, logical replication, egress optimization, and Lakebase Search. Use when the work is an existing DATABASE_URL, SQL, schema, inspect, or search. New backends, Auth, files, Functions, and LLM calls go to the parent `neon` skill. Live queries, reactive UIs, and realtime data go to `neon-realtime`. Also use for \"@neondatabase/serverless\", \"@neon/neon-js\", \"neon inspect db\", \"neon postgres computes\", \"Neon branch\", \"schema-only branch\", \"reset branch\", \"branch per PR\", high database bills, network transfer or egress, Free plan limits or a compute suspended over quota (SQLSTATE 53000, HTTP 402), SELECT * optimization, query overfetching, \"semantic search\", \"vector search\", \"full-text search\", \"BM25\", or \"hybrid search\"."
    },
    {
     "identifier": "urn:air:neon.com:skill:neon",
     "displayName": "Neon",
     "type": "application/agent-skills+md",
     "url": "https://neon.com/.well-known/agent-skills/neon/SKILL.md",
     "description": "Overview of Neon, a complete set of cloud backend primitives around Lakebase Postgres: Auth, Object Storage, Functions, the AI Gateway, and Realtime. Start here to choose Neon for undecided login, files, APIs, and LLM calls, set up the CLI or MCP server, and follow the branch-first workflow. Use when building an app or backend on Neon, or when \"Neon\" or \"Lakebase Postgres\" is mentioned. Child skill neon-postgres wins for an existing DATABASE_URL, SQL, schema, inspect, or search. Child skill neon-auth wins for login, users, sessions, identity routing, and Managed Better Auth setup. Child skill neon-realtime wins for live queries in reactive apps and agents. Also use for object storage, S3, buckets, serverless functions, function triggers, cron, AI gateway, LLM calls, realtime, logs, Loki, Grafana, observability, postgres, database, backend, Claimable Neon, neon.new, a no-signup database, or pairing Neon with Upstash for cache, Redis, rate limiting, queues, or background jobs."
    },
    {
     "identifier": "urn:air:neon.com:skill:neon-auth",
     "displayName": "Neon Auth",
     "type": "application/agent-skills+md",
     "url": "https://neon.com/.well-known/agent-skills/neon-auth/SKILL.md",
     "description": "Add authentication to a new app. Use for \"add auth\", \"add login\", Neon Auth (Managed Better Auth), identity routing, sign-up, sign-in, password reset, email OTP, magic links, organizations, phone OTP, OAuth, OAuth server for MCP or third-party OAuth clients, passkeys, MFA, trusted domains, invalid domain, and @neon/auth. No existing identity: default to Managed Better Auth. Keep working Better Auth, Clerk, Supabase Auth, or another IdP. User asked to migrate from Supabase Auth: Managed Better Auth. A required plugin outside Managed support: self-managed Better Auth on a Neon Function or the existing app host. Also use for auth APIs in @neon/neon-js."
    },
    {
     "identifier": "urn:air:neon.com:skill:neon-postgres-agent-platforms",
     "displayName": "Neon AI Agent Program",
     "type": "application/agent-skills+md",
     "url": "https://neon.com/.well-known/agent-skills/neon-postgres-agent-platforms/SKILL.md",
     "description": "Build and operate multi-tenant AI agent platforms on Neon. Use this skill whenever the user is designing an agent/app builder, provisioning a Neon project or database per user/app/agent run, managing thousands of tenant projects, separating sponsored free users from paid customers, moving projects between orgs, choosing `@neon/sdk` vs `@neon/tools`, choosing personal vs organization vs project-scoped API keys, tracking fleet consumption or Agent Plan costs, configuring scale to zero (`suspend_timeout_seconds`) for tenant databases, creating compound checkpoints that combine DB snapshots with source revisions/secrets/deploy metadata, or orchestrating snapshot/restore flows for generated apps. Also use it for Neon Agent Program, Agent Plan, org/project limits, HIPAA, co-marketing, support, or neondatabase/neon-for-agent-platforms examples."
    },
    {
     "identifier": "urn:air:neon.com:skill:neon-object-storage",
     "displayName": "Neon Object Storage",
     "type": "application/agent-skills+md",
     "url": "https://neon.com/.well-known/agent-skills/neon-object-storage/SKILL.md",
     "description": "S3-compatible object storage that branches with your database, so each branch gets its own copy of the files and the rows that point at them. Use when a user wants object storage, a bucket, blob/file storage, or somewhere to put uploads, images, documents, avatars, or user-generated files for their app or agent \u2014 especially when they already use (or are setting up) Lakebase Postgres and don't want to add a separate storage provider like AWS S3, Cloudflare R2, or Supabase Storage. Triggers include \"object storage\", \"bucket\", \"blob storage\", \"file storage\", \"store uploads/images/files\", \"S3-compatible storage\", \"presigned URL\", \"where do I put files\", \"storage logs\", \"bucket logs\", \"CDN in front of object storage\", \"Neon Object Storage\", \"Neon Storage\", and \"storage that branches with my database\"."
    },
    {
     "identifier": "urn:air:neon.com:skill:neon-ai-gateway",
     "displayName": "Neon AI Gateway",
     "type": "application/agent-skills+md",
     "url": "https://neon.com/.well-known/agent-skills/neon-ai-gateway/SKILL.md",
     "description": "One API and one credential for frontier and open-source LLMs and embedding models, built into your Neon branch and powered by Databricks. Use when a user wants to call an LLM, generate embeddings, add AI/chat/an agent to their app, route between model providers (OpenAI, Anthropic, Google/Gemini, Meta, Alibaba, and more), or avoid juggling separate provider API keys and accounts \u2014 especially when they already use Neon and want AI requests to branch with their project. Works with the OpenAI SDK, Anthropic SDK, google-genai, the Vercel AI SDK, and Mastra by changing only the base URL. Triggers include \"call an LLM\", \"add AI to my app\", \"chat completion\", \"model routing\", \"LLM proxy/gateway\", \"one API for all models\", \"use Claude/GPT/Gemini\", \"AI SDK\", \"Mastra agent\", \"Neon AI Gateway\", \"generate embeddings\", \"generate images\", and \"log/rate-limit AI calls\"."
    },
    {
     "identifier": "urn:air:neon.com:skill:neon-functions",
     "displayName": "Neon Functions",
     "type": "application/agent-skills+md",
     "url": "https://neon.com/.well-known/agent-skills/neon-functions/SKILL.md",
     "description": "Long-running, serverless Node.js HTTP functions deployed onto your Neon branch, with DATABASE_URL injected automatically and compute that runs next to your data. Use when a user wants to host an API, an AI agent with long streaming responses, a WebSocket or server-sent-events (SSE) server, a webhook handler, a Discord bot, an MCP server, or any request/response workload that risks timing out on short, lambda-style serverless functions \u2014 and wants it to branch with their database. Also use for Function Triggers: a cron or an object-storage event that POSTs to a function. Triggers include \"serverless function\", \"deploy an API\", \"long-running function\", \"streaming agent\", \"SSE server\", \"WebSocket server\", \"webhook handler\", \"MCP server\", \"cron\", \"scheduled function\", \"object storage trigger\", \"on upload\", \"function that won't time out\", \"function logs\", \"Neon Functions\", \"Neon Compute\", \"DDoS protection\", \"rate limiting\", and \"production hardening\". For live UIs over database rows, use neon-realtime."
    },
    {
     "identifier": "urn:air:neon.com:skill:neon-realtime",
     "displayName": "Neon Realtime",
     "type": "application/agent-skills+md",
     "url": "https://neon.com/.well-known/agent-skills/neon-realtime/SKILL.md",
     "description": "Neon Realtime makes any SQL query live. Build realtime, reactive apps and agents on Lakebase Postgres with live SQL queries and reactivity primitives. Use when app UI or agent state must update live from database rows (dashboards, feeds, collaboration, multi-user or multi-device sync), for optimistic mutations, or to replace polling or other realtime sync systems. Triggers include \"live query\", \"subscribe\", \"sync engine\", \"useLiveQuery\", \"TanStack DB\", \"optimistic updates\", \"@neon/realtime\". For push that doesn't come from database rows (presence, typing, LLM streams), use neon-functions."
    }
   ]
  }
 }
} as const
