import { DashboardView } from './windows/dashboard/DashboardView';
import { TrayView } from './windows/tray/TrayView';

export function App() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view');

  if (view === 'tray') {
    return <TrayView />;
  }
  return <DashboardView />;
}

export default App;
