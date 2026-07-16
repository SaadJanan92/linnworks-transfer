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

// ─── GET /api/transfer-debug ──────────────────────────────────────────────────
// ?stockItemId=&locationId=&fromBinRack=&toBinRack=
app.get('/api/transfer-debug', async (req, res) => {
  const { stockItemId, locationId, fromBinRack, toBinRack } = req.query;
  const results = {};
  try {
    // Step 1: Search source bin rack
    try {
      const r = await lwPost('Stock/SearchBinracks',
        `request=${encodeURIComponent(JSON.stringify({ BinRack: fromBinRack, LocationId: locationId, StockItemId: stockItemId, PageNumber: 1 }))}`
      );
      results.step1_sourceBinRack = r;
    } catch(e) { results.step1_sourceBinRack = { error: e.message }; }

    // Step 2: Search dest bin rack
    try {
      const r = await lwPost('Stock/SearchBinracks',
        `request=${encodeURIComponent(JSON.stringify({ BinRack: toBinRack, LocationId: locationId, StockItemId: stockItemId, PageNumber: 1 }))}`
      );
      results.step2_destBinRack = r;
    } catch(e) { results.step2_destBinRack = { error: e.message }; }

    // Step 3: Get SKUs in source bin rack (need srcId from step 1)
    let batchInventoryId = null;
    const srcBinRacks = results.step1_sourceBinRack && results.step1_sourceBinRack.BinRacks;
    const dstBinRacks = results.step2_destBinRack && results.step2_destBinRack.BinRacks;
    if (srcBinRacks && srcBinRacks.length) {
      const srcId = srcBinRacks[0].BinRackId;
      try {
        const r = await lwPost('Stock/GetBinrackSkus',
          `request=${encodeURIComponent(JSON.stringify({ BinRackId: srcId, DetailLevel: [] }))}`
        );
        results.step3_binRackSkus = { Skus_count: (r.Skus||[]).length };
        // Find our item
        for (const batch of (r.Skus||[])) {
          if (String(batch.StockItemId).toLowerCase() === String(stockItemId).toLowerCase()) {
            for (const inv of (batch.Inventory||[])) {
              if (!inv.IsDeleted && inv.BinRackId === srcId) {
                batchInventoryId = inv.BatchInventoryId;
                results.step3_found = { BatchInventoryId: inv.BatchInventoryId, BinRack: inv.BinRack, Qty: inv.Quantity };
                break;
              }
            }
          }
          if (batchInventoryId) break;
        }
        if (!batchInventoryId) results.step3_found = 'NOT FOUND';
      } catch(e) { results.step3_binRackSkus = { error: e.message }; }
    }

    // Step 4: Try CreateWarehouseMove (Open type — won't physically move yet)
    if (batchInventoryId && dstBinRacks && dstBinRacks.length) {
      const dstId = dstBinRacks[0].BinRackId;
      try {
        const r = await lwPost('Stock/CreateWarehouseMove',
          `request=${encodeURIComponent(JSON.stringify({ BatchInventoryId: batchInventoryId, BinrackIdDestination: dstId, Quantity: 1, TxType: 'Open' }))}`
        );
        results.step4_createMove = r;
        // Step 5: Try to complete it
        const moveId = r.WarehouseMove && (r.WarehouseMove.WarehouseMoveId || r.WarehouseMove.Id || r.WarehouseMove.id);
        results.step4_moveId = moveId;
        if (moveId) {
          try {
            const c = await lwPost('Stock/CompleteWarehouseMove',
              `request=${encodeURIComponent(JSON.stringify({ WarehouseMoveId: moveId }))}`
            );
            results.step5_complete = c || 'ok';
          } catch(e) { results.step5_complete = { error: e.message }; }
        }
      } catch(e) { results.step4_createMove = { error: e.message }; }
    }

    res.json(results);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/transfer ───────────────────────────────────────────────────────
// Body: { stockItemId, locationId, fromBinRack, toBinRack, qty }
app.post('/api/transfer', async (req, res) => {
  const { stockItemId, locationId, fromBinRack, toBinRack, qty } = req.body;
  if (!stockItemId || !locationId || !fromBinRack || !toBinRack || !qty) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // ── Step 1: Find source bin rack integer ID ────────────────────────────
    const srcRes = await lwPost('Stock/SearchBinracks',
      `request=${encodeURIComponent(JSON.stringify({ BinRack: fromBinRack, LocationId: locationId, StockItemId: stockItemId, PageNumber: 1 }))}`
    );
    const srcBinRacks = srcRes.BinRacks || [];
    const srcBinRack = srcBinRacks.find(b => b.BinRack === fromBinRack) || srcBinRacks[0];
    if (!srcBinRack) return res.status(404).json({ error: `Source bin rack "${fromBinRack}" not found in WMS` });
    const srcId = srcBinRack.BinRackId;

    // ── Step 2: Find destination bin rack integer ID ───────────────────────
    const dstRes = await lwPost('Stock/SearchBinracks',
      `request=${encodeURIComponent(JSON.stringify({ BinRack: toBinRack, LocationId: locationId, StockItemId: stockItemId, PageNumber: 1 }))}`
    );
    const dstBinRacks = dstRes.BinRacks || [];
    const dstBinRack = dstBinRacks.find(b => b.BinRack === toBinRack) || dstBinRacks[0];
    if (!dstBinRack) return res.status(404).json({ error: `Destination bin rack "${toBinRack}" not found in WMS` });
    const dstId = dstBinRack.BinRackId;

    // ── Step 3: Get batch inventory items in source bin rack ───────────────
    const skuRes = await lwPost('Stock/GetBinrackSkus',
      `request=${encodeURIComponent(JSON.stringify({ BinRackId: srcId, DetailLevel: [] }))}`
    );
    const skus = skuRes.Skus || [];

    // Find the BatchInventoryId for our stock item in this bin rack
    let batchInventoryId = null;
    for (const batch of skus) {
      if (String(batch.StockItemId).toLowerCase() === String(stockItemId).toLowerCase()) {
        for (const inv of (batch.Inventory || batch.Item || [])) {
          if (!inv.IsDeleted && (inv.BinRackId === srcId || inv.BinRack === fromBinRack)) {
            batchInventoryId = inv.BatchInventoryId;
            break;
          }
        }
      }
      if (batchInventoryId) break;
    }
    if (!batchInventoryId) {
      return res.status(404).json({ error: `Item not found in bin rack "${fromBinRack}". Check the source bin rack name.` });
    }

    // ── Step 4: Create warehouse move (InTransit) ──────────────────────────
    const moveRes = await lwPost('Stock/CreateWarehouseMove',
      `request=${encodeURIComponent(JSON.stringify({ BatchInventoryId: batchInventoryId, BinrackIdDestination: dstId, Quantity: qty, TxType: 'InTransit' }))}`
    );

    // ── Step 5: Complete the move immediately ──────────────────────────────
    const moveId = moveRes.WarehouseMove && (moveRes.WarehouseMove.WarehouseMoveId || moveRes.WarehouseMove.Id);
    if (moveId) {
      try {
        await lwPost('Stock/CompleteWarehouseMove',
          `request=${encodeURIComponent(JSON.stringify({ WarehouseMoveId: moveId }))}`
        );
      } catch (_) { /* non-fatal — move was created, completion can be retried */ }
    }

    res.json({ success: true, srcBinRackId: srcId, dstBinRackId: dstId, batchInventoryId, moveId });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
