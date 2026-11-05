import { useEffect, useState } from 'react';
import { DialogProvider, useTheme } from './ui';
import { ProjectBrowser } from './components/ProjectBrowser';
import { Workspace } from './components/Workspace';

function currentRoute() {
  const m = /^#\/p\/([^/?]+)/.exec(location.hash);
  return m ? m[1] : null;
}

export function App() {
  const [projectId, setProjectId] = useState<string | null>(currentRoute);
  const [theme, setTheme] = useTheme();

  useEffect(() => {
    const onHash = () => setProjectId(currentRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const open = (id: string | null) => {
    location.hash = id ? `#/p/${id}` : '#/';
  };

  return (
    <DialogProvider>
      {projectId ? (
        <Workspace key={projectId} projectId={projectId} onClose={() => open(null)} theme={theme} setTheme={setTheme} />
      ) : (
        <ProjectBrowser onOpen={(id) => open(id)} theme={theme} setTheme={setTheme} />
      )}
    </DialogProvider>
  );
}
