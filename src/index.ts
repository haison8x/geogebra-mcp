#!/usr/bin/env node
// geogebra-mcp — an MCP server (stdio) that lets an AI draw and edit geometry on a live
// GeoGebra Calculator window, driven through Playwright.
// stdout carries the MCP protocol: log to stderr only.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CATALOG_TEXT, RULES, SERVER_INSTRUCTIONS, drawProblemPrompt } from './rules.js';
import { GeoGebraSession, loadConfig } from './session.js';
import { registerTools } from './tools.js';

const session = new GeoGebraSession(loadConfig());

const server = new McpServer(
  { name: 'geogebra-mcp', version: '0.1.0' },
  { instructions: SERVER_INSTRUCTIONS },
);

registerTools(server, session);

server.registerResource(
  'rules',
  'geogebra://rules',
  { title: 'GeoGebra construction rules', description: 'How to build clean, literal geometry figures with GeoGebra commands', mimeType: 'text/plain' },
  async (uri) => ({ contents: [{ uri: uri.href, text: RULES }] }),
);

server.registerResource(
  'commands',
  'geogebra://commands',
  { title: 'GeoGebra geometry commands', description: 'Catalog of geometry commands with their syntax', mimeType: 'text/plain' },
  async (uri) => ({ contents: [{ uri: uri.href, text: CATALOG_TEXT }] }),
);

server.registerPrompt(
  'draw_geometry_problem',
  {
    title: 'Draw a geometry problem',
    description: 'Draw the figure of a plane-geometry problem on GeoGebra, verify it, and fix mistakes',
    argsSchema: { problem: z.string().describe('The problem statement (any language)') },
  },
  ({ problem }) => ({ messages: [{ role: 'user', content: { type: 'text', text: drawProblemPrompt(problem) } }] }),
);

const shutdown = async () => {
  await session.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);

await server.connect(new StdioServerTransport());
console.error('[geogebra-mcp] ready (the browser opens on the first tool call)');
