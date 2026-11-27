# x-mcp task runner. Run `just` to list recipes.

set shell := ["bash", "-euo", "pipefail", "-c"]

local_mcp := "http://localhost:8787/mcp"
remote_mcp := "https://x.mcp.2-38.com/mcp"

# List recipes
default:
    @just --list

# Install dependencies with pnpm
install:
    pnpm install

# Run the Worker locally at http://localhost:8787/mcp
dev:
    pnpm run dev

# Generate Worker runtime types and type-check src/ and test/
check:
    pnpm run check

# Run the unit and integration tests
test:
    pnpm test

# Bundle the Worker without deploying (uses wrangler.example.jsonc)
build:
    pnpm run build

# Run everything CI runs, except the workerd smoke test
ci: check test build

# MCP smoke test against a running server (add --offline to skip upstream calls)
smoke url=local_mcp *flags="":
    pnpm run smoke {{ url }} {{ flags }}

# MCP smoke test against the public endpoint
smoke-remote:
    pnpm run smoke {{ remote_mcp }}

# Deploy with your local wrangler.jsonc (copy it from wrangler.example.jsonc first)
deploy:
    pnpm run deploy
