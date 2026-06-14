const express = require('express');
const axios   = require('axios');
const path    = require('path');

const app = express();
app.use(express.json());

const CLIENT_ID     = process.env.QB_CLIENT_ID;
const CLIENT_SECRET = process.env.QB_CLIENT_SECRET;
const REDIRECT_URI  = process.env.QB_REDIRECT_URI || 'http://localhost:4000/callback';
const SCOPES        = 'com.intuit.quickbooks.accounting';
const SANDBOX_BASE  = 'https://sandbox-quickbooks.api.intuit.com/v3/company';

let tokens    = {};
let companyId = '';

// ── Home: serve dashboard
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

// ── Manufacturing dashboard
app.get('/manufacturing', (req, res) => res.sendFile(path.join(__dirname, 'manufacturing-dashboard.html')));

// ── Step 1: Start OAuth login
app.get('/login', (req, res) => {
  const url = `https://appcenter.intuit.com/connect/oauth2?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(SCOPES)}&state=secureState`;
  res.redirect(url);
});

// ── Step 2: QuickBooks redirects back here
app.get('/callback', async (req, res) => {
  const { code, realmId } = req.query;
  companyId = realmId;
  try {
    const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const resp  = await axios.post('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
      `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
      { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    tokens = resp.data;
    res.redirect('/');
  } catch (e) {
    res.send('Login failed: ' + e.message);
  }
});

// ── Helper: authenticated QB request
async function qbGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  const { data } = await axios.get(`${SANDBOX_BASE}/${companyId}${path}${sep}minorversion=65`, {
    headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' }
  });
  return data;
}

// ── API: check if logged in
app.get('/api/status', (req, res) => res.json({ loggedIn: !!tokens.access_token, companyId }));

// ── API: Invoices
app.get('/api/invoices', async (req, res) => {
  try {
    const data = await qbGet('/query?query=' + encodeURIComponent('SELECT * FROM Invoice MAXRESULTS 100'));
    res.json(data.QueryResponse.Invoice || []);
  } catch(e) { res.json([]); }
});

// ── API: Customers
app.get('/api/customers', async (req, res) => {
  try {
    const data = await qbGet('/query?query=' + encodeURIComponent('SELECT * FROM Customer MAXRESULTS 100'));
    res.json(data.QueryResponse.Customer || []);
  } catch(e) { res.json([]); }
});

// ── API: Expenses
app.get('/api/expenses', async (req, res) => {
  try {
    const data = await qbGet('/query?query=' + encodeURIComponent('SELECT * FROM Purchase MAXRESULTS 100'));
    res.json(data.QueryResponse.Purchase || []);
  } catch(e) { res.json([]); }
});

// ── API: Profit & Loss
app.get('/api/profitloss', async (req, res) => {
  try {
    const { data } = await axios.get(
      `${SANDBOX_BASE}/${companyId}/reports/ProfitAndLoss?minorversion=65`,
      { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' } }
    );
    res.json(data);
  } catch(e) { res.json({}); }
});

// ── API key guard for write endpoints (set N8N_API_KEY in Railway env vars)
function requireApiKey(req, res, next) {
  const expected = process.env.N8N_API_KEY;
  if (!expected || req.headers['x-api-key'] !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// QuickBooks category → account name mapping
const CATEGORY_ACCOUNTS = {
  Materials:  'Cost of Goods Sold',
  Supplies:   'Office Expenses',
  Food:       'Meals and Entertainment',
  Travel:     'Travel',
  Utilities:  'Utilities',
  Office:     'Office Expenses',
  Equipment:  'Equipment Rental',
  Other:      'Other Business Expenses'
};

// ── POST /api/expense — Create expense in QuickBooks (called by n8n batch workflow)
app.post('/api/expense', requireApiKey, async (req, res) => {
  if (!tokens.access_token) return res.status(401).json({ error: 'Not connected to QuickBooks. Visit the dashboard and click Connect.' });
  const { vendor, date, amount, category, memo } = req.body;
  const accountName = CATEGORY_ACCOUNTS[category] || 'Other Business Expenses';
  const body = {
    PaymentType: 'Cash',
    AccountRef: { name: 'Checking' },
    TxnDate: date,
    Line: [{
      Amount: parseFloat(amount) || 0,
      DetailType: 'AccountBasedExpenseLineDetail',
      Description: memo || `${category || 'Expense'}: ${vendor || ''}`,
      AccountBasedExpenseLineDetail: {
        AccountRef: { name: accountName },
        BillableStatus: 'NotBillable'
      }
    }]
  };
  if (vendor) body.EntityRef = { name: vendor, type: 'Vendor' };
  try {
    const { data } = await axios.post(
      `${SANDBOX_BASE}/${companyId}/purchase?minorversion=65`,
      body,
      { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json', 'Content-Type': 'application/json' } }
    );
    res.json({ success: true, purchase_id: data.Purchase?.Id, doc_number: data.Purchase?.DocNumber });
  } catch (e) {
    const msg = e.response?.data?.Fault?.Error?.[0]?.Message || e.message;
    res.status(500).json({ success: false, error: msg });
  }
});

// ── POST /api/payment — Record payment against invoice in QuickBooks
app.post('/api/payment', requireApiKey, async (req, res) => {
  if (!tokens.access_token) return res.status(401).json({ error: 'Not connected to QuickBooks. Visit the dashboard and click Connect.' });
  const { invoice_number, amount, date, payment_method } = req.body;
  try {
    const invoiceData = await qbGet('/query?query=' + encodeURIComponent(`SELECT * FROM Invoice WHERE DocNumber = '${invoice_number}'`));
    const invoice = invoiceData.QueryResponse?.Invoice?.[0];
    if (!invoice) return res.status(404).json({ success: false, error: `Invoice #${invoice_number} not found` });
    const body = {
      TxnDate: date,
      TotalAmt: parseFloat(amount) || 0,
      CustomerRef: { value: invoice.CustomerRef.value },
      Line: [{ Amount: parseFloat(amount) || 0, LinkedTxn: [{ TxnId: invoice.Id, TxnType: 'Invoice' }] }]
    };
    if (payment_method) body.PaymentMethodRef = { name: payment_method };
    const { data } = await axios.post(
      `${SANDBOX_BASE}/${companyId}/payment?minorversion=65`,
      body,
      { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json', 'Content-Type': 'application/json' } }
    );
    res.json({ success: true, payment_id: data.Payment?.Id });
  } catch (e) {
    const msg = e.response?.data?.Fault?.Error?.[0]?.Message || e.message;
    res.status(500).json({ success: false, error: msg });
  }
});

// ── Serve Office Manager page
app.get('/office-manager', (req, res) => res.sendFile(path.join(__dirname, 'office-manager.html')));

// ════════════════════════════════════════════════════════════════════════════
//  AI OFFICE MANAGER — Sub-Agent Tool Handlers
// ════════════════════════════════════════════════════════════════════════════

async function invoiceAgent({ query_type, customer_name }) {
  const data = await qbGet('/query?query=' + encodeURIComponent('SELECT * FROM Invoice MAXRESULTS 200'));
  let inv = data.QueryResponse?.Invoice || [];
  const today = new Date();
  const fmt = n => `$${Number(n).toFixed(2)}`;
  const row = i => ({ number: i.DocNumber, customer: i.CustomerRef?.name, amount: i.TotalAmt, balance: i.Balance, date: i.TxnDate, due: i.DueDate });
  switch (query_type) {
    case 'overdue':
      inv = inv.filter(i => i.Balance > 0 && i.DueDate && new Date(i.DueDate) < today);
      return { count: inv.length, total_overdue: inv.reduce((s,i)=>s+i.Balance,0), invoices: inv.slice(0,10).map(row) };
    case 'paid':
      inv = inv.filter(i => i.Balance <= 0);
      return { count: inv.length, total_paid: inv.reduce((s,i)=>s+i.TotalAmt,0), invoices: inv.slice(0,10).map(row) };
    case 'unpaid':
      inv = inv.filter(i => i.Balance > 0);
      return { count: inv.length, total_unpaid: inv.reduce((s,i)=>s+i.Balance,0), invoices: inv.slice(0,10).map(row) };
    case 'by_customer':
      if (customer_name) inv = inv.filter(i => i.CustomerRef?.name?.toLowerCase().includes(customer_name.toLowerCase()));
      return { count: inv.length, invoices: inv.map(row) };
    default:
      return { total: inv.length, paid: inv.filter(i=>i.Balance<=0).length, unpaid: inv.filter(i=>i.Balance>0).length, total_invoiced: inv.reduce((s,i)=>s+i.TotalAmt,0), total_outstanding: inv.filter(i=>i.Balance>0).reduce((s,i)=>s+i.Balance,0) };
  }
}

async function cashFlowAgent({ period }) {
  const { data } = await axios.get(`${SANDBOX_BASE}/${companyId}/reports/ProfitAndLoss?minorversion=65`, { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' } });
  const rows = data?.Rows?.Row || [];
  const find = (group) => rows.find(r => r.group === group || r.Header?.ColData?.[0]?.value === group);
  const val  = (row, col=1) => parseFloat(row?.Summary?.ColData?.[col]?.value || 0);
  const income   = find('Income');
  const expenses = find('Expenses');
  const net      = rows.find(r => r.Summary?.ColData?.[0]?.value === 'Net Income');
  return { period, total_income: val(income), total_expenses: val(expenses), net_income: val(net), profitable: val(net) > 0 };
}

async function customerAgent({ query_type, customer_name }) {
  const data = await qbGet('/query?query=' + encodeURIComponent('SELECT * FROM Customer MAXRESULTS 100'));
  let custs = data.QueryResponse?.Customer || [];
  const row = c => ({ name: c.DisplayName, balance: c.Balance||0, email: c.PrimaryEmailAddr?.Address||'', phone: c.PrimaryPhone?.FreeFormNumber||'', active: c.Active });
  switch (query_type) {
    case 'by_name':
      if (customer_name) custs = custs.filter(c => c.DisplayName?.toLowerCase().includes(customer_name.toLowerCase()));
      return { customers: custs.map(row) };
    case 'highest_balance':
      return { customers: custs.sort((a,b)=>(b.Balance||0)-(a.Balance||0)).slice(0,5).map(row) };
    case 'overdue':
      custs = custs.filter(c => (c.Balance||0) > 0);
      return { count: custs.length, total_owed: custs.reduce((s,c)=>s+(c.Balance||0),0), customers: custs.map(row) };
    default:
      return { total: custs.length, active: custs.filter(c=>c.Active).length, total_balance: custs.reduce((s,c)=>s+(c.Balance||0),0) };
  }
}

async function expenseAgent({ query_type, vendor }) {
  const data = await qbGet('/query?query=' + encodeURIComponent('SELECT * FROM Purchase MAXRESULTS 200'));
  let exp = data.QueryResponse?.Purchase || [];
  const row = e => ({ vendor: e.EntityRef?.name||'Unknown', amount: e.TotalAmt||0, date: e.TxnDate, type: e.PaymentType });
  switch (query_type) {
    case 'by_vendor':
      if (vendor) exp = exp.filter(e => e.EntityRef?.name?.toLowerCase().includes(vendor.toLowerCase()));
      return { count: exp.length, total: exp.reduce((s,e)=>s+(e.TotalAmt||0),0), expenses: exp.slice(0,10).map(row) };
    case 'recent':
      exp = exp.sort((a,b)=>new Date(b.TxnDate)-new Date(a.TxnDate)).slice(0,10);
      return { expenses: exp.map(row) };
    case 'by_category':
      const cats = {};
      exp.forEach(e => { const k = e.Line?.[0]?.AccountBasedExpenseLineDetail?.AccountRef?.name||'Other'; cats[k]=(cats[k]||0)+(e.TotalAmt||0); });
      return { categories: Object.entries(cats).map(([name,total])=>({name,total})).sort((a,b)=>b.total-a.total) };
    default:
      return { count: exp.length, total: exp.reduce((s,e)=>s+(e.TotalAmt||0),0) };
  }
}

// ── POST /api/chat — Master AI Office Manager (orchestrates sub-agents)
app.post('/api/chat', async (req, res) => {
  const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
  if (!CLAUDE_KEY) return res.json({ answer: 'Add CLAUDE_API_KEY to Railway environment variables.', agents: [] });
  if (!tokens.access_token) return res.json({ answer: 'I am not connected to QuickBooks yet. Please go to the dashboard and click Connect QuickBooks first.', agents: [] });

  const { message, history = [] } = req.body;

  const tools = [
    { name: 'invoice_agent',   description: 'Get invoice data — overdue, paid, unpaid, by customer, totals. Use for any invoice or billing question.',           input_schema: { type:'object', properties: { query_type:{type:'string',enum:['overdue','paid','unpaid','by_customer','all']}, customer_name:{type:'string'} }, required:['query_type'] } },
    { name: 'cash_flow_agent', description: 'Get profit & loss, revenue, expenses, net income. Use for any cash flow or financial health question.',              input_schema: { type:'object', properties: { period:{type:'string',enum:['this_month','this_year']} }, required:['period'] } },
    { name: 'customer_agent',  description: 'Get customer data — who owes money, balances, contact info. Use for any customer question.',                         input_schema: { type:'object', properties: { query_type:{type:'string',enum:['all','by_name','highest_balance','overdue']}, customer_name:{type:'string'} }, required:['query_type'] } },
    { name: 'expense_agent',   description: 'Get expense and purchase data — total spending, by vendor, by category, recent purchases. Use for expense questions.', input_schema: { type:'object', properties: { query_type:{type:'string',enum:['total','by_category','by_vendor','recent']}, vendor:{type:'string'} }, required:['query_type'] } },
  ];

  const SYSTEM = `You are Jennifer, a warm and professional AI Office Manager. You route questions to specialized sub-agents (Invoice Agent, Cash Flow Agent, Customer Agent, Expense Agent) and deliver clear, helpful answers.
Rules:
- Be concise — answers may be read aloud or sent via Telegram
- Use exact numbers from the data
- Use natural conversational sentences, not bullet points
- Sound like a trusted assistant, not a robot
- If asked about multiple things, answer each briefly
- Format dollars as $X,XXX
- If someone greets you, greet back warmly before answering`;

  const messages = [
    ...history.slice(-6).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message }
  ];

  try {
    const first = await axios.post('https://api.anthropic.com/v1/messages', { model:'claude-opus-4-8', max_tokens:1024, system:SYSTEM, tools, messages }, { headers:{'x-api-key':CLAUDE_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'} });
    const firstContent = first.data.content;
    const agentsUsed = [];

    if (first.data.stop_reason === 'tool_use') {
      const toolUses = firstContent.filter(c => c.type === 'tool_use');
      const toolResults = [];

      for (const tu of toolUses) {
        agentsUsed.push(tu.name);
        let result;
        try {
          if      (tu.name === 'invoice_agent')   result = await invoiceAgent(tu.input);
          else if (tu.name === 'cash_flow_agent') result = await cashFlowAgent(tu.input);
          else if (tu.name === 'customer_agent')  result = await customerAgent(tu.input);
          else if (tu.name === 'expense_agent')   result = await expenseAgent(tu.input);
          else result = { error: 'Unknown agent' };
        } catch(e) { result = { error: e.message }; }
        toolResults.push({ type:'tool_result', tool_use_id:tu.id, content:JSON.stringify(result) });
      }

      const final = await axios.post('https://api.anthropic.com/v1/messages', {
        model:'claude-opus-4-8', max_tokens:512, system:SYSTEM, tools,
        messages: [...messages, { role:'assistant', content:firstContent }, { role:'user', content:toolResults }]
      }, { headers:{'x-api-key':CLAUDE_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'} });

      const answer = final.data.content.find(c=>c.type==='text')?.text || 'I could not find that information.';
      return res.json({ answer, agents: agentsUsed });
    }

    const answer = firstContent.find(c=>c.type==='text')?.text || 'I could not process that.';
    res.json({ answer, agents: [] });

  } catch(e) {
    console.error('Office Manager error:', e.response?.data || e.message);
    res.status(500).json({ answer: 'I had trouble getting that information. Please try again.', agents: [] });
  }
});

// ── POST /api/manufacturing-chat — Jennifer for the manufacturing dashboard
app.post('/api/manufacturing-chat', async (req, res) => {
  const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
  if (!CLAUDE_KEY) return res.json({ answer: 'Add CLAUDE_API_KEY to Railway environment variables.' });

  const { message, context, history = [] } = req.body;
  const SYSTEM = `You are Jennifer, an AI Office Manager for Empire Auto Manufacturing. You answer questions about daily production, inventory, and shipments using the live data provided.
Rules:
- Be concise and direct — factory managers are busy
- Use exact numbers from the data
- Flag behind-schedule items urgently (use words like "BEHIND" or "needs attention")
- Speak naturally, not like a report
- Format percentages clearly`;

  const contextBlock = `Live manufacturing data for ${context?.date || 'today'}:\n${JSON.stringify(context, null, 2)}`;
  const messages = [
    { role:'user', content: contextBlock },
    { role:'assistant', content: "I have today's live production data. Ready for your questions." },
    ...history.slice(-4).map(h => ({ role:h.role, content:h.content })),
    { role:'user', content: message }
  ];

  try {
    const resp = await axios.post('https://api.anthropic.com/v1/messages',
      { model:'claude-sonnet-4-6', max_tokens:512, system:SYSTEM, messages },
      { headers:{'x-api-key':CLAUDE_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'} }
    );
    res.json({ answer: resp.data.content[0]?.text || 'I could not process that.' });
  } catch(e) {
    console.error('Manufacturing chat error:', e.response?.data || e.message);
    res.status(500).json({ answer: 'I had trouble getting that. Please try again.' });
  }
});

// ── Serve Jennifer page
app.get('/jennifer', (req, res) => res.sendFile(path.join(__dirname, 'jennifer.html')));

// ── Serve Jennifer PWA manifest
app.get('/jennifer-manifest.json', (req, res) => {
  res.json({
    name: 'Jennifer — AI Office Manager',
    short_name: 'Jennifer',
    description: 'Your AI Office Manager — voice-first business assistant',
    start_url: '/jennifer',
    display: 'fullscreen',
    orientation: 'portrait',
    background_color: '#0f0a0d',
    theme_color: '#9a3a56',
    icons: [
      { src: 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🌸</text></svg>', sizes: '192x192', type: 'image/svg+xml' }
    ]
  });
});

// ── POST /api/morning-briefing-chat — Jennifer's comprehensive morning briefing
app.post('/api/morning-briefing-chat', async (req, res) => {
  const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
  if (!CLAUDE_KEY) return res.json({ answer: 'Add CLAUDE_API_KEY to Railway environment variables.', agents: [] });
  if (!tokens.access_token) return res.json({ answer: 'I am not connected to QuickBooks yet. Please go to the dashboard and connect first.', agents: [] });

  try {
    const [summary, overdue, cashFlow, expenses, customers] = await Promise.all([
      invoiceAgent({ query_type: 'all' }),
      invoiceAgent({ query_type: 'overdue' }),
      cashFlowAgent({ period: 'this_month' }),
      expenseAgent({ query_type: 'recent' }),
      customerAgent({ query_type: 'highest_balance' })
    ]);

    const today = new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
    const CLAUDE_KEY2 = process.env.CLAUDE_API_KEY;
    const briefingData = { today, summary, overdue, cashFlow, expenses, customers };

    const JENNIFER_SYSTEM = `You are Jennifer, a warm and professional AI Office Manager. You speak conversationally, like a trusted assistant — not like a report. The owner is just waking up and asking for their morning briefing. Be encouraging, highlight what needs attention, and keep it natural. Format numbers clearly. Use a friendly but professional tone.`;

    const briefingPrompt = `Here is the business data for ${today}:\n\n${JSON.stringify(briefingData, null, 2)}\n\nGive the owner a warm, comprehensive morning briefing. Cover: financial health, outstanding invoices, overdue items (flag urgently if any), recent expenses, top customer balances. Keep it conversational — like you're talking to them, not reading a report. End with a motivating note.`;

    const resp = await axios.post('https://api.anthropic.com/v1/messages',
      { model:'claude-sonnet-4-6', max_tokens:600, system:JENNIFER_SYSTEM, messages:[{ role:'user', content:briefingPrompt }] },
      { headers:{'x-api-key':CLAUDE_KEY2,'anthropic-version':'2023-06-01','content-type':'application/json'} }
    );
    const answer = resp.data.content[0]?.text || 'Good morning! I had trouble loading your data. Please check your QuickBooks connection.';
    res.json({ answer, agents:['invoice_agent','cash_flow_agent','expense_agent','customer_agent'] });
  } catch(e) {
    console.error('Jennifer briefing error:', e.response?.data || e.message);
    res.status(500).json({ answer: 'Good morning! I had trouble loading your data right now. Please try again.', agents:[] });
  }
});

// ── GET /api/morning-briefing — Daily WhatsApp summary (called by n8n at 7am)
app.get('/api/morning-briefing', async (req, res) => {
  if (!tokens.access_token) {
    return res.json({ message: '⚠️ QuickBooks not connected. Visit the dashboard to reconnect.' });
  }
  try {
    const today = new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
    const [summary, overdue, cashFlow, expenses] = await Promise.all([
      invoiceAgent({ query_type: 'all' }),
      invoiceAgent({ query_type: 'overdue' }),
      cashFlowAgent({ period: 'this_month' }),
      expenseAgent({ query_type: 'total' })
    ]);
    const fmt = n => `$${Number(n||0).toLocaleString('en-US', { minimumFractionDigits:0, maximumFractionDigits:0 })}`;
    const lines = [
      `☀️ *Good Morning — Daily Business Briefing*`,
      `📅 ${today}`,
      `━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `💰 *FINANCIAL SNAPSHOT*`,
      `• Revenue this month: ${fmt(cashFlow.total_income)}`,
      `• Expenses this month: ${fmt(cashFlow.total_expenses)}`,
      `• Net Income: ${fmt(cashFlow.net_income)} ${cashFlow.profitable ? '✅' : '⚠️'}`,
      ``,
      `📄 *INVOICES*`,
      `• Unpaid: ${summary.unpaid||0} invoices (${fmt(summary.total_outstanding)} outstanding)`,
      `• Paid: ${summary.paid||0} invoices collected`,
      `• Overdue: ${overdue.count||0} past due ${overdue.count > 0 ? `(${fmt(overdue.total_overdue)}) ⚠️` : '✅'}`,
      ``,
      `💸 *EXPENSES*`,
      `• Total purchases this month: ${expenses.count||0} (${fmt(expenses.total)})`,
    ];
    if (overdue.count > 0) {
      lines.push(``);
      lines.push(`🚨 *ACTION NEEDED TODAY*`);
      lines.push(`• Follow up on ${overdue.count} overdue invoice(s):`);
      (overdue.invoices||[]).slice(0,3).forEach(inv => {
        lines.push(`  - ${inv.customer}: ${fmt(inv.balance)} (due ${inv.due})`);
      });
    }
    lines.push(``);
    lines.push(`_Your AI Office Manager_ 🤖`);
    res.json({ message: lines.join('\n'), date: today, data: { cashFlow, summary, overdue, expenses } });
  } catch(e) {
    console.error('Morning briefing error:', e.message);
    res.json({ message: `☀️ Good Morning!\n\n⚠️ Could not load data: ${e.message}\n\nCheck your QuickBooks connection at the dashboard.` });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  MED SPA — Routes + AI Office Manager
// ════════════════════════════════════════════════════════════════════════════

app.get('/medspa',                (req, res) => res.sendFile(path.join(__dirname, 'medspa-dashboard.html')));
app.get('/medspa-office-manager', (req, res) => res.sendFile(path.join(__dirname, 'medspa-office-manager.html')));

// Sample Med Spa data — replace with Google Sheets API calls when ready
const MEDSPA = {
  appointments: [
    { time:'9:00 AM',  client:'Sarah Johnson',  treatment:'Botox',         provider:'Dr. Kim', revenue:350, status:'Completed' },
    { time:'10:00 AM', client:'Emily Chen',      treatment:'HydraFacial',   provider:'Lisa',    revenue:150, status:'Completed' },
    { time:'11:00 AM', client:'Maria Garcia',    treatment:'Lip Filler',    provider:'Dr. Kim', revenue:500, status:'Completed' },
    { time:'12:30 PM', client:'Amanda White',    treatment:'Chemical Peel', provider:'Lisa',    revenue:120, status:'In Progress' },
    { time:'1:30 PM',  client:'Jennifer Lee',    treatment:'Microneedling', provider:'Dr. Kim', revenue:200, status:'Upcoming' },
    { time:'2:45 PM',  client:'Rachel Brown',    treatment:'Botox',         provider:'Dr. Kim', revenue:350, status:'Upcoming' },
    { time:'4:00 PM',  client:'Ashley Davis',    treatment:'HydraFacial',   provider:'Lisa',    revenue:150, status:'Upcoming' },
    { time:'5:00 PM',  client:'Monica Wilson',   treatment:'Waxing',        provider:'Staff',   revenue:60,  status:'Upcoming' },
  ],
  clients: [
    { name:'Amanda White',    visits:31, total_spent:11500, last_visit:'2026-06-14', email:'amanda@email.com' },
    { name:'Sarah Johnson',   visits:24, total_spent:8400,  last_visit:'2026-06-14', email:'sarah@email.com' },
    { name:'Emily Chen',      visits:18, total_spent:6200,  last_visit:'2026-06-14', email:'emily@email.com' },
    { name:'Jennifer Lee',    visits:15, total_spent:5800,  last_visit:'2026-06-14', email:'jen@email.com' },
    { name:'Maria Garcia',    visits:8,  total_spent:4200,  last_visit:'2026-06-14', email:'maria@email.com' },
    { name:'Rachel Brown',    visits:12, total_spent:3900,  last_visit:'2026-05-22', email:'rachel@email.com' },
    { name:'Ashley Davis',    visits:6,  total_spent:2100,  last_visit:'2026-06-14', email:'ashley@email.com' },
    { name:'Patricia Moore',  visits:4,  total_spent:1600,  last_visit:'2026-03-05', email:'pat@email.com' },
    { name:'Linda Harris',    visits:3,  total_spent:900,   last_visit:'2026-02-18', email:'linda@email.com' },
    { name:'Karen Williams',  visits:2,  total_spent:500,   last_visit:'2026-01-30', email:'karen@email.com' },
  ],
  treatments: [
    { name:'Botox',           sessions:45, revenue:15750 },
    { name:'Lip/Cheek Filler',sessions:28, revenue:14000 },
    { name:'HydraFacial',     sessions:62, revenue:9300  },
    { name:'Chemical Peel',   sessions:38, revenue:4560  },
    { name:'Microneedling',   sessions:22, revenue:4400  },
    { name:'Waxing',          sessions:55, revenue:2750  },
  ],
  inventory: [
    { name:'Botox — Allergan 100U',  stock:3,  min:10, status:'Critical', unit:'vials'     },
    { name:'Juvederm Ultra Plus',     stock:2,  min:5,  status:'Critical', unit:'syringes'  },
    { name:'AHA Peel Solution 30%',   stock:1,  min:3,  status:'Critical', unit:'bottles'   },
    { name:'Restylane Lyft',          stock:5,  min:8,  status:'Low',      unit:'syringes'  },
    { name:'Numbing Cream EMLA',      stock:12, min:15, status:'Low',      unit:'tubes'     },
    { name:'HydraFacial Tips',        stock:48, min:20, status:'OK',       unit:'units'     },
    { name:'After-care Glow Serum',   stock:24, min:10, status:'OK',       unit:'units'     },
  ],
  revenue: { today_collected:1120, today_potential:2610, month:28450, last_month:24960 }
};

function medSpaAppointmentAgent({ query_type }) {
  const apts = MEDSPA.appointments;
  const today = new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });
  switch (query_type) {
    case 'today':
      return { date:today, total:apts.length, completed:apts.filter(a=>a.status==='Completed').length, in_progress:apts.filter(a=>a.status==='In Progress').length, upcoming:apts.filter(a=>a.status==='Upcoming').length, appointments:apts };
    case 'revenue_today':
      return { collected:MEDSPA.revenue.today_collected, potential:MEDSPA.revenue.today_potential, completed_apts:apts.filter(a=>a.status==='Completed') };
    case 'upcoming':
      return { upcoming:apts.filter(a=>a.status==='Upcoming') };
    case 'by_provider':
      const byProv = {};
      apts.forEach(a=>{ byProv[a.provider]=(byProv[a.provider]||[]).concat(a); });
      return { by_provider: Object.entries(byProv).map(([p,list])=>({provider:p, count:list.length, revenue:list.reduce((s,a)=>s+a.revenue,0)})) };
    default:
      return { total:apts.length, appointments:apts };
  }
}

function medSpaClientAgent({ query_type, client_name }) {
  const clients = MEDSPA.clients;
  const today = new Date();
  switch (query_type) {
    case 'top_spenders':
      return { top_clients:clients.sort((a,b)=>b.total_spent-a.total_spent).slice(0,5) };
    case 'inactive':
      const cutoff = new Date(today - 90*24*60*60*1000);
      const inactive = clients.filter(c=>new Date(c.last_visit)<cutoff);
      return { count:inactive.length, clients:inactive, message:`${inactive.length} clients haven't visited in over 90 days — consider sending a follow-up message.` };
    case 'by_name':
      const found = client_name ? clients.filter(c=>c.name.toLowerCase().includes(client_name.toLowerCase())) : clients;
      return { clients:found };
    case 'retention':
      return { total_clients:clients.length, active_this_month:MEDSPA.appointments.map(a=>a.client).filter((v,i,s)=>s.indexOf(v)===i).length, avg_visits: (clients.reduce((s,c)=>s+c.visits,0)/clients.length).toFixed(1) };
    default:
      return { total:clients.length, clients:clients.slice(0,5) };
  }
}

function medSpaRevenueAgent({ query_type }) {
  const treats = MEDSPA.treatments;
  switch (query_type) {
    case 'by_treatment':
      return { treatments:treats.sort((a,b)=>b.revenue-a.revenue) };
    case 'top_treatment':
      const top = treats.sort((a,b)=>b.revenue-a.revenue)[0];
      return { top_treatment:top, message:`${top.name} is your highest-earning treatment this month at $${top.revenue.toLocaleString()} across ${top.sessions} sessions.` };
    case 'monthly':
      return { month:'June 2026', revenue:MEDSPA.revenue.month, last_month:MEDSPA.revenue.last_month, growth_pct:(((MEDSPA.revenue.month-MEDSPA.revenue.last_month)/MEDSPA.revenue.last_month)*100).toFixed(1), total_sessions:treats.reduce((s,t)=>s+t.sessions,0) };
    case 'today':
      return { collected:MEDSPA.revenue.today_collected, potential:MEDSPA.revenue.today_potential };
    default:
      return { month_revenue:MEDSPA.revenue.month, today_collected:MEDSPA.revenue.today_collected, top_treatment:treats.sort((a,b)=>b.revenue-a.revenue)[0]?.name };
  }
}

function medSpaInventoryAgent({ query_type }) {
  const inv = MEDSPA.inventory;
  switch (query_type) {
    case 'low_stock':
      const low = inv.filter(i=>i.status==='Critical'||i.status==='Low');
      return { count:low.length, critical:inv.filter(i=>i.status==='Critical'), low:inv.filter(i=>i.status==='Low') };
    case 'critical':
      return { critical:inv.filter(i=>i.status==='Critical'), message:`${inv.filter(i=>i.status==='Critical').length} products are critically low and need to be ordered immediately.` };
    case 'all':
      return { inventory:inv };
    default:
      return { total_items:inv.length, critical:inv.filter(i=>i.status==='Critical').length, low:inv.filter(i=>i.status==='Low').length, ok:inv.filter(i=>i.status==='OK').length };
  }
}

// ── POST /api/medspa-chat — Med Spa AI Office Manager
app.post('/api/medspa-chat', async (req, res) => {
  const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
  if (!CLAUDE_KEY) return res.json({ answer:'Add CLAUDE_API_KEY to Railway environment variables.', agents:[] });

  const { message, history = [] } = req.body;

  const tools = [
    { name:'appointment_agent', description:'Get appointment data — today\'s schedule, upcoming, by provider, revenue from appointments.', input_schema:{ type:'object', properties:{ query_type:{type:'string',enum:['today','upcoming','revenue_today','by_provider','all']} }, required:['query_type'] } },
    { name:'client_agent',      description:'Get client data — top spenders, inactive clients, retention, client search.', input_schema:{ type:'object', properties:{ query_type:{type:'string',enum:['top_spenders','inactive','by_name','retention','all']}, client_name:{type:'string'} }, required:['query_type'] } },
    { name:'revenue_agent',     description:'Get revenue data — monthly revenue, by treatment, best performing treatment, today\'s revenue.', input_schema:{ type:'object', properties:{ query_type:{type:'string',enum:['monthly','by_treatment','top_treatment','today','all']} }, required:['query_type'] } },
    { name:'inventory_agent',   description:'Get inventory data — low stock, critical items needing reorder, all products.', input_schema:{ type:'object', properties:{ query_type:{type:'string',enum:['low_stock','critical','all','summary']} }, required:['query_type'] } },
  ];

  const SYSTEM = `You are an AI Office Manager for Glow Med Spa. You route questions to specialized sub-agents (Appointment, Client, Revenue, Inventory) and deliver clear, helpful answers.
Rules:
- Be concise and warm — you work for a med spa
- Use exact numbers from the data
- Use natural sentences, not bullet points
- If inventory is critical, always mention it urgently
- Format dollars as $X,XXX`;

  const messages = [
    ...history.slice(-6).map(h=>({ role:h.role, content:h.content })),
    { role:'user', content:message }
  ];

  try {
    const first = await axios.post('https://api.anthropic.com/v1/messages',
      { model:'claude-sonnet-4-6', max_tokens:1024, system:SYSTEM, tools, messages },
      { headers:{'x-api-key':CLAUDE_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'} }
    );
    const firstContent = first.data.content;
    const agentsUsed = [];

    if (first.data.stop_reason === 'tool_use') {
      const toolUses = firstContent.filter(c=>c.type==='tool_use');
      const toolResults = [];
      for (const tu of toolUses) {
        agentsUsed.push(tu.name);
        let result;
        try {
          if      (tu.name==='appointment_agent') result = medSpaAppointmentAgent(tu.input);
          else if (tu.name==='client_agent')      result = medSpaClientAgent(tu.input);
          else if (tu.name==='revenue_agent')     result = medSpaRevenueAgent(tu.input);
          else if (tu.name==='inventory_agent')   result = medSpaInventoryAgent(tu.input);
          else result = { error:'Unknown agent' };
        } catch(e) { result = { error:e.message }; }
        toolResults.push({ type:'tool_result', tool_use_id:tu.id, content:JSON.stringify(result) });
      }
      const final = await axios.post('https://api.anthropic.com/v1/messages',
        { model:'claude-sonnet-4-6', max_tokens:512, system:SYSTEM, tools, messages:[...messages,{role:'assistant',content:firstContent},{role:'user',content:toolResults}] },
        { headers:{'x-api-key':CLAUDE_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'} }
      );
      const answer = final.data.content.find(c=>c.type==='text')?.text || 'I could not find that information.';
      return res.json({ answer, agents:agentsUsed });
    }

    const answer = firstContent.find(c=>c.type==='text')?.text || 'I could not process that.';
    res.json({ answer, agents:[] });

  } catch(e) {
    console.error('Med Spa chat error:', e.response?.data || e.message);
    res.status(500).json({ answer:'I had trouble getting that information. Please try again.', agents:[] });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ QuickBooks Dashboard running on port ${PORT}`));
