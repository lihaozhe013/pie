/**
 * which syntax a tool card's text is shown in.
 *
 * A tool card is mostly code the user has to read: a `write`'s file content, a
 * `read`'s result and an `edit`'s diff lines are the file the call names, a
 * shell's command and output are a shell script. This module answers "which
 * Prism language is that?" from the tool name and the arguments it was called
 * with; `components/ToolCode.tsx` does the rendering.
 *
 * Unknown is a valid answer — an unnamed file, `grep` output, an MCP tool's
 * prose result — and those panes stay plain monospace, as they were. Only the
 * built-in coding tools have an obvious syntax; nothing is guessed from the
 * text itself, because a guess that is wrong is worse than no color.
 *
 * Presentation only; keep language detection in one place.
 */

import { isShellToolName } from './tool-names';

/**
 * Prism language of a file extension. Only names `refractor/all` registers are
 * listed: an unknown id would tokenize nothing and show the text plain anyway.
 */
const EXTENSION_LANGUAGES: Record<string, string> = {
  // Markup and styles.
  html: 'markup',
  htm: 'markup',
  xhtml: 'markup',
  xml: 'markup',
  svg: 'markup',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  // Scripts.
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  pyi: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  cs: 'csharp',
  php: 'php',
  pl: 'perl',
  lua: 'lua',
  r: 'r',
  dart: 'dart',
  scala: 'scala',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  clj: 'clojure',
  cljs: 'clojure',
  groovy: 'groovy',
  gradle: 'groovy',
  // Data and config.
  json: 'json',
  jsonl: 'json',
  jsonc: 'json',
  json5: 'json5',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  env: 'bash',
  lock: 'json',
  // Shells and builds.
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  ksh: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  bat: 'batch',
  cmd: 'batch',
  mk: 'makefile',
  make: 'makefile',
  cmake: 'cmake',
  dockerfile: 'docker',
  tf: 'hcl',
  hcl: 'hcl',
  // Documents and data formats.
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'protobuf',
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  diff: 'diff',
  patch: 'diff',
  gitignore: 'git',
  gitattributes: 'git'
};

/** Files whose whole name, not their extension, picks the syntax. */
const FILE_NAME_LANGUAGES: Record<string, string> = {
  dockerfile: 'docker',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  'cmakelists.txt': 'cmake',
  '.bashrc': 'bash',
  '.bash_profile': 'bash',
  '.zshrc': 'bash',
  '.profile': 'bash',
  '.env': 'bash',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitconfig': 'ini',
  '.editorconfig': 'ini'
};

/** Argument names under which a coding tool names the file it works on. */
const PATH_KEYS = [
  'path',
  'file_path',
  'filePath',
  'filepath',
  'absolute_path',
  'target_file',
  'notebook_path',
  'filename',
  'fileName'
];

/** The Prism language of a file path (`src/app.tsx` → `tsx`), if it has one. */
export function toolPathLanguage(filePath: unknown): string | undefined {
  if (typeof filePath !== 'string') return undefined;
  const name = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (!name) return undefined;
  const byName = FILE_NAME_LANGUAGES[name];
  if (byName) return byName;
  const dot = name.lastIndexOf('.');
  if (dot === -1) return undefined;
  return EXTENSION_LANGUAGES[name.slice(dot + 1)];
}

/** The file a coding tool's arguments name, if they name one. */
export function toolPath(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  // `edit` calls carry their replacements, not the file; a single-replacement
  // call (`oldText`/`newText`) names the file with `file`.
  if (typeof record.file === 'string' && record.file !== '') return record.file;
  return undefined;
}

/** The shell a shell tool runs its command in. */
export function shellToolLanguage(toolName: string): string {
  if (/powershell|pwsh/i.test(toolName)) return 'powershell';
  if (/(^|[._-])(cmd|bat|batch)([._-]|$)/i.test(toolName)) return 'batch';
  return 'bash';
}

/**
 * The syntax of everything a tool card shows: a shell tool's command and
 * output, or the file a coding tool reads, writes or edits.
 */
export function toolCodeLanguage(toolName: string, input: unknown): string | undefined {
  if (isShellToolName(toolName)) return shellToolLanguage(toolName);
  return toolPathLanguage(toolPath(input));
}
