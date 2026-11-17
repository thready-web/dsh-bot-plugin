/** Monaco language id for a file name. Unknown names stay plaintext. */
export function monacoLanguage(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const languages: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    md: 'markdown',
    markdown: 'markdown',
    py: 'python',
    rs: 'rust',
    go: 'go',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    xml: 'xml',
    svg: 'xml',
    sql: 'sql',
    java: 'java',
    c: 'c',
    h: 'c',
    cc: 'cpp',
    cpp: 'cpp',
    rb: 'ruby',
    ini: 'ini',
    env: 'ini',
    gitignore: 'ini',
    lock: 'ini',
  }
  return languages[ext] ?? 'plaintext'
}

export function isMarkdownName(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return ext === 'md' || ext === 'markdown'
}
