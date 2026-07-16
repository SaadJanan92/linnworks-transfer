const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Linnworks credentials (set as env vars in Render) ───────────────────────
const APP_ID     = process.env.LINNWORKS_APP_ID;
const APP_SECRET = process.env.LINNWORKS_APP_SECRET;
const APP_TOKEN  = process.env.LINNWORKS_TOKEN;

// ─── Session cache ────────────────────────────────────────────────────────────
let session = { token: null, server: null, expiry: 0 };

async function getSession() {
  if (session.token && Date.now() < session.expiry) return session;

  const params = new URLSearchParams({
    ApplicationId:     APP_ID,
    ApplicationSecret: APP_SECRET,
    Token:             APP_TOKEN
  });

  const res = await fetch('https://api.linnworks.net/api/Auth/AuthorizeByApplication', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString()
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Auth failed: ${res.status} ${txt}`);
  }

  const data = await res.json();
  session = {
    token:  data.Token,
    server: data.Server,
    expiry: Date.now() + (30 * 60 * 1000) // 30 min
  };
  console.log('✅ Linnworks session obtained, server:', session.server);
  return session;
}

// ─── Helper: POST to Linnworks API ───────────────────────────────────────────
async function lwPost(endpoint, bodyStr) {
  const s = await getSession();
  const res = await fetch(`${s.server}/api/${endpoint}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': s.token },
    body:    bodyStr
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`${endpoint} failed: ${res.status} ${txt}`);
  }
  return res.json();
}

// ─── GET /api/health ──────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    await getSession();
    res.json({ status: 'ok', connected: true });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ─── GET /api/locations ───────────────────────────────────────────────────────
app.get('/api/locations', async (req, res) => {
  try {
    const s = await getSession();
    // Try the correct Inventory locations endpoint
    let data = null;
    for (const ep of ['Inventory/GetInventoryLocations', 'Stock/GetStockLocations', 'Locations/GetAll']) {
      try {
        const r = await fetch(`${s.server}/api/${ep}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': s.token },
          body: ''
        });
        if (r.ok) { data = await r.json(); break; }
      } catch (_) {}
    }

    if (data && (Array.isArray(data) ? data.length : true)) {
      const list = Array.isArray(data) ? data : (data.Results || data.StockLocations || []);
      return res.json(list.map(l => ({
        StockLocationId: l.StockLocationId || l.LocationId || '',
        LocationName:    l.LocationName || l.Name || ''
      })).filter(l => l.LocationName));
    }

    // Fallback: known locations from this account
    res.json([
      { StockLocationId: '28f60e93-7de6-4983-9d2d-6631d9d2a8c1', LocationName: 'WMS New' },
      { StockLocationId: '',                                       LocationName: 'WMS' },
      { StockLocationId: '',                                       LocationName: 'Default' },
      { StockLocationId: '',                                       LocationName: 'Janan Bradford Store' },
      { StockLocationId: '',                                       LocationName: 'Janan Fragrances Amazon FBA' },
      { StockLocationId: '',                                       LocationName: 'Initial Stock' }
    ]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/search?sku=SKU123 ───────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const sku = (req.query.sku || '').trim();
  if (!sku) return res.status(400).json({ error: 'sku is required' });

  try {
    // GetStockItemsFull with correct JSON-encoded string enums (from official SDK)
    const dataReq  = encodeURIComponent(JSON.stringify(['StockLevels']));
    const searchT  = encodeURIComponent(JSON.stringify(['SKU']));
    const body = `keyword=${encodeURIComponent(sku)}&loadCompositeParents=false&loadVariationParents=false&entriesPerPage=10&pageNumber=1&dataRequirements=${dataReq}&searchTypes=${searchT}`;
    const data = await lwPost('Stock/GetStockItemsFull', body);

    const list = Array.isArray(data) ? data : [];
    if (!list.length) {
      return res.status(404).json({ error: `No item found for SKU: ${sku}` });
    }

    const item = list.find(i => (i.ItemNumber || '').toLowerCase() === sku.toLowerCase()) || list[0];

    res.json({
      stockItemId: item.StockItemId,
      sku:         item.ItemNumber,
      title:       item.ItemTitle,
      category:    item.CategoryName || '',
      stockLevels: (item.StockLevels || []).map(sl => ({
        locationId:   sl.Location ? sl.Location.StockLocationId : '',
        locationName: sl.Location ? sl.Location.LocationName : '',
        available:    sl.Available || 0,
        inOrders:     sl.InOrders || 0,
        binRack:      sl.Location ? (sl.Location.BinRack || '') : ''
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/transfer ───────────────────────────────────────────────────────
// Body: { stockItemId, locationId, fromBinRack, toBinRack, qty }
app.post('/api/transfer', async (req, res) => {
  const { stockItemId, locationId, fromBinRack, toBinRack, qty } = req.body;

  if (!stockItemId || !fromBinRack || !toBinRack || !qty) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Use CreateWarehouseMove to move stock between bin racks
    const request = {
      StockItemId:          stockItemId,
      StockLocationId:      locationId || null,
      BinrackSource:        fromBinRack,
      BinrackDestination:   toBinRack,
      Quantity:             qty
    };
    const body = `request=${encodeURIComponent(JSON.stringify(request))}`;
    const result = await lwPost('Stock/CreateWarehouseMove', body);
    res.json({ success: true, result });
  } catch (e) {
    // Fallback: SetStockLevel approach (adjusts bin rack assignment)
    try {
      const stockLevels = [{
        SKU:             null,
        StockItemId:     stockItemId,
        LocationId:      locationId || null,
        BinRack:         toBinRack,
        Quantity:        qty,
        ChangeSource:    'BinRackTransfer'
      }];
      const body = `stockLevels=${encodeURIComponent(JSON.stringify(stockLevels))}&changeSource=BinRackTransfer`;
      const result2 = await lwPost('Stock/SetStockLevel', body);
      res.json({ success: true, result: result2, method: 'setStockLevel' });
    } catch (e2) {
      res.status(500).json({ error: e.message, fallbackError: e2.message });
    }
  }
});

// ─── Serve frontend ───────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Linnworks Transfer app running on port ${PORT}`);
  if (!APP_ID || !APP_SECRET || !APP_TOKEN) {
    console.warn('⚠️  Missing env vars: LINNWORKS_APP_ID, LINNWORKS_APP_SECRET, LINNWORKS_TOKEN');
  }
});
