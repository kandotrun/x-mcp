import { describe, expect, it } from 'vitest';
import { describeTools, instructions, TOOL_NAMES } from '../src/contract/tools';
import { connect, fakeUpstream, json } from './helpers';
import legacy from './fixtures/tools-list-0.1.json';

type JsonSchema = {
  type?: string;
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  enum?: unknown[];
};
type ListedTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: { properties?: Record<string, JsonSchema>; required?: string[] };
};

const BRAND_RE = /fx\s*twitter/i;

/** Length bounds implied by a simple ^[...]{min,max}$ pattern. */
function patternLengthBounds(pattern: string | undefined): { min: number; max: number } | undefined {
  const match = pattern === undefined ? null : /^\^\[[^\]]+\]\{(\d+),(\d+)\}\$$/.exec(pattern);
  return match ? { min: Number(match[1]), max: Number(match[2]) } : undefined;
}

async function listTools(searchEnabled: boolean): Promise<ListedTool[]> {
  const client = await connect(fakeUpstream(() => json({})).fetch, {
    UPSTREAM_BASE_URL: 'https://upstream.test/api/fx',
    SEARCH_ENABLED: String(searchEnabled)
  });
  return (await client.listTools()).tools as ListedTool[];
}

describe('backward compatibility with the 0.1 tools/list', () => {
  it('keeps every 0.1 tool, in order, with every parameter at least as permissive', async () => {
    const tools = await listTools(false);
    const legacyTools = legacy.tools as unknown as ListedTool[];

    expect(tools.slice(0, legacyTools.length).map((tool) => tool.name)).toEqual(legacyTools.map((tool) => tool.name));
    for (const old of legacyTools) {
      const current = tools.find((tool) => tool.name === old.name)!;
      const required = new Set(old.inputSchema.required ?? []);
      for (const name of current.inputSchema.required ?? []) {
        expect(required.has(name), `${old.name}: new required parameter ${name}`).toBe(true);
      }
      for (const [name, before] of Object.entries(old.inputSchema.properties ?? {})) {
        const after = current.inputSchema.properties?.[name];
        const where = `${old.name}.${name}`;
        expect(after, `${where} was removed`).toBeDefined();
        if (after === undefined) continue;
        expect(after.type, `${where} type`).toBe(before.type);
        expect(after.default, `${where} default`).toEqual(before.default);
        // A 0.1 pattern such as ^[0-9]{1,30}$ already bounded the length.
        const bounds = patternLengthBounds(before.pattern);
        const oldMinLength = before.minLength ?? bounds?.min ?? 0;
        const oldMaxLength = before.maxLength ?? bounds?.max;
        if (after.minLength !== undefined) expect(after.minLength, `${where} minLength`).toBeLessThanOrEqual(oldMinLength);
        if (oldMaxLength === undefined) expect(after.maxLength, `${where} maxLength`).toBeUndefined();
        else if (after.maxLength !== undefined) expect(after.maxLength, `${where} maxLength`).toBeGreaterThanOrEqual(oldMaxLength);
        if (after.minimum !== undefined) expect(after.minimum, `${where} minimum`).toBeLessThanOrEqual(before.minimum ?? Number.NEGATIVE_INFINITY);
        if (after.maximum !== undefined) expect(after.maximum, `${where} maximum`).toBeGreaterThanOrEqual(before.maximum ?? Number.POSITIVE_INFINITY);
        if (after.pattern !== undefined) expect(after.pattern, `${where} pattern`).toBe(before.pattern);
        if (before.enum !== undefined) expect(after.enum, `${where} enum`).toEqual(expect.arrayContaining(before.enum));
        if (before.enum === undefined) expect(after.enum, `${where} enum`).toBeUndefined();
      }
    }
  });
});

describe('tool descriptions', () => {
  it.each([false, true])('describe usage, results and examples (search enabled: %s)', async (searchEnabled) => {
    const tools = await listTools(searchEnabled);
    for (const tool of tools) {
      const description = tool.description ?? '';
      expect(tool.title, tool.name).toBeTruthy();
      expect(description, tool.name).toMatch(/returns?/i);
      expect(description.length, tool.name).toBeLessThanOrEqual(2_048);
      const searchTool = tool.name === 'search_posts' || tool.name === 'typeahead';
      if (!searchTool || searchEnabled) expect(description, tool.name).toContain('Example');
      const count = tool.inputSchema.properties?.count as { description?: string } | undefined;
      if (count !== undefined) expect(count.description, `${tool.name}.count`).toMatch(/1-100 \(default 10\)/);
    }
  });

  it('marks search tools as unavailable only while the flag is off', () => {
    expect(describeTools({ searchEnabled: false }).search_posts.description).toContain('Currently unavailable');
    expect(describeTools({ searchEnabled: true }).search_posts.description).not.toContain('Currently unavailable');
    expect(describeTools({ searchEnabled: false }).typeahead.title).toContain('currently unavailable');
  });

  it('keeps tools/list and the server instructions within client limits', async () => {
    for (const searchEnabled of [false, true]) {
      const size = JSON.stringify(await listTools(searchEnabled)).length;
      expect(size).toBeLessThanOrEqual(22_000);
      expect(instructions({ searchEnabled }).length).toBeLessThanOrEqual(2_048);
    }
  });

  it('never names the upstream project', async () => {
    for (const searchEnabled of [false, true]) {
      expect(JSON.stringify(await listTools(searchEnabled))).not.toMatch(BRAND_RE);
      expect(instructions({ searchEnabled })).not.toMatch(BRAND_RE);
    }
  });

  it.each([false, true])('matches the committed tools/list snapshot (search enabled: %s)', async (searchEnabled) => {
    const tools = await listTools(searchEnabled);
    await expect(`${JSON.stringify(tools, null, 2)}\n`).toMatchFileSnapshot(
      `./__snapshots__/tools-list.search-${searchEnabled ? 'on' : 'off'}.json`
    );
  });

  it('covers every tool in the contract', () => {
    expect(Object.keys(describeTools({ searchEnabled: false }))).toEqual([...TOOL_NAMES]);
  });
});
