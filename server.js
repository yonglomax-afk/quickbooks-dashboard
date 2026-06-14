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

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ QuickBooks Dashboard running on port ${PORT}`));
