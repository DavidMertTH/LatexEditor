import { autocompletion, snippet, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';
import { COMMANDS, ENVIRONMENTS, PACKAGES, type CmdKind } from './data';
import type { ProjectIndex } from '../api';

export type IndexGetter = () => { index: ProjectIndex | null; currentFile: string };

const CLASSES = ['article', 'report', 'book', 'beamer', 'letter', 'scrartcl', 'scrreprt', 'scrbook', 'scrlttr2', 'memoir', 'standalone', 'amsart', 'revtex4-2', 'moderncv'];
const IMAGE_EXT = /\.(png|jpe?g|pdf|eps|svg|gif)$/i;

/** Escape literal braces so CodeMirror's snippet parser keeps them (it treats \{ as an escape). */
const esc = (s: string) => s.replace(/\\([{}])/g, '\\\\$1');

function kindType(kind?: CmdKind) {
  switch (kind) {
    case 'math':
      return 'math';
    case 'symbol':
      return 'symbol';
    case 'struct':
      return 'struct';
    case 'ref':
      return 'refcmd';
    default:
      return 'cmd';
  }
}

function applySnippet(template: string) {
  // final tab stop after the last argument so Tab leaves the command
  const tpl = /\$\{[^}]*\}/.test(template) && !template.includes('${}') ? template + '${}' : template;
  return snippet(esc(tpl));
}

const commandOptions: Completion[] = (() => {
  const seen = new Map<string, number>();
  const out: Completion[] = [];
  for (const [name, args, detail, kind] of COMMANDS) {
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    out.push({
      label: '\\' + name,
      displayLabel: '\\' + name + (args ? args.replace(/\$\{([^}]*)\}/g, '$1').replace(/\n[\s\S]*/, '…') : ''),
      detail,
      type: kindType(kind),
      apply: args ? applySnippet('\\' + name + args) : '\\' + name,
      boost: n ? -1 : 0,
    });
  }
  for (const [name, body, detail] of ENVIRONMENTS) {
    out.push({
      label: `\\begin{${name}}`,
      detail,
      type: 'env',
      apply: applySnippet(`\\begin{${name}}${body}\\end{${name}}`),
      boost: -2,
    });
  }
  return out;
})();

function envOptions(index: ProjectIndex | null, closeBrace: boolean): Completion[] {
  const names = new Map<string, [string, string]>();
  for (const [name, body, detail] of ENVIRONMENTS) names.set(name, [body, detail]);
  for (const e of index?.environments ?? []) if (!names.has(e.name)) names.set(e.name, ['\n\t${}\n', 'Eigene Umgebung']);
  return [...names.entries()].map(([name, [body, detail]]) => ({
    label: name,
    detail,
    type: 'env',
    apply: (view: EditorView, completion: Completion, from: number, to: number) => {
      let end = to;
      if (closeBrace && view.state.sliceDoc(end, end + 1) === '}') end++;
      // CodeMirror indents continuation lines to match the \begin line itself
      const tpl = `${name}}${body}\\end{${name}}`;
      snippet(esc(tpl))(view, completion, from, end);
    },
  }));
}

function openEnvironments(text: string): string[] {
  const stack: string[] = [];
  for (const m of text.matchAll(/\\(begin|end)\{([^}]+)\}/g)) {
    if (m[1] === 'begin') stack.push(m[2]);
    else {
      const i = stack.lastIndexOf(m[2]);
      if (i >= 0) stack.splice(i, 1);
    }
  }
  return stack;
}

