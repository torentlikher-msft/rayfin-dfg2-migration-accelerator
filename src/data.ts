import type { Dataflow, Workspace } from './domain';

const flow = (id: string, name: string, source: string, entities: number,
  compatibility: Dataflow['compatibility'] = 'Ready', issues: string[] = []): Dataflow =>
  ({ id, name, source, entities, compatibility, issues, modified: '2026-11-16T14:30:00Z' });

export const workspaces: Workspace[] = [
  { id: 'ws-sales-prod', name: 'Sales Analytics', domain: 'Sales & marketing', pipeline: 'Sales analytics', stage: 'Production', capacity: 'Fabric capacity', flows: [
    flow('sales-orders', 'Sales orders', 'SQL Server', 8),
    flow('customer-360', 'Customer 360', 'Salesforce', 5),
    flow('revenue-forecast', 'Revenue forecast', 'Azure SQL', 4, 'Needs review', ['Incremental refresh settings must be recreated before the first refresh.']),
    flow('territory-mapping', 'Territory mapping', 'SharePoint', 3),
    flow('legacy-sales', 'Legacy sales archive', 'ADLS Gen2', 6, 'Blocked', ['Customer-managed ADLS storage requires remediation before save-as.']),
  ] },
  { id: 'ws-finance-prod', name: 'Finance & Operations', domain: 'Finance', pipeline: 'Finance platform', stage: 'Production', capacity: 'Fabric capacity', flows: [
    flow('general-ledger', 'General ledger', 'Dynamics 365', 12),
    flow('cost-centers', 'Cost centers', 'Excel', 3),
    flow('budget-actuals', 'Budget vs. actuals', 'Azure SQL', 7, 'Needs review', ['A downstream semantic model references this Gen1 ID. Rebind it to the new Gen2 ID.']),
    flow('vendor-master', 'Vendor master', 'SAP HANA', 4),
  ] },
  { id: 'ws-customer-test', name: 'Customer Insights', domain: 'Customer experience', pipeline: 'Customer intelligence', stage: 'Test', capacity: 'Fabric capacity', flows: [
    flow('customer-profiles', 'Customer profiles', 'Dataverse', 6),
    flow('campaign-performance', 'Campaign performance', 'Salesforce', 4),
    flow('support-interactions', 'Support interactions', 'Azure SQL', 5, 'Needs review', ['External orchestration must be updated to use the new dataflow ID.']),
    flow('customer-segments', 'Customer segments', 'Power BI dataflows', 3, 'Needs review', ['Linked entities reference another Gen1 dataflow. Migrate upstream sources first.']),
  ] },
  { id: 'ws-supply-dev', name: 'Supply Chain', domain: 'Operations', pipeline: 'Supply chain analytics', stage: 'Development', capacity: 'Fabric capacity', flows: [
    flow('inventory-levels', 'Inventory levels', 'SQL Server', 8),
    flow('purchase-orders', 'Purchase orders', 'Dynamics 365', 6),
    flow('supplier-performance', 'Supplier performance', 'SharePoint', 4),
    flow('warehouse-direct', 'Warehouse live data', 'DirectQuery', 2, 'Blocked', ['DirectQuery dataflows are not supported by this save-as migration path.']),
  ] },
  { id: 'ws-people', name: 'People & Culture', domain: 'Human resources', pipeline: 'Not assigned', stage: 'Unassigned', capacity: 'Fabric capacity', flows: [
    flow('headcount', 'Headcount overview', 'Excel', 3),
    flow('employee-directory', 'Employee directory', 'Dataverse', 2),
    flow('learning', 'Learning & development', 'SharePoint', 4),
  ] },
];
