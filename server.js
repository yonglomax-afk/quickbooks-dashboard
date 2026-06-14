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

  const SYSTEM = `You are an AI Office Manager for a business. You route questions to specialized sub-agents (Invoice Agent, Cash Flow Agent, Customer Agent, Expense Agent) and deliver clear answers.
Rules:
- Be concise — answers will be read aloud
- Use exact numbers from the data
- Use natural sentences, not bullet points
- Sound professional and helpful
- If asked about multiple things, answer each briefly
- Format dollars as $X,XXX.XX`;

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

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ QuickBooks Dashboard running on port ${PORT}`));
