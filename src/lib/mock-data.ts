export type TxStatus = "Confirmed" | "Pending" | "Failed" | "Needs Review" | "Waiting Sign";
export type TxCategory = "Payroll" | "Vendor Payment" | "Invoice" | "Bridge" | "Swap" | "Business Expense" | "Refund" | "Personal";

export type Tx = {
  id: string;
  date: string;
  hash: string;
  amount: number;
  token: "USDC" | "USDT" | "PYUSD" | "DAI";
  category: TxCategory;
  counterparty: string;
  note: string;
  status: TxStatus;
  type: "Sent" | "Received";
};

export const transactions: Tx[] = [
  { id: "1", date: "Oct 14", hash: "0x4f2a...9a12", amount: 8500, token: "USDC", category: "Payroll", counterparty: "Sarah Jenkins", note: "October payroll - engineering", status: "Confirmed", type: "Sent" },
  { id: "2", date: "Oct 13", hash: "0x91bd...c204", amount: 4200, token: "USDC", category: "Vendor Payment", counterparty: "Aether Studio", note: "Q4 brand identity", status: "Confirmed", type: "Sent" },
  { id: "3", date: "Oct 13", hash: "0x77ae...4490", amount: 25000, token: "USDT", category: "Bridge", counterparty: "Across Protocol", note: "L1 → Arbitrum liquidity", status: "Confirmed", type: "Sent" },
  { id: "4", date: "Oct 12", hash: "0x2c08...18df", amount: 1250, token: "USDC", category: "Business Expense", counterparty: "AWS", note: "Infra - October", status: "Pending", type: "Sent" },
  { id: "5", date: "Oct 11", hash: "0xd341...9f02", amount: 12500, token: "PYUSD", category: "Invoice", counterparty: "Mercury Labs", note: "Invoice INV-204 paid", status: "Confirmed", type: "Received" },
  { id: "6", date: "Oct 10", hash: "0x88c2...77a1", amount: 640, token: "USDC", category: "Swap", counterparty: "Uniswap v4", note: "USDC → DAI rebalance", status: "Confirmed", type: "Sent" },
  { id: "7", date: "Oct 09", hash: "0xa9f0...02bc", amount: 320, token: "USDC", category: "Personal", counterparty: "0x9a12...77", note: " - ", status: "Needs Review", type: "Sent" },
  { id: "8", date: "Oct 08", hash: "0x5b71...e1c4", amount: 6800, token: "USDC", category: "Payroll", counterparty: "Marcus Lin", note: "September contractor", status: "Confirmed", type: "Sent" },
  { id: "9", date: "Oct 07", hash: "0x14de...88a0", amount: 950, token: "USDC", category: "Vendor Payment", counterparty: "Figma", note: "Annual seats", status: "Failed", type: "Sent" },
];

export const kpis = {
  totalSent: 84200,
  totalReceived: 142500,
  pendingIntents: 12,
  confirmedRecords: 412,
  needsReview: 3,
};

export const monthly = [
  { m: "Apr", sent: 32000, received: 18000 },
  { m: "May", sent: 41000, received: 22000 },
  { m: "Jun", sent: 38000, received: 31000 },
  { m: "Jul", sent: 52000, received: 28000 },
  { m: "Aug", sent: 64000, received: 47000 },
  { m: "Sep", sent: 71000, received: 58000 },
  { m: "Oct", sent: 84200, received: 142500 },
];

export type Invoice = {
  id: string;
  number: string;
  client: string;
  amount: number;
  token: "USDC" | "PYUSD";
  due: string;
  status: "Draft" | "Sent" | "Paid" | "Cancelled";
};

export const invoices: Invoice[] = [
  { id: "i1", number: "INV-204", client: "Mercury Labs", amount: 12500, token: "PYUSD", due: "Oct 11", status: "Paid" },
  { id: "i2", number: "INV-205", client: "Northwind DAO", amount: 8400, token: "USDC", due: "Oct 22", status: "Sent" },
  { id: "i3", number: "INV-206", client: "Helios Studio", amount: 3200, token: "USDC", due: "Oct 28", status: "Draft" },
  { id: "i4", number: "INV-203", client: "Quanta Capital", amount: 15750, token: "USDC", due: "Sep 30", status: "Paid" },
  { id: "i5", number: "INV-202", client: "Atlas Bridge", amount: 2100, token: "USDC", due: "Sep 18", status: "Cancelled" },
];

