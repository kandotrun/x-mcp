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

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens. */
function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>();
  for (const [, heading = ''] of markdown.matchAll(/^#{1,6} (.+)$/gm)) {
    anchors.add(heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-'));
  }
  return anchors;
}

describe('links', () => {
  it('point at headings that exist in README.md and README.ja.md', () => {
    const targets: Record<string, Set<string>> = { 'README.md': anchorsOf(read('README.md')), 'README.ja.md': anchorsOf(read('README.ja.md')) };
    const sources = ['README.md', 'README.ja.md', 'docs/agent-install-prompts.md', 'skills/x-mcp/SKILL.md'];
    const pattern = /(?:github\.com\/kandotrun\/x-mcp(?:\/blob\/main\/(README(?:\.ja)?\.md))?|\((README(?:\.ja)?\.md)?)#([^\s)]+)/g;
    let checked = 0;
    for (const source of sources) {
      for (const match of read(source).matchAll(pattern)) {
        const file = match[1] ?? match[2] ?? (match[0].startsWith('(') ? source : 'README.md');
        const anchor = decodeURIComponent(match[3] ?? '').replace(/[.,;:]+$/, '');
        expect(targets[file]?.has(anchor), `${source}: ${file}#${anchor}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});

describe('public copy', () => {
  it.each(PUBLIC_FILES.map((path) => [relative(ROOT, join(ROOT, path))]))('never names the upstream project in %s', (path) => {
    expect(read(path)).not.toMatch(/fx\s*twitter/i);
  });
});
