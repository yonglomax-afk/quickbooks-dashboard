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
  const { data } = await axios.get(`${SANDBOX_BASE}/${companyId}${path}?minorversion=65`, {
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

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ QuickBooks Dashboard running on port ${PORT}`));