export type PayoutRow = { id: string; name: string; address: string; amount: number; status: "Queued" | "Signed" | "Confirmed" };
export const payoutBatch = {
  name: "October Payroll - Engineering",
  total: 42500,
  rows: [
    { id: "p1", name: "Sarah Jenkins", address: "0x4f2a...9a12", amount: 8500, status: "Confirmed" as const },
    { id: "p2", name: "Marcus Lin", address: "0x5b71...e1c4", amount: 6800, status: "Confirmed" as const },
    { id: "p3", name: "Aiko Tanaka", address: "0x91bd...c204", amount: 7200, status: "Signed" as const },
    { id: "p4", name: "Devon Park", address: "0x77ae...4490", amount: 6500, status: "Queued" as const },
    { id: "p5", name: "Priya Rao", address: "0xd341...9f02", amount: 7100, status: "Queued" as const },
    { id: "p6", name: "Leo Vargas", address: "0x2c08...18df", amount: 6400, status: "Queued" as const },
  ],
};

// ============================
// AI Agents
// ============================

export type AgentStatus = "Active" | "Paused" | "Connecting";
export type AgentConnection = "Agent API" | "MCP Server" | "Sandbox";

export type Agent = {
  id: string;
  agentId: string; // public agent ID exposed to API/MCP
  name: string;
  persona: string;
  wallet: string;
  status: AgentStatus;
  connection: AgentConnection;
  monthlySpend: number;
  monthlyLimit: number;
  lastActivity: string;
  pendingIntents: number;
  confirmed30d: number;
  failed30d: number;
};

export type AgentTxStatus = "Confirmed" | "Pending" | "Failed" | "Awaiting Sign";

export type AgentSpend = {
  id: string;
  agentId: string;
  taskId: string;
  tool: string;
  reason: string;
  recipient: string;
  amount: number;
  token: "USDC" | "USDT" | "PYUSD" | "DAI";
  status: AgentTxStatus;
  txHash: string;
  timestamp: string;
  category: TxCategory | "API Usage" | "Compute" | "Data" | "Subscription";
  note: string;
};

export const agents: Agent[] = [
  {
    id: "a1",
    agentId: "agt_orion_4f9a",
    name: "Orion",
    persona: "Procurement & vendor renewals",
    wallet: "0x4f2a…9a12",
    status: "Active",
    connection: "MCP Server",
    monthlySpend: 4820,
    monthlyLimit: 8000,
    lastActivity: "2 min ago",
    pendingIntents: 2,
    confirmed30d: 31,
    failed30d: 1,
  },
  {
    id: "a2",
    agentId: "agt_atlas_91bd",
    name: "Atlas",
    persona: "Research · data & API spend",
    wallet: "0x91bd…c204",
    status: "Active",
    connection: "Agent API",
    monthlySpend: 1265,
    monthlyLimit: 3000,
    lastActivity: "14 min ago",
    pendingIntents: 0,
    confirmed30d: 88,
    failed30d: 3,
  },
  {
    id: "a3",
    agentId: "agt_juno_77ae",
    name: "Juno",
    persona: "Customer refunds & micropay",
    wallet: "0x77ae…4490",
    status: "Paused",
    connection: "Agent API",
    monthlySpend: 412,
    monthlyLimit: 1500,
    lastActivity: "1 day ago",
    pendingIntents: 0,
    confirmed30d: 22,
    failed30d: 0,
  },
  {
    id: "a4",
    agentId: "agt_nova_2c08",
    name: "Nova",
    persona: "Treasury rebalancing",
    wallet: "0x2c08…18df",
    status: "Connecting",
    connection: "Sandbox",
    monthlySpend: 0,
    monthlyLimit: 25000,
    lastActivity: "—",
    pendingIntents: 1,
    confirmed30d: 0,
    failed30d: 0,
  },
];

