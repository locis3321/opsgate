/**
 * T6/T7 测试用 mock stdio MCP server（真实子进程）。
 * 注意：派生工具描述必须满足 R1–R8（R3 asset 指引/R4 Use when），否则会被聚合 fail-safe 移除。
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'mock-mcp', version: '1.0.0' });

server.registerTool(
  'echo',
  {
    description:
      '回显一条文本消息。Use when: 用户想测试工具链或"echo 一句话"。Required: 无资产参数；直接传 message。',
    inputSchema: { message: z.string().describe('要回显的文本') },
  },
  async ({ message }) => ({
    content: [{ type: 'text', text: message }],
  }),
);

server.registerTool(
  'boom',
  {
    description:
      '故意抛错的测试工具。Use when: 需要验证错误处理路径。Required: 无参数。',
    inputSchema: {},
  },
  async () => {
    throw new Error('boom');
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
