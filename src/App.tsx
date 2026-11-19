import LiveWorkbench from './LiveWorkbench';
import { useTenantInventory } from './useTenantInventory';

export default function App() {
  const tenant = useTenantInventory();
  return <LiveWorkbench key={tenant.identity} tenant={tenant} />;
}
