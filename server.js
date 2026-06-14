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

// ════════════════════════════════════════════════════════════════════════════
//  DEBUG TOOLS — Logger + Activity Log
// ════════════════════════════════════════════════════════════════════════════

const activityLog = [];   // in-memory ring buffer — last 50 entries

function log(level, agent, message, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,      // 'info' | 'error' | 'warn'
    agent,      // which agent or system component
    message,    // what happened
    ...data
  };
  // Keep last 50 entries
  activityLog.push(entry);
  if (activityLog.length > 50) activityLog.shift();
  // Print to Railway logs (visible in Railway dashboard)
  const line = `[${entry.timestamp}] [${level.toUpperCase()}] [${agent}] ${message}` +
    (data.ms !== undefined ? ` (${data.ms}ms)` : '') +
    (data.error ? ` — ERROR: ${data.error}` : '') +
    (data.skill ? ` skill=${data.skill}` : '');
  if (level === 'error') console.error(line);
  else console.log(line);
}

// ── GET /api/debug — System health check (visit this URL to see status)
app.get('/api/debug', (req, res) => {
  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    quickbooks: {
      connected:  !!tokens.access_token,
      company_id: companyId || 'not connected'
    },
    environment: {
      CLAUDE_API_KEY: !!process.env.CLAUDE_API_KEY  ? '✅ set' : '❌ missing',
      N8N_API_KEY:    !!process.env.N8N_API_KEY     ? '✅ set' : '❌ missing',
      QB_CLIENT_ID:   !!process.env.QB_CLIENT_ID    ? '✅ set' : '❌ missing',
      PORT:           process.env.PORT || 4000
    },
    agents: {
      email_agent:     ['categorize', 'summarize', 'extract_action_items', 'draft_reply'],
      invoice_agent:   ['overdue', 'paid', 'unpaid', 'by_customer', 'all', 'draft_reminder', 'create_invoice'],
      cash_flow_agent: ['summary', 'generate_insights'],
      customer_agent:  ['all', 'by_name', 'highest_balance', 'overdue', 'get_customer_360', 'draft_thank_you'],
      expense_agent:   ['total', 'by_category', 'by_vendor', 'recent', 'flag_unusual', 'create_expense'],
      receipt_agent:   ['extract', 'categorize', 'post_to_quickbooks']
    },
    recent_activity: activityLog.slice(-10).reverse()
  });
});

// ── GET /api/debug/log — Full activity log (last 50 calls)
app.get('/api/debug/log', (req, res) => {
  res.json({
    total_entries: activityLog.length,
    entries: [...activityLog].reverse()   // newest first
  });
});

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

// ── Helper: authenticated QB GET
async function qbGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  const { data } = await axios.get(`${SANDBOX_BASE}/${companyId}${path}${sep}minorversion=65`, {
    headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' }
  });
  return data;
}

