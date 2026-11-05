import { useState } from 'react';
import { X, AlertCircle, AlertTriangle, AlignLeft, CheckCircle2 } from 'lucide-react';
import type { CompileResult, LogEntry } from '../api';
import { Segmented } from '../ui';

export function LogPanel({ result, onClose, onJump }: { result: CompileResult; onClose: () => void; onJump: (e: LogEntry) => void }) {
  const [tab, setTab] = useState<'issues' | 'raw'>('issues');
  const [showBoxes, setShowBoxes] = useState(false);
  const items = [...result.errors, ...result.warnings, ...(showBoxes ? result.typesetting : [])];
  return (
    <div className="log-drawer">
      <div className="log-head">
        <h4>Protokoll</h4>
        <Segmented
          size="sm"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'issues', label: `Meldungen (${result.errors.length + result.warnings.length})` },
            { value: 'raw', label: 'Rohes Log' },
          ]}
        />
        <button className="icon-btn sm" onClick={onClose} title="Schließen">
          <X size={15} />
        </button>
      </div>
      {tab === 'issues' ? (
        <div className="log-list">
          {result.message && (
            <div className="log-item error">
              <div className="ic">
                <AlertCircle size={13} />
              </div>
              <div>
                <div className="msg">{result.message}</div>
              </div>
            </div>
          )}
          {!items.length && !result.message && (
            <div className="log-ok">
              <CheckCircle2 size={28} style={{ color: 'var(--green)', marginBottom: 8 }} />
              <div>Keine Fehler oder Warnungen.</div>
            </div>
          )}
          {items.map((e, i) => (
            <div key={i} className={`log-item ${e.level}`} onClick={() => onJump(e)}>
              <div className="ic">{e.level === 'error' ? <AlertCircle size={13} /> : e.level === 'warning' ? <AlertTriangle size={13} /> : <AlignLeft size={13} />}</div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="msg">{e.message}</div>
                {(e.file || e.line) && (
                  <div className="loc">
                    {e.file ?? '?'}
                    {e.line ? `:${e.line}` : ''}
                  </div>
                )}
                {e.content && <pre>{e.content}</pre>}
              </div>
            </div>
          ))}
          {result.typesetting.length > 0 && (
            <button className="btn ghost" style={{ margin: '6px 4px', fontSize: 12 }} onClick={() => setShowBoxes(!showBoxes)}>
              {showBoxes ? 'Satzwarnungen ausblenden' : `${result.typesetting.length} Satzwarnungen (Over-/Underfull) anzeigen`}
            </button>
          )}
        </div>
      ) : (
        <pre className="raw-log">{result.log || 'Kein Log vorhanden.'}</pre>
      )}
    </div>
  );
}
