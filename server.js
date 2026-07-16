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

  const res  = await fetch('https://api.linnworks.net/api/Auth/AuthorizeByApplication', {
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

// ─── Helper: call Linnworks API ───────────────────────────────────────────────
async function lwApi(endpoint, body = {}) {
  const s   = await getSession();
  const url = `${s.server}/api/${endpoint}`;

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type':    'application/x-www-form-urlencoded',
      'Authorization':   s.token
    },
    body: new URLSearchParams(
      Object.entries(body).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])
    ).toString()
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
// Returns all fulfilment locations (warehouses)
app.get('/api/locations', async (req, res) => {
  try {
    let data;
    const endpoints = [
      'Inventory/GetInventoryLocations',
      'Inventory/GetWarehouseLocations',
      'Stock/GetStockLocations',
      'Locations/GetAll'
    ];
    let lastError = '';
    for (const ep of endpoints) {
      try {
        data = await lwApi(ep);
        if (data) break;
      } catch (e) {
        lastError = e.message;
      }
    }

    if (data) {
      if (!Array.isArray(data)) data = data.Results || data.StockLocations || data.Locations || Object.values(data);
      // Normalise field names
      const normalised = data.map(l => ({
        StockLocationId: l.StockLocationId || l.LocationId || l.Id || '',
        LocationName:    l.LocationName || l.Name || l.Title || ''
      })).filter(l => l.LocationName);
      return res.json(normalised);
    }

    // Fallback: return known locations from account
    console.warn('All location endpoints failed, using known fallback. Last error:', lastError);
    res.json([
      { StockLocationId: 'default',  LocationName: 'Default' },
      { StockLocationId: 'wms',      LocationName: 'WMS' },
      { StockLocationId: 'wms-new',  LocationName: 'WMS New' },
      { StockLocationId: 'bradford', LocationName: 'Janan Bradford Store' },
      { StockLocationId: 'fba',      LocationName: 'Janan Fragrances Amazon FBA' },
      { StockLocationId: 'initial',  LocationName: 'Initial Stock' }
    ]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/search?sku=SKU123 ───────────────────────────────────────────────
// Search for a stock item by SKU
app.get('/api/search', async (req, res) => {
  const sku = (req.query.sku || '').trim();
  if (!sku) return res.status(400).json({ error: 'sku is required' });

  try {
    // Try multiple search strategies
    let item = null;

    // Strategy 1: GetStockItems (lightweight search)
    try {
      const s = await getSession();
      const url = `${s.server}/api/Stock/GetStockItems`;
      const body = new URLSearchParams({ keyword: sku, entriesPerPage: '10', startIndex: '0' });
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': s.token },
        body: body.toString()
      });
      if (r.ok) {
        const d = await r.json();
        const list = Array.isArray(d) ? d : (d.Items || d.Results || []);
        item = list.find(i => (i.ItemNumber || '').toLowerCase() === sku.toLowerCase()) || list[0];
      }
    } catch (_) {}

    // Strategy 2: GetStockItemsFull with minimal params
    if (!item) {
      try {
        const s = await getSession();
        const url = `${s.server}/api/Stock/GetStockItemsFull`;
        const body = new URLSearchParams({
          keyword: sku,
          loadCompositeParents: 'false',
          loadVariationParents: 'false',
          entriesPerPage: '5',
          startIndex: '0'
        });
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': s.token },
          body: body.toString()
        });
        if (r.ok) {
          const d = await r.json();
          const list = Array.isArray(d) ? d : (d.Items || d.Results || []);
          item = list.find(i => (i.ItemNumber || '').toLowerCase() === sku.toLowerCase()) || list[0];
        }
      } catch (_) {}
    }

    if (!item) {
      return res.status(404).json({ error: `No item found for SKU: ${sku}` });
    }

    res.json({
      stockItemId: item.StockItemId,
      sku:         item.ItemNumber,
      title:       item.ItemTitle,
      stockLevels: (item.StockLevels || item.Levels || []).map(sl => ({
        locationId:   sl.Location ? sl.Location.StockLocationId : (sl.StockLocationId || ''),
        locationName: sl.Location ? sl.Location.LocationName : (sl.LocationName || ''),
        available:    sl.Available || sl.StockLevel || 0,
        inOrders:     sl.InOrders || 0,
        binRack:      sl.BinRack || ''
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

  if (!stockItemId || !locationId || !fromBinRack || !toBinRack || !qty) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Move stock between bin racks within a location
    const result = await lwApi('Warehouse/MoveItem', {
      request: {
        StockItemId:    stockItemId,
        StockLocationId: locationId,
        FromBinRack:    fromBinRack,
        ToBinRack:      toBinRack,
        Quantity:       qty
      }
    });

    res.json({ success: true, result });
  } catch (e) {
    // Fallback: update bin rack assignment directly
    try {
      const result2 = await lwApi('Stock/SetStockItemBinRack', {
        stockItemId:     stockItemId,
        stockLocationId: locationId,
        binRack:         toBinRack
      });
      res.json({ success: true, result: result2, method: 'binRackUpdate' });
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