// ── Helper: authenticated QB POST
async function qbPost(path, body) {
  const { data } = await axios.post(`${SANDBOX_BASE}/${companyId}${path}?minorversion=65`, body, {
    headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json', 'Content-Type': 'application/json' }
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

async function invoiceAgent({ query_type, customer_name, amount, due_date, description }) {
  const data = await qbGet('/query?query=' + encodeURIComponent('SELECT * FROM Invoice MAXRESULTS 200'));
  const inv = data.QueryResponse?.Invoice || [];
  const today = new Date();
  const fmt = n => `$${Number(n || 0).toFixed(2)}`;
  const row = i => ({ number: i.DocNumber, customer: i.CustomerRef?.name || 'Unknown', amount: i.TotalAmt || 0, balance: i.Balance || 0, date: i.TxnDate, due: i.DueDate });

  switch (query_type) {
    case 'overdue': {
      const overdue = inv.filter(i => (i.Balance || 0) > 0 && i.DueDate && new Date(i.DueDate) < today);
      return { count: overdue.length, total_overdue: overdue.reduce((s,i)=>s+(i.Balance||0),0), invoices: overdue.slice(0,10).map(row) };
    }
    case 'paid': {
      const paid = inv.filter(i => (i.Balance || 0) <= 0);
      return { count: paid.length, total_paid: paid.reduce((s,i)=>s+(i.TotalAmt||0),0), invoices: paid.slice(0,10).map(row) };
    }
    case 'unpaid': {
      const unpaid = inv.filter(i => (i.Balance || 0) > 0);
      return { count: unpaid.length, total_unpaid: unpaid.reduce((s,i)=>s+(i.Balance||0),0), invoices: unpaid.slice(0,10).map(row) };
    }
    case 'by_customer': {
      const filtered = customer_name
        ? inv.filter(i => (i.CustomerRef?.name || '').toLowerCase().includes(customer_name.toLowerCase()))
        : inv;
      return { count: filtered.length, invoices: filtered.map(row) };
    }
    case 'draft_reminder': {
      let overdue = inv.filter(i => (i.Balance || 0) > 0 && i.DueDate && new Date(i.DueDate) < today);
      if (customer_name) overdue = overdue.filter(i => (i.CustomerRef?.name || '').toLowerCase().includes(customer_name.toLowerCase()));
      if (overdue.length === 0) return { message: `No overdue invoices found${customer_name ? ' for ' + customer_name : ''}` };

      let custEmail = '[no email on file]';
      try {
        const safe = (customer_name || '').replace(/'/g, "\\'");
        const custData = await qbGet('/query?query=' + encodeURIComponent(`SELECT * FROM Customer WHERE DisplayName LIKE '%${safe}%' MAXRESULTS 1`));
        custEmail = custData.QueryResponse?.Customer?.[0]?.PrimaryEmailAddr?.Address || '[no email on file]';
      } catch(_) {}

      const targetCustomer = overdue[0].CustomerRef?.name || customer_name || 'Valued Customer';
      const totalOwed = overdue.reduce((s,i)=>s+(i.Balance||0),0);
      const invoiceList = overdue.slice(0,5).map(i=>`Invoice #${i.DocNumber}: ${fmt(i.Balance)} (due ${i.DueDate})`).join('\n');

      const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
      if (!CLAUDE_KEY) return { error: 'CLAUDE_API_KEY not configured' };

      const composeResp = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-haiku-4-5-20251001', max_tokens: 350,
        messages: [{ role: 'user', content: `Write a professional, friendly payment reminder email. 3-4 sentences max. No placeholders like [Your Name] or [Company Name].

Customer: ${targetCustomer}
Overdue invoices:\n${invoiceList}
Total owed: ${fmt(totalOwed)}

Write only the email body.` }]
      }, { headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });

      return {
        action: 'draft_reminder',
        customer: targetCustomer,
        email_to: custEmail,
        total_overdue: totalOwed,
        overdue_invoices: overdue.slice(0,5).map(row),
        draft_email: composeResp.data.content[0]?.text || 'Could not compose email.',
        status: 'Draft ready — review and send'
      };
    }
    case 'create_invoice': {
      if (!customer_name) return { error: 'customer_name is required to create an invoice' };
      if (!amount || isNaN(parseFloat(amount))) return { error: 'A valid amount is required to create an invoice' };
      const safe = customer_name.replace(/'/g, "\\'");
      const custData = await qbGet('/query?query=' + encodeURIComponent(`SELECT * FROM Customer WHERE DisplayName LIKE '%${safe}%' MAXRESULTS 1`));
      const cust = custData.QueryResponse?.Customer?.[0];
      if (!cust) return { error: `Customer "${customer_name}" not found in QuickBooks. Please check the name.` };
      const txnDate = new Date().toISOString().split('T')[0];
      const dueDate = due_date || (() => { const d = new Date(); d.setDate(d.getDate()+30); return d.toISOString().split('T')[0]; })();
      const body = {
        CustomerRef: { value: cust.Id },
        TxnDate: txnDate,
        DueDate: dueDate,
        Line: [{
          Amount: parseFloat(amount),
          DetailType: 'SalesItemLineDetail',
          Description: description || 'Services rendered',
          SalesItemLineDetail: { ItemRef: { value: '1', name: 'Services' } }
        }]
      };
      const result = await qbPost('/invoice', body);
      return { success: true, invoice_id: result.Invoice?.Id, invoice_number: result.Invoice?.DocNumber, customer: cust.DisplayName, amount: parseFloat(amount), due_date: dueDate, status: 'Invoice created in QuickBooks' };
    }
    default:
      return { total: inv.length, paid: inv.filter(i=>(i.Balance||0)<=0).length, unpaid: inv.filter(i=>(i.Balance||0)>0).length, total_invoiced: inv.reduce((s,i)=>s+(i.TotalAmt||0),0), total_outstanding: inv.filter(i=>(i.Balance||0)>0).reduce((s,i)=>s+(i.Balance||0),0) };
  }
}

async function cashFlowAgent({ period, query_type }) {
  const { data } = await axios.get(`${SANDBOX_BASE}/${companyId}/reports/ProfitAndLoss?minorversion=65`, { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' } });
  const rows = data?.Rows?.Row || [];
  const find = (group) => rows.find(r => r.group === group || r.Header?.ColData?.[0]?.value === group);
  const val  = (row, col=1) => parseFloat(row?.Summary?.ColData?.[col]?.value || 0);
  const income   = find('Income');
  const expenses = find('Expenses');
  const net      = rows.find(r => r.Summary?.ColData?.[0]?.value === 'Net Income');
  const summary  = { period, total_income: val(income), total_expenses: val(expenses), net_income: val(net), profitable: val(net) > 0 };

  if (query_type === 'generate_insights') {
    const margin       = summary.total_income > 0 ? ((summary.net_income / summary.total_income) * 100).toFixed(1) : '0';
    const expenseRatio = summary.total_income > 0 ? ((summary.total_expenses / summary.total_income) * 100).toFixed(1) : '0';
    const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
    if (!CLAUDE_KEY) return { ...summary, insights: 'CLAUDE_API_KEY not configured' };
    const insightResp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001', max_tokens: 400,
      messages: [{ role: 'user', content: `You are a financial advisor. Analyze this business P&L and give exactly 3 specific, actionable insights. Be direct. No generic advice.

Period: ${period}
Revenue: $${summary.total_income.toFixed(2)}
Expenses: $${summary.total_expenses.toFixed(2)}
Net Income: $${summary.net_income.toFixed(2)}
Net Margin: ${margin}%
Expense Ratio: ${expenseRatio}%

Give 3 numbered insights. Each 1-2 sentences. Focus on what the owner should do or watch.` }]
    }, { headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
    return { ...summary, margin_pct: parseFloat(margin), expense_ratio_pct: parseFloat(expenseRatio), insights: insightResp.data.content[0]?.text || 'Could not generate insights.' };
  }

  return summary;
}

async function customerAgent({ query_type, customer_name }) {
  const data = await qbGet('/query?query=' + encodeURIComponent('SELECT * FROM Customer MAXRESULTS 100'));
  const custs = data.QueryResponse?.Customer || [];
  const row = c => ({ name: c.DisplayName || 'Unknown', balance: c.Balance||0, email: c.PrimaryEmailAddr?.Address||'', phone: c.PrimaryPhone?.FreeFormNumber||'', active: c.Active });

  switch (query_type) {
    case 'by_name': {
      const filtered = customer_name
        ? custs.filter(c => (c.DisplayName || '').toLowerCase().includes(customer_name.toLowerCase()))
        : custs;
      return { customers: filtered.map(row) };
    }
    case 'highest_balance':
      return { customers: [...custs].sort((a,b)=>(b.Balance||0)-(a.Balance||0)).slice(0,5).map(row) };
    case 'overdue': {
      const owing = custs.filter(c => (c.Balance||0) > 0);
      return { count: owing.length, total_owed: owing.reduce((s,c)=>s+(c.Balance||0),0), customers: owing.map(row) };
    }
    case 'get_customer_360': {
      if (!customer_name) return { error: 'customer_name is required for 360 view' };
      const cust = custs.find(c => (c.DisplayName || '').toLowerCase().includes(customer_name.toLowerCase()));
      if (!cust) return { error: `Customer "${customer_name}" not found in QuickBooks` };
      const invData = await qbGet('/query?query=' + encodeURIComponent(`SELECT * FROM Invoice WHERE CustomerRef = '${cust.Id}' MAXRESULTS 50`));
      const invoices = invData.QueryResponse?.Invoice || [];
      const paid    = invoices.filter(i => (i.Balance||0) <= 0);
      const unpaid  = invoices.filter(i => (i.Balance||0) > 0);
      const overdue = unpaid.filter(i => i.DueDate && new Date(i.DueDate) < new Date());
      const totalValue = invoices.reduce((s,i)=>s+(i.TotalAmt||0),0);
      const avgInvoice = invoices.length > 0 ? totalValue/invoices.length : 0;
      const risk = overdue.length >= 3 ? 'High' : overdue.length > 0 ? 'Medium' : 'Low';
      return {
        customer: row(cust),
        total_invoices: invoices.length,
        paid_invoices: paid.length,
        unpaid_invoices: unpaid.length,
        overdue_invoices: overdue.length,
        total_business_value: totalValue,
        avg_invoice_amount: avgInvoice,
        current_balance: cust.Balance||0,
        payment_risk: risk,
        recent_invoices: [...invoices].sort((a,b)=>new Date(b.TxnDate)-new Date(a.TxnDate)).slice(0,5).map(i=>({ number:i.DocNumber, amount:i.TotalAmt||0, balance:i.Balance||0, date:i.TxnDate, due:i.DueDate }))
      };
    }
    case 'draft_thank_you': {
      if (!customer_name) return { error: 'customer_name is required to draft a thank-you' };
      const cust = custs.find(c => (c.DisplayName || '').toLowerCase().includes(customer_name.toLowerCase()));
      if (!cust) return { error: `Customer "${customer_name}" not found in QuickBooks` };
      const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
      if (!CLAUDE_KEY) return { error: 'CLAUDE_API_KEY not configured' };
      const resp = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-haiku-4-5-20251001', max_tokens: 250,
        messages: [{ role: 'user', content: `Write a short, sincere business thank-you message to a valued customer. 2-3 sentences. Warm but professional. No placeholders like [Your Name] or [Company].

Customer name: ${cust.DisplayName}
Total business with us: $${(cust.Balance||0).toFixed(2)} current balance

Write only the message body.` }]
      }, { headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
      return {
        action: 'draft_thank_you',
        customer: cust.DisplayName,
        email_to: cust.PrimaryEmailAddr?.Address || '[no email on file]',
        draft_message: resp.data.content[0]?.text || 'Could not compose message.',
        status: 'Draft ready — review and send'
      };
    }
    default:
      return { total: custs.length, active: custs.filter(c=>c.Active).length, total_balance: custs.reduce((s,c)=>s+(c.Balance||0),0) };
  }
}

async function expenseAgent({ query_type, vendor, amount, date, category, memo }) {
  const data = await qbGet('/query?query=' + encodeURIComponent('SELECT * FROM Purchase MAXRESULTS 200'));
  const exp = data.QueryResponse?.Purchase || [];
  const row = e => ({ vendor: e.EntityRef?.name||'Unknown', amount: e.TotalAmt||0, date: e.TxnDate, type: e.PaymentType });

  switch (query_type) {
    case 'by_vendor': {
      const filtered = vendor
        ? exp.filter(e => (e.EntityRef?.name || '').toLowerCase().includes(vendor.toLowerCase()))
        : exp;
      return { count: filtered.length, total: filtered.reduce((s,e)=>s+(e.TotalAmt||0),0), expenses: filtered.slice(0,10).map(row) };
    }
    case 'recent': {
      const sorted = [...exp].sort((a,b)=>new Date(b.TxnDate)-new Date(a.TxnDate)).slice(0,10);
      return { expenses: sorted.map(row) };
    }
    case 'by_category': {
      const cats = {};
      exp.forEach(e => { const k = e.Line?.[0]?.AccountBasedExpenseLineDetail?.AccountRef?.name || 'Other'; cats[k] = (cats[k]||0) + (e.TotalAmt||0); });
      return { categories: Object.entries(cats).map(([name,total])=>({name,total})).sort((a,b)=>b.total-a.total) };
    }
    case 'flag_unusual': {
      if (exp.length === 0) return { message: 'No expenses on record to analyze' };
      const amounts = exp.map(e => e.TotalAmt || 0);
      const avg = amounts.reduce((s,a)=>s+a,0) / amounts.length;
      const stdDev = Math.sqrt(amounts.map(a=>Math.pow(a-avg,2)).reduce((s,v)=>s+v,0) / amounts.length);
      const threshold = avg + (2 * stdDev);
      const unusual = exp.filter(e => (e.TotalAmt||0) > threshold).map(row);
      // Check for potential duplicates: same vendor + same amount within 7 days
      const duplicates = [];
      const seen = new Set();
      for (let i = 0; i < exp.length; i++) {
        for (let j = i+1; j < exp.length; j++) {
          const e1 = exp[i], e2 = exp[j];
          const key = `${e1.EntityRef?.name}|${e1.TotalAmt}`;
          if (seen.has(key)) continue;
          const daysDiff = Math.abs(new Date(e1.TxnDate) - new Date(e2.TxnDate)) / (1000*60*60*24);
          if (e1.EntityRef?.name === e2.EntityRef?.name && e1.TotalAmt === e2.TotalAmt && daysDiff <= 7) {
            seen.add(key);
            duplicates.push({ vendor: e1.EntityRef?.name, amount: e1.TotalAmt, dates: [e1.TxnDate, e2.TxnDate] });
          }
        }
      }
      return {
        avg_expense: avg.toFixed(2),
        high_threshold: threshold.toFixed(2),
        unusual_expenses: unusual,
        potential_duplicates: duplicates,
        summary: `Found ${unusual.length} unusually large expense(s) and ${duplicates.length} potential duplicate(s)`
      };
    }
    case 'create_expense': {
      if (!vendor) return { error: 'vendor name is required to create an expense' };
      if (!amount || isNaN(parseFloat(amount))) return { error: 'A valid amount is required to create an expense' };
      const accountName = CATEGORY_ACCOUNTS[category] || 'Other Business Expenses';
      const body = {
        PaymentType: 'Cash',
        AccountRef: { name: 'Checking' },
        TxnDate: date || new Date().toISOString().split('T')[0],
        EntityRef: { name: vendor, type: 'Vendor' },
        Line: [{
          Amount: parseFloat(amount),
          DetailType: 'AccountBasedExpenseLineDetail',
          Description: memo || `${category || 'Expense'}: ${vendor}`,
          AccountBasedExpenseLineDetail: { AccountRef: { name: accountName }, BillableStatus: 'NotBillable' }
        }]
      };
      const result = await qbPost('/purchase', body);
      return { success: true, purchase_id: result.Purchase?.Id, vendor, amount: parseFloat(amount), category: category || 'Other', account: accountName, status: 'Expense created in QuickBooks' };
    }
    default:
      return { count: exp.length, total: exp.reduce((s,e)=>s+(e.TotalAmt||0),0) };
  }
}

async function receiptAgent({ skill, email_text, email_from, email_subject, vendor, amount, date, description, category }) {
  const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
  if (!CLAUDE_KEY) return { error: 'CLAUDE_API_KEY not configured' };

  switch (skill) {
    case 'extract': {
      if (!email_text) return { error: 'email_text is required for the extract skill' };
      const prompt = `You are a receipt extraction specialist. Analyze this email and determine if it is a business expense receipt or purchase confirmation.

Email From: ${(email_from || '').substring(0, 200)}
Email Subject: ${(email_subject || '').substring(0, 200)}
Email Text: ${email_text.substring(0, 3000)}

If this is a receipt, invoice, or order confirmation — extract the data.
If NOT a receipt (newsletter, marketing, personal email) — set is_receipt to false.

Respond with ONLY valid JSON, no explanation:
{
  "is_receipt": true or false,
  "vendor": "company or store name, or null",
  "amount": total as a number, or null,
  "date": "YYYY-MM-DD or null",
  "description": "brief description of purchase, or null",
  "items": ["item1", "item2"] or []
}`;
      const resp = await axios.post('https://api.anthropic.com/v1/messages',
        { model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: prompt }] },
        { headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
      );
      const text = resp.data.content[0]?.text || '{}';
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return { is_receipt: false, error: 'Could not parse extraction response' };
      try { return JSON.parse(match[0]); } catch(_) { return { is_receipt: false, error: 'Invalid JSON in extraction response' }; }
    }

    case 'categorize': {
      if (!vendor && !description) return { error: 'vendor or description is required to categorize' };
      const prompt = `You are Jennifer, an AI Office Manager. Categorize this business expense for QuickBooks.

Vendor: ${vendor || 'Unknown'}
Amount: $${amount || 0}
Date: ${date || 'Unknown'}
Description: ${description || 'No description'}

Choose the best category from: Materials, Supplies, Food, Travel, Utilities, Office, Equipment, Software, Other

QuickBooks account for each category:
- Materials → "Cost of Goods Sold"
- Supplies → "Office Expenses"
- Food → "Meals and Entertainment"
- Travel → "Travel"
- Utilities → "Utilities"
- Office → "Office Expenses"
- Equipment → "Equipment Rental"
- Software → "Office Expenses"
- Other → "Other Business Expenses"

Respond with ONLY valid JSON:
{
  "category": "chosen category",
  "account": "QuickBooks account name",
  "confidence": number 0-100,
  "notes": "one sentence explanation"
}`;
      const resp = await axios.post('https://api.anthropic.com/v1/messages',
        { model: 'claude-haiku-4-5-20251001', max_tokens: 300, messages: [{ role: 'user', content: prompt }] },
        { headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
      );
      const text = resp.data.content[0]?.text || '{}';
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return { category: 'Other', account: 'Other Business Expenses', confidence: 0, notes: 'Could not parse categorization' };
      try {
        const result = JSON.parse(match[0]);
        return { ...result, vendor, amount, date, description };
      } catch(_) {
        return { category: 'Other', account: 'Other Business Expenses', confidence: 0, vendor, amount, date, description };
      }
    }

    case 'post_to_quickbooks': {
      if (!tokens.access_token) return { error: 'QuickBooks is not connected. Go to the dashboard and click Connect.' };
      if (!vendor) return { error: 'vendor is required to post expense to QuickBooks' };
      if (!amount || isNaN(parseFloat(amount))) return { error: 'A valid amount is required to post expense to QuickBooks' };
      const accountName = CATEGORY_ACCOUNTS[category] || 'Other Business Expenses';
      const body = {
        PaymentType: 'Cash',
        AccountRef: { name: 'Checking' },
        TxnDate: date || new Date().toISOString().split('T')[0],
        EntityRef: { name: vendor, type: 'Vendor' },
        Line: [{
          Amount: parseFloat(amount),
          DetailType: 'AccountBasedExpenseLineDetail',
          Description: description || `${category || 'Expense'}: ${vendor}`,
          AccountBasedExpenseLineDetail: { AccountRef: { name: accountName }, BillableStatus: 'NotBillable' }
        }]
      };
      const result = await qbPost('/purchase', body);
      return {
        success: true,
        purchase_id: result.Purchase?.Id,
        doc_number: result.Purchase?.DocNumber,
        vendor,
        amount: parseFloat(amount),
        category: category || 'Other',
        account: accountName,
        date: date || new Date().toISOString().split('T')[0],
        status: 'Posted to QuickBooks by Jennifer'
      };
    }

    default:
      return { error: `Unknown receipt_agent skill: "${skill}". Available skills: extract, categorize, post_to_quickbooks` };
  }
}

async function emailAgent({ skill, email_text, email_from, email_subject, context }) {
  const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
  if (!CLAUDE_KEY) return { error: 'CLAUDE_API_KEY not configured' };
  if (!email_text) return { error: 'email_text is required for email_agent' };

  const header = `From: ${email_from || 'Unknown'}\nSubject: ${email_subject || 'No subject'}\nBody: ${email_text.substring(0, 2500)}`;

  switch (skill) {
    case 'categorize': {
      const prompt = `Categorize this business email. Choose ONE category and assess urgency.

${header}

Categories:
- receipt          → purchase confirmation, order receipt, expense receipt
- customer_inquiry → question from customer, quote request, information request
- customer_complaint → complaint, issue, problem, unhappy customer
- payment_dispute  → "I already paid", billing question, payment disagreement
- vendor_invoice   → bill or invoice from a supplier or vendor
- vendor_email     → general communication from a supplier or vendor
- general          → anything else

Respond with ONLY valid JSON:
{
  "category": "one category from the list above",
  "urgency": "low or medium or high",
  "who_sent_it": "customer or vendor or unknown",
  "one_line_summary": "one sentence describing what this email is about",
  "next_agent": "which agent Jennifer should call next: receipt_agent, invoice_agent, customer_agent, expense_agent, or none"
}`;
      const resp = await axios.post('https://api.anthropic.com/v1/messages',
        { model: 'claude-haiku-4-5-20251001', max_tokens: 300, messages: [{ role: 'user', content: prompt }] },
        { headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
      );
      const text = resp.data.content[0]?.text || '{}';
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return { category: 'general', urgency: 'low', who_sent_it: 'unknown', one_line_summary: 'Could not categorize', next_agent: 'none' };
      try { return { ...JSON.parse(match[0]), email_from, email_subject }; }
      catch(_) { return { category: 'general', urgency: 'low', who_sent_it: 'unknown', one_line_summary: 'Parse error', next_agent: 'none' }; }
    }

    case 'summarize': {
      const prompt = `Summarize this business email in 2-3 sentences. Be specific — who sent it, what they need, and any key details like amounts or dates.

${header}

Write only the summary.`;
      const resp = await axios.post('https://api.anthropic.com/v1/messages',
        { model: 'claude-haiku-4-5-20251001', max_tokens: 200, messages: [{ role: 'user', content: prompt }] },
        { headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
      );
      return { summary: resp.data.content[0]?.text || 'Could not summarize.', email_from, email_subject };
    }

    case 'extract_action_items': {
      const prompt = `Read this business email and list every action the owner needs to take. Be specific. If none, say so.

${header}

Respond with ONLY valid JSON:
{
  "has_action_items": true or false,
  "action_items": ["specific action 1", "specific action 2"],
  "deadline": "deadline if mentioned, or null",
  "priority": "low or medium or high"
}`;
      const resp = await axios.post('https://api.anthropic.com/v1/messages',
        { model: 'claude-haiku-4-5-20251001', max_tokens: 300, messages: [{ role: 'user', content: prompt }] },
        { headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
      );
      const text = resp.data.content[0]?.text || '{}';
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return { has_action_items: false, action_items: [], deadline: null, priority: 'low' };
      try { return JSON.parse(match[0]); }
      catch(_) { return { has_action_items: false, action_items: [], deadline: null, priority: 'low' }; }
    }

    case 'draft_reply': {
      const prompt = `Write a professional, friendly reply to this business email. 3-5 sentences max. No placeholders like [Your Name] or [Company Name].

Original email:
${header}

${context ? `Owner's instruction: ${context}` : ''}

Write only the reply body.`;
      const resp = await axios.post('https://api.anthropic.com/v1/messages',
        { model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: prompt }] },
        { headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
      );
      return {
        action: 'draft_reply',
        reply_to: email_from || 'Unknown',
        subject: `Re: ${email_subject || ''}`,
        draft: resp.data.content[0]?.text || 'Could not draft reply.',
        status: 'Draft ready — review and send'
      };
    }

    default:
      return { error: `Unknown email_agent skill: "${skill}". Available: categorize, summarize, extract_action_items, draft_reply` };
  }
}

// ── POST /api/chat — Master AI Office Manager (orchestrates sub-agents)
app.post('/api/chat', async (req, res) => {
  const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
  if (!CLAUDE_KEY) return res.json({ answer: 'Add CLAUDE_API_KEY to Railway environment variables.', agents: [] });
  if (!tokens.access_token) return res.json({ answer: 'I am not connected to QuickBooks yet. Please go to the dashboard and click Connect QuickBooks first.', agents: [] });

  const { message, history = [] } = req.body;
  log('info', 'jennifer', 'message received', { preview: (message || '').substring(0, 80) });

  const tools = [
    {
      name: 'email_agent',
      description: 'FIRST RESPONDER — always call this first when the owner shares any email content. Reads every incoming email and decides what to do next. Skills: categorize (determines email type and tells Jennifer which specialist to call next), summarize (2-3 sentence summary), extract_action_items (what the owner needs to do), draft_reply (write a professional response). After categorize, follow the next_agent field to route to the right specialist.',
      input_schema: {
        type: 'object',
        properties: {
          skill:         { type: 'string', enum: ['categorize', 'summarize', 'extract_action_items', 'draft_reply'], description: 'Always start with categorize for any new email' },
          email_text:    { type: 'string', description: 'Full email body text — required' },
          email_from:    { type: 'string', description: 'Sender email address' },
          email_subject: { type: 'string', description: 'Email subject line' },
          context:       { type: 'string', description: 'Owner instruction for draft_reply — e.g. "apologize" or "ask for payment date"' }
        },
        required: ['skill', 'email_text']
      }
    },
    {
      name: 'invoice_agent',
      description: 'Manages invoices — reads data AND takes actions. Use for invoice questions (overdue, paid, unpaid, by customer) AND for drafting payment reminder emails (draft_reminder) or creating new invoices in QuickBooks (create_invoice).',
      input_schema: {
        type: 'object',
        properties: {
          query_type: { type:'string', enum:['overdue','paid','unpaid','by_customer','all','draft_reminder','create_invoice'], description:'What to do: read data or take action' },
          customer_name: { type:'string', description:'Customer name — required for by_customer, draft_reminder, create_invoice' },
          amount: { type:'number', description:'Invoice amount — required for create_invoice' },
          due_date: { type:'string', description:'Due date YYYY-MM-DD — for create_invoice (defaults to 30 days)' },
          description: { type:'string', description:'Line item description — for create_invoice' }
        },
        required: ['query_type']
      }
    },
    {
      name: 'cash_flow_agent',
      description: 'Gets financial data — P&L, revenue, expenses, net income, and AI-powered financial insights. Use for cash flow, profit, income, financial health, or analysis questions.',
      input_schema: {
        type: 'object',
        properties: {
          period: { type:'string', enum:['this_month','this_year'], description:'Time period for the report' },
          query_type: { type:'string', enum:['summary','generate_insights'], description:'summary for raw numbers, generate_insights for AI analysis and recommendations' }
        },
        required: ['period']
      }
    },
    {
      name: 'customer_agent',
      description: 'Manages customers — reads data AND creates content. Get customer lists, balances, full 360 customer profile with payment history and risk level, or draft thank-you notes.',
      input_schema: {
        type: 'object',
        properties: {
          query_type: { type:'string', enum:['all','by_name','highest_balance','overdue','get_customer_360','draft_thank_you'], description:'What to do' },
          customer_name: { type:'string', description:'Customer name — required for by_name, get_customer_360, draft_thank_you' }
        },
        required: ['query_type']
      }
    },
    {
      name: 'expense_agent',
      description: 'Manages expenses — reads data AND takes actions. Get spending totals, expenses by category/vendor, recent purchases, flag unusual or duplicate expenses, or create new expense entries in QuickBooks.',
      input_schema: {
        type: 'object',
        properties: {
          query_type: { type:'string', enum:['total','by_category','by_vendor','recent','flag_unusual','create_expense'], description:'What to do' },
          vendor: { type:'string', description:'Vendor name — for by_vendor filter or create_expense' },
          amount: { type:'number', description:'Amount — required for create_expense' },
          date: { type:'string', description:'Date YYYY-MM-DD — for create_expense (defaults to today)' },
          category: { type:'string', description:'Category for create_expense: Materials, Supplies, Food, Travel, Utilities, Office, Equipment, Software, Other' },
          memo: { type:'string', description:'Description/memo — for create_expense' }
        },
        required: ['query_type']
      }
    },
    {
      name: 'receipt_agent',
      description: 'Processes expense receipts end-to-end. Use when the owner shares receipt text or email content. Three skills: extract (read raw email/text and pull out vendor, amount, date), categorize (assign QuickBooks category and account with confidence score), post_to_quickbooks (Jennifer posts the expense directly to QuickBooks). Always call extract first, then categorize, then post_to_quickbooks.',
      input_schema: {
        type: 'object',
        properties: {
          skill:         { type: 'string', enum: ['extract', 'categorize', 'post_to_quickbooks'], description: 'Which skill to run' },
          email_text:    { type: 'string', description: 'Full email or receipt text — required for extract' },
          email_from:    { type: 'string', description: 'Sender email address — for extract' },
          email_subject: { type: 'string', description: 'Email subject line — for extract' },
          vendor:        { type: 'string', description: 'Vendor name — for categorize and post_to_quickbooks' },
          amount:        { type: 'number', description: 'Total receipt amount — for categorize and post_to_quickbooks' },
          date:          { type: 'string', description: 'Receipt date YYYY-MM-DD — for categorize and post_to_quickbooks' },
          description:   { type: 'string', description: 'What was purchased — for categorize and post_to_quickbooks' },
          category:      { type: 'string', description: 'Category from categorize result — required for post_to_quickbooks' }
        },
        required: ['skill']
      }
    },
  ];

  const SYSTEM = `You are Jennifer, a warm and professional AI Office Manager. You are the front door — every message comes to you first. You coordinate specialized sub-agents and take real business actions on behalf of the owner.

YOUR AGENTS AND WHEN TO CALL THEM:

EMAIL AGENT (call first for any email content):
  • categorize   → always your first call when owner shares email text
  • summarize    → get a clear 2-3 sentence summary
  • extract_action_items → find what needs to be done
  • draft_reply  → write a professional response

ROUTING RULES after email_agent.categorize:
  • category = receipt or vendor_invoice  → call receipt_agent (extract → categorize → post_to_quickbooks)
  • category = payment_dispute            → call invoice_agent (find the invoice, get details)
  • category = customer_inquiry           → call customer_agent + email_agent.draft_reply
  • category = customer_complaint         → call email_agent.draft_reply (urgent tone) + customer_agent
  • category = vendor_email               → call email_agent.summarize + email_agent.extract_action_items
  • category = general                    → call email_agent.summarize

SPECIALIST AGENTS (call after email_agent routes you there):
  • invoice_agent    → invoices: overdue, paid, unpaid, draft_reminder, create_invoice
  • cash_flow_agent  → P&L, revenue, expenses, generate_insights
  • customer_agent   → customer data, get_customer_360, draft_thank_you
  • expense_agent    → spending, flag_unusual, create_expense
  • receipt_agent    → extract, categorize, post_to_quickbooks

RULES:
- Be concise — answers may be read aloud
- Use exact numbers from data
- Speak naturally, like a trusted assistant
- Format dollars as $X,XXX
- For drafts (emails, notes), present them clearly so the owner can review before sending
- For completed actions (expense posted, invoice created), confirm briefly what was done
- If an agent returns an error, explain clearly and suggest what to check
- Greet warmly if greeted`;

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
        const skill = tu.input.skill || tu.input.query_type || '';
        const start = Date.now();
        log('info', tu.name, 'called', { skill, input_keys: Object.keys(tu.input) });
        let result;
        try {
          if      (tu.name === 'email_agent')     result = await emailAgent(tu.input);
          else if (tu.name === 'invoice_agent')   result = await invoiceAgent(tu.input);
          else if (tu.name === 'cash_flow_agent') result = await cashFlowAgent(tu.input);
          else if (tu.name === 'customer_agent')  result = await customerAgent(tu.input);
          else if (tu.name === 'expense_agent')   result = await expenseAgent(tu.input);
          else if (tu.name === 'receipt_agent')   result = await receiptAgent(tu.input);
          else { result = { error: `Unknown agent: ${tu.name}` }; log('warn', tu.name, 'unknown agent'); }
          log('info', tu.name, 'completed', { skill, ms: Date.now() - start });
        } catch(e) {
          log('error', tu.name, 'failed', { skill, error: e.message, ms: Date.now() - start });
          result = { error: `${tu.name} (${skill}) failed: ${e.message}` };
        }
        toolResults.push({ type:'tool_result', tool_use_id:tu.id, content:JSON.stringify(result) });
      }

      const final = await axios.post('https://api.anthropic.com/v1/messages', {
        model:'claude-opus-4-8', max_tokens:512, system:SYSTEM, tools,
        messages: [...messages, { role:'assistant', content:firstContent }, { role:'user', content:toolResults }]
      }, { headers:{'x-api-key':CLAUDE_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'} });

      const answer = final.data.content.find(c=>c.type==='text')?.text || 'I could not find that information.';
      log('info', 'jennifer', 'answered', { agents: agentsUsed });
      return res.json({ answer, agents: agentsUsed });
    }

    const answer = firstContent.find(c=>c.type==='text')?.text || 'I could not process that.';
    log('info', 'jennifer', 'answered (no agents called)', {});
    res.json({ answer, agents: [] });

  } catch(e) {
    log('error', 'jennifer', 'request failed', { error: e.response?.data?.error?.message || e.message });
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

// ════════════════════════════════════════════════════════════════════════════
//  RECEIPT EMAIL AUTOMATION — Extract + Approve + Post to QuickBooks
// ════════════════════════════════════════════════════════════════════════════

// ── POST /api/extract-receipt — thin wrapper, delegates to receiptAgent (single source of truth)
app.post('/api/extract-receipt', requireApiKey, async (req, res) => {
  const { email_body, email_subject, email_from } = req.body;
  if (!email_body) return res.status(400).json({ error: 'email_body required' });
  try {
    const receipt = await receiptAgent({ skill: 'extract', email_text: email_body, email_from, email_subject });
    res.json({ success: true, receipt });
  } catch (e) {
    console.error('Extract receipt error:', e.message);
    res.status(500).json({ success: false, error: e.message, receipt: { is_receipt: false } });
  }
});

// ── POST /api/approve-expense — thin wrapper, delegates to receiptAgent (single source of truth)
app.post('/api/approve-expense', requireApiKey, async (req, res) => {
  const { vendor, amount, date, description } = req.body;
  try {
    const decision = await receiptAgent({ skill: 'categorize', vendor, amount, date, description });
    res.json({ approved: true, ...decision });
  } catch (e) {
    console.error('Approve expense error:', e.message);
    res.status(500).json({ approved: false, error: e.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ QuickBooks Dashboard running on port ${PORT}`));