export const agentSpends: AgentSpend[] = [
  // Orion
  { id: "s1", agentId: "a1", taskId: "tsk_8821", tool: "Stripe API", reason: "Renew team seats · annual", recipient: "Stripe Inc", amount: 2400, token: "USDC", status: "Confirmed", txHash: "0x4f2a…9a12", timestamp: "Today · 14:02", category: "Subscription", note: "Pre-approved renewal · contract OK" },
  { id: "s2", agentId: "a1", taskId: "tsk_8822", tool: "AWS Billing", reason: "Top up compute credits", recipient: "AWS · 942-acct", amount: 1500, token: "USDC", status: "Confirmed", txHash: "0x91bd…c204", timestamp: "Today · 11:48", category: "Compute", note: "Monthly cap not breached" },
  { id: "s3", agentId: "a1", taskId: "tsk_8830", tool: "Figma API", reason: "Add 4 editor seats", recipient: "Figma", amount: 240, token: "USDC", status: "Pending", txHash: "—", timestamp: "Today · 09:11", category: "Subscription", note: "Awaiting human cosign · $240 < cap" },
  { id: "s4", agentId: "a1", taskId: "tsk_8819", tool: "Vendor Direct", reason: "Aether Studio · Q4 retainer", recipient: "Aether Studio", amount: 680, token: "USDC", status: "Awaiting Sign", txHash: "—", timestamp: "Yesterday · 18:30", category: "Vendor Payment", note: "Above $500 → needs sign" },
  { id: "s5", agentId: "a1", taskId: "tsk_8801", tool: "Twilio API", reason: "Refill SMS balance", recipient: "Twilio", amount: 200, token: "USDC", status: "Failed", txHash: "0xa9f0…02bc", timestamp: "Oct 12 · 06:20", category: "API Usage", note: "Insufficient gas · retried by Orion" },
  // Atlas
  { id: "s6", agentId: "a2", taskId: "tsk_5512", tool: "OpenAI API", reason: "GPT batch transcription", recipient: "OpenAI", amount: 84, token: "USDC", status: "Confirmed", txHash: "0xd341…9f02", timestamp: "Today · 13:18", category: "API Usage", note: "Daily research run" },
  { id: "s7", agentId: "a2", taskId: "tsk_5513", tool: "Perplexity", reason: "Pro search · market report", recipient: "Perplexity", amount: 20, token: "USDC", status: "Confirmed", txHash: "0x14de…88a0", timestamp: "Today · 12:55", category: "Data", note: "Per-task budget $25" },
  { id: "s8", agentId: "a2", taskId: "tsk_5510", tool: "Dune API", reason: "Onchain dataset · 12mo", recipient: "Dune", amount: 320, token: "USDC", status: "Confirmed", txHash: "0x77ae…4490", timestamp: "Yesterday · 21:04", category: "Data", note: "—" },
  { id: "s9", agentId: "a2", taskId: "tsk_5499", tool: "Replicate", reason: "Image gen · 1.2k calls", recipient: "Replicate", amount: 41, token: "USDC", status: "Failed", txHash: "—", timestamp: "Oct 13 · 02:11", category: "Compute", note: "Recipient changed · auto-blocked" },
  // Juno
  { id: "s10", agentId: "a3", taskId: "tsk_3301", tool: "Refund Bot", reason: "Order #A-9921 refund", recipient: "0x9a12…77f0", amount: 38, token: "USDC", status: "Confirmed", txHash: "0x5b71…e1c4", timestamp: "Oct 11 · 16:40", category: "Refund", note: "Auto-issued · proof attached" },
  { id: "s11", agentId: "a3", taskId: "tsk_3299", tool: "Refund Bot", reason: "Order #A-9914 refund", recipient: "0x88c2…77a1", amount: 64, token: "USDC", status: "Confirmed", txHash: "0x88c2…77a1", timestamp: "Oct 10 · 09:02", category: "Refund", note: "—" },
  // Nova
  { id: "s12", agentId: "a4", taskId: "tsk_0001", tool: "Across", reason: "Test bridge · 50 USDC", recipient: "Across Protocol", amount: 50, token: "USDC", status: "Pending", txHash: "—", timestamp: "Today · 15:21", category: "Bridge", note: "Sandbox · no real funds" },
];

export const agentMonthly = [
  { m: "May", spend: 1800 },
  { m: "Jun", spend: 2200 },
  { m: "Jul", spend: 3100 },
  { m: "Aug", spend: 3900 },
  { m: "Sep", spend: 5600 },
  { m: "Oct", spend: 6497 },
];