export function latexCompletion(get: IndexGetter) {
  const source = (ctx: CompletionContext): CompletionResult | null => {
    const { index, currentFile } = get();
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(Math.max(0, ctx.pos - line.from - 300), ctx.pos - line.from);
    const after = ctx.state.sliceDoc(ctx.pos, ctx.pos + 1);
    let m: RegExpMatchArray | null;

    // \begin{…
    if ((m = before.match(/\\begin\{([^}]*)$/))) {
      return { from: ctx.pos - m[1].length, options: envOptions(index, after === '}'), validFor: /^[\w*]*$/ };
    }
    // \end{…
    if ((m = before.match(/\\end\{([^}]*)$/))) {
      const open = openEnvironments(ctx.state.sliceDoc(Math.max(0, ctx.pos - 20000), ctx.pos - m[0].length));
      const options = open.reverse().map((name, i) => ({ label: name, type: 'env', boost: 10 - i, apply: after === '}' ? name : name + '}' }));
      return { from: ctx.pos - m[1].length, options, validFor: /^[\w*]*$/ };
    }
    // references
    if ((m = before.match(/\\(?:ref|eqref|pageref|autoref|[cC]ref|nameref|vref|labelcref)\{(?:[^}]*,)?([^},]*)$/))) {
      const options = (index?.labels ?? []).map((l) => ({
        label: l.label,
        detail: l.context || `${l.file}:${l.line}`,
        info: `${l.file}, Zeile ${l.line}`,
        type: 'label',
        boost: l.file === currentFile ? 1 : 0,
      }));
      return { from: ctx.pos - m[1].length, options, validFor: /^[^},]*$/ };
    }
    // citations
    if ((m = before.match(/\\(?:[a-zA-Z]*cite[a-zA-Z]*|nocite)\*?(?:\[[^\]]*\])*\{(?:[^}]*,)?\s*([^},]*)$/))) {
      const options = (index?.bib ?? []).map((b) => ({
        label: b.key,
        detail: [b.author.split(' and ')[0], b.year].filter(Boolean).join(', '),
        info: b.title,
        type: 'cite',
      }));
      return { from: ctx.pos - m[1].length, options, validFor: /^[^},]*$/ };
    }
    // files
    if ((m = before.match(/\\(input|include|subfile)\{([^}]*)$/))) {
      const options = (index?.files ?? [])
        .filter((f) => f.endsWith('.tex') && f !== currentFile)
        .map((f) => ({ label: f.replace(/\.tex$/, ''), type: 'file' }));
      return { from: ctx.pos - m[2].length, options, validFor: /^[^}]*$/ };
    }
    if ((m = before.match(/\\includegraphics(?:\[[^\]]*\])?\{([^}]*)$/))) {
      const options = (index?.files ?? []).filter((f) => IMAGE_EXT.test(f)).map((f) => ({ label: f, type: 'image' }));
      return { from: ctx.pos - m[1].length, options, validFor: /^[^}]*$/ };
    }
    if ((m = before.match(/\\(bibliography|addbibresource)\{([^}]*)$/))) {
      const keepExt = m[1] === 'addbibresource';
      const options = (index?.files ?? []).filter((f) => f.endsWith('.bib')).map((f) => ({ label: keepExt ? f : f.replace(/\.bib$/, ''), type: 'file' }));
      return { from: ctx.pos - m[2].length, options, validFor: /^[^}]*$/ };
    }
    if ((m = before.match(/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{(?:[^}]*,)?\s*([^},]*)$/))) {
      const options = PACKAGES.map(([p, d]) => ({ label: p, detail: d, type: 'package' }));
      return { from: ctx.pos - m[1].length, options, validFor: /^[\w-]*$/ };
    }
    if ((m = before.match(/\\documentclass(?:\[[^\]]*\])?\{([^}]*)$/))) {
      return { from: ctx.pos - m[1].length, options: CLASSES.map((c) => ({ label: c, type: 'package' })), validFor: /^[\w-]*$/ };
    }

    // commands
    const word = ctx.matchBefore(/\\[A-Za-z@]*\*?/);
    if (!word) return null;
    if (word.from === word.to && !ctx.explicit) return null;
    // ignore escaped backslash (\\)
    if (word.from > 0 && ctx.state.sliceDoc(word.from - 1, word.from) === '\\') return null;

    const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
    const inMath = /math/i.test(node.name) || /math/i.test(node.parent?.name ?? '');
    const options: Completion[] = commandOptions.map((o) => {
      if (inMath && (o.type === 'math' || o.type === 'symbol')) return { ...o, boost: (o.boost ?? 0) + 3 };
      return o;
    });
    const known = new Set(COMMANDS.map((c) => c[0]));
    for (const c of index?.commands ?? []) {
      if (known.has(c.name)) continue;
      known.add(c.name);
      const args = Array.from({ length: c.args }, (_, i) => `{\${${i + 1}}}`).join('');
      options.push({
        label: '\\' + c.name,
        detail: 'Eigener Befehl',
        type: 'user',
        apply: c.args ? applySnippet('\\' + c.name + args) : '\\' + c.name,
        boost: 1,
      });
    }
    return { from: word.from, options, validFor: /^\\[A-Za-z@]*\*?$/ };
  };

  return autocompletion({
    override: [source],
    activateOnTyping: true,
    icons: true,
    maxRenderedOptions: 80,
    closeOnBlur: true,
    optionClass: () => 'latex-option',
  });
}
