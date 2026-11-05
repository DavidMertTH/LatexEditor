import { useState } from 'react';
import { Bold, Italic, Underline, Code, List, ListOrdered, Sigma, SquareFunction, Link, Quote, Hash, Image, Table, MessageSquareOff, ChevronDown, Search, Type, PenLine } from 'lucide-react';
import type { EditorController, EditorMode } from '../editor/controller';
import { HEADING_LEVELS, insertList, insertSnippet, setHeading, toggleCommand, toggleLineComment } from '../editor/format';
import { openSearchPanel } from '@codemirror/search';
import { startCompletion } from '@codemirror/autocomplete';
import { Menu, Popover, Segmented, modKey } from '../ui';

export function FormatBar({ controller, heading, mode, setMode, isTex }: { controller: EditorController | null; heading: string; mode: EditorMode; setMode: (m: EditorMode) => void; isTex: boolean }) {
  const [headMenu, setHeadMenu] = useState<HTMLElement | null>(null);
  const v = controller?.view;
  const run = (fn: () => void) => () => v && fn();
  const headingLabel = HEADING_LEVELS.find((h) => h.id === heading)?.label ?? 'Fließtext';

  const insertAndComplete = (tpl: string) => {
    if (!v) return;
    insertSnippet(v, tpl);
    setTimeout(() => startCompletion(v), 30);
  };

  return (
    <div className="formatbar">
      <div className="fb-tools">
      {isTex && (
        <>
          <button className="heading-select" onClick={(e) => setHeadMenu(e.currentTarget)} title="Absatzformat">
            <span>{headingLabel}</span>
            <ChevronDown size={13} style={{ color: 'var(--dim)' }} />
          </button>
          {headMenu && (
            <Popover anchor={headMenu} onClose={() => setHeadMenu(null)}>
              <Menu
                onClose={() => setHeadMenu(null)}
                items={HEADING_LEVELS.map((h) => ({ label: h.label, onClick: () => v && setHeading(v, h.id) }))}
              />
            </Popover>
          )}
          <div className="sep" />
          <button className="icon-btn" title={`Fett (${modKey}B)`} onClick={run(() => toggleCommand(v!, 'textbf'))}>
            <Bold size={15} />
          </button>
          <button className="icon-btn" title={`Kursiv (${modKey}I)`} onClick={run(() => toggleCommand(v!, 'textit'))}>
            <Italic size={15} />
          </button>
          <button className="icon-btn" title={`Unterstrichen (${modKey}U)`} onClick={run(() => toggleCommand(v!, 'underline'))}>
            <Underline size={15} />
          </button>
          <button className="icon-btn" title="Schreibmaschine" onClick={run(() => toggleCommand(v!, 'texttt'))}>
            <Code size={15} />
          </button>
          <div className="sep" />
          <button className="icon-btn" title="Aufzählung" onClick={run(() => insertList(v!, 'itemize'))}>
            <List size={16} />
          </button>
          <button className="icon-btn" title="Nummerierte Liste" onClick={run(() => insertList(v!, 'enumerate'))}>
            <ListOrdered size={16} />
          </button>
          <div className="sep" />
          <button className="icon-btn" title="Formel im Text ($…$)" onClick={run(() => insertSnippet(v!, '$${sel}$'))}>
            <Sigma size={15} />
          </button>
          <button className="icon-btn" title="Abgesetzte Formel" onClick={run(() => insertSnippet(v!, '\n\\begin{equation}\n\t${sel}\n\\end{equation}\n'))}>
            <SquareFunction size={15} />
          </button>
          <div className="sep" />
          <button className="icon-btn" title="Link" onClick={run(() => insertSnippet(v!, '\\href{${https://}}{${sel}}'))}>
            <Link size={15} />
          </button>
          <button className="icon-btn" title="Verweis (\ref)" onClick={() => insertAndComplete('\\ref{${}}')}>
            <Hash size={15} />
          </button>
          <button className="icon-btn" title="Zitat (\cite)" onClick={() => insertAndComplete('\\cite{${}}')}>
            <Quote size={15} />
          </button>
          <button
            className="icon-btn"
            title="Abbildung"
            onClick={run(() =>
              insertSnippet(v!, '\n\\begin{figure}[h]\n\t\\centering\n\t\\includegraphics[width=0.8\\linewidth]{${datei}}\n\t\\caption{${Beschriftung}}\n\t\\label{fig:${label}}\n\\end{figure}\n'),
            )}
          >
            <Image size={15} />
          </button>
          <button
            className="icon-btn"
            title="Tabelle"
            onClick={run(() =>
              insertSnippet(
                v!,
                '\n\\begin{table}[h]\n\t\\centering\n\t\\begin{tabular}{lcc}\n\t\t\\hline\n\t\t${A} & B & C \\\\\n\t\t\\hline\n\t\t1 & 2 & 3 \\\\\n\t\t4 & 5 & 6 \\\\\n\t\t\\hline\n\t\\end{tabular}\n\t\\caption{${Beschriftung}}\n\t\\label{tab:${label}}\n\\end{table}\n',
              ),
            )}
          >
            <Table size={15} />
          </button>
          <div className="sep" />
          <button className="icon-btn" title={`Auskommentieren (${modKey}/)`} onClick={run(() => toggleLineComment(v!))}>
            <MessageSquareOff size={15} />
          </button>
        </>
      )}
      <button className="icon-btn" title={`Suchen & Ersetzen (${modKey}F)`} onClick={run(() => openSearchPanel(v!))}>
        <Search size={15} />
      </button>
      </div>
      {isTex && (
        <Segmented
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'source', label: 'Quelltext', icon: <Type size={12} /> },
            { value: 'visual', label: 'Visuell', icon: <PenLine size={12} /> },
          ]}
        />
      )}
    </div>
  );
}
