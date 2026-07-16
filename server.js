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
    // Try multiple endpoint variations
    let data;
    try {
      data = await lwApi('Inventory/GetWarehouseLocations');
    } catch (e1) {
      try {
        data = await lwApi('Stock/GetStockLocations');
      } catch (e2) {
        data = await lwApi('Locations/GetAll');
      }
    }
    // Normalise to array of { StockLocationId, LocationName }
    if (!Array.isArray(data)) data = data.Results || data.StockLocations || [];
    res.json(data);
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
    const data = await lwApi('Stock/GetStockItemsFull', {
      searchField: 'SKU',
      searchTerm:  sku,
      pageSize:    5,
      pageNumber:  1
    });

    if (!data || data.length === 0) {
      return res.status(404).json({ error: `No item found for SKU: ${sku}` });
    }

    // Return the first match with its stock levels and bin racks
    const item = data[0];
    res.json({
      stockItemId: item.StockItemId,
      sku:         item.ItemNumber,
      title:       item.ItemTitle,
      stockLevels: (item.StockLevels || []).map(sl => ({
        locationId:   sl.Location.StockLocationId,
        locationName: sl.Location.LocationName,
        available:    sl.Available,
        inOrders:     sl.InOrders,
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
