import { useEffect, useRef, useState } from 'react'
import Editor, { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import 'monaco-editor/esm/vs/basic-languages/monaco.contribution'
import 'monaco-editor/esm/vs/language/css/monaco.contribution'
import 'monaco-editor/esm/vs/language/html/monaco.contribution'
import 'monaco-editor/esm/vs/language/json/monaco.contribution'
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution'
import 'monaco-editor/min/vs/editor/editor.main.css'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { monacoLanguage } from './highlight'
import { useI18n } from './locale'

self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  },
}

loader.config({ monaco })

/** Read-only source view. Options follow the weterm file preview. */
export default function SourceEditor({ text, name, line }: { text: string; name: string; line?: number }) {
  const { t } = useI18n()
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const editor = editorRef.current
    if (!ready || !editor || line == null) return
    const model = editor.getModel()
    const count = model?.getLineCount() ?? 0
    if (count > 0) editor.revealLineInCenter(Math.min(line, count))
    if (!model || line < 1 || line > count) return
    const decorations = editor.createDecorationsCollection([
      {
        range: new monaco.Range(line, 1, line, 1),
        options: { isWholeLine: true, className: 'files-current-line' },
      },
    ])
    return () => decorations.clear()
  }, [line, text, ready])
  return (
    <div className="files-monaco">
      <Editor
        height="100%"
        language={monacoLanguage(name)}
        theme="vs-dark"
        value={text}
        loading={<p className="files-status">{t('file.loading')}</p>}
        onMount={editor => {
          editorRef.current = editor
          setReady(true)
        }}
        options={{
          readOnly: true,
          domReadOnly: true,
          fontSize: 13,
          fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Courier, monospace',
          minimap: { enabled: true },
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          automaticLayout: true,
          padding: { top: 12, bottom: 12 },
          lineNumbers: 'on',
          cursorBlinking: 'smooth',
          renderWhitespace: 'none',
          scrollbar: {
            vertical: 'visible',
            horizontal: 'auto',
            verticalScrollbarSize: 10,
            horizontalScrollbarSize: 10,
          },
        }}
      />
    </div>
  )
}
