import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../src/contract/tools';
import { VERSION } from '../src/version';

const ROOT = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);
    return statSync(join(ROOT, path)).isDirectory() ? files(path) : [path];
  });
}

const PUBLIC_FILES = [
  'README.md',
  'README.ja.md',
  'AGENTS.md',
  'CHANGELOG.md',
  'justfile',
  'package.json',
  'wrangler.example.jsonc',
  ...files('docs'),
  ...files('skills'),
  ...files('src'),
  ...files('scripts'),
  ...files('.github'),
  ...files('test/fixtures')
];

describe('version', () => {
  it('is the same in src/version.ts, package.json, SKILL.md and the changelog', () => {
    expect(JSON.parse(read('package.json')).version).toBe(VERSION);
    expect(read('skills/x-mcp/SKILL.md')).toMatch(new RegExp(`^version: ${VERSION.replace(/\./g, '\\.')}$`, 'm'));
    expect(read('CHANGELOG.md')).toContain(`## [${VERSION}]`);
  });
});

describe('docs', () => {
  const readmeEnglish = read('README.md');
  const readmeJapanese = read('README.ja.md');
  const prompts = read('docs/agent-install-prompts.md');
  const [promptsJapanese = '', promptsEnglish = ''] = prompts.split('\n## English\n');

  it.each([...TOOL_NAMES])('mention %s in both README languages, the skill and both install prompts', (name) => {
    expect(readmeEnglish).toContain(`\`${name}\``);
    expect(readmeJapanese).toContain(`\`${name}\``);
    expect(read('skills/x-mcp/SKILL.md')).toContain(`\`${name}\``);
    expect(promptsJapanese).toContain(`\`${name}\``);
    expect(promptsEnglish).toContain(`\`${name}\``);
  });

  it('verify the install with a smoke call that works today', () => {
    for (const text of [readmeEnglish, readmeJapanese, promptsJapanese, promptsEnglish, read('skills/x-mcp/SKILL.md')]) {
      expect(text).toContain('https://x.com/jack/status/20');
      expect(text).toContain('just setting up my twttr');
    }
  });

  it('use pnpm and just instead of npm commands', () => {
    for (const path of ['README.md', 'README.ja.md', 'AGENTS.md', 'docs/agent-install-prompts.md', 'skills/x-mcp/SKILL.md']) {
      expect(read(path), path).not.toMatch(/\bnpm (run|install|ci)\b/);
    }
  });
});

describe('public copy', () => {
  it.each(PUBLIC_FILES.map((path) => [relative(ROOT, join(ROOT, path))]))('never names the upstream project in %s', (path) => {
    expect(read(path)).not.toMatch(/fx\s*twitter/i);
  });
});
