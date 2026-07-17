const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Linnworks credentials ────────────────────────────────────────────────────
const APP_ID = process.env.LINNWORKS_APP_ID;
const APP_SECRET = process.env.LINNWORKS_APP_SECRET;
const APP_TOKEN = process.env.LINNWORKS_TOKEN;

// ─── MongoDB ──────────────────────────────────────────────────────────────────
const mongoClient = new MongoClient(process.env.MONGODB_URI);
let db, logsCol, sessionsCol;

async function connectDB() {
  await mongoClient.connect();
  db = mongoClient.db('linnworks');
  logsCol = db.collection('transfer_logs');
  sessionsCol = db.collection('sessions');
  // Index for fast date queries and auto-expiry of sessions
  await logsCol.createIndex({ timestamp: -1 });
  await sessionsCol.createIndex({ expiry: 1 }, { expireAfterSeconds: 0 });
  console.log('✅ MongoDB connected');
}

async function appendLog(entry) {
  try { await logsCol.insertOne(entry); } catch (e) { console.error('Log error:', e.message); }
}

async function readLog(limit = 50000) {
  try {
    return await logsCol.find({}, { projection: { _id: 0 } })
      .sort({ timestamp: -1 }).limit(limit).toArray();
  } catch (_) { return []; }
}

// ─── Staff session store — persisted in MongoDB so restarts don't log out ────
const activeSessions = new Map(); // in-memory cache

async function saveSessions() {
  for (const [token, session] of activeSessions) {
    await sessionsCol.updateOne({ token }, { $set: { token, ...session } }, { upsert: true });
  }
}

async function loadSessions() {
  try {
    const now = new Date();
    const docs = await sessionsCol.find({ expiry: { $gt: Date.now() } }).toArray();
    for (const doc of docs) {
      activeSessions.set(doc.token, { username: doc.username, displayName: doc.displayName, expiry: doc.expiry });
    }
    console.log(`Loaded ${activeSessions.size} active sessions from MongoDB`);
  } catch (_) {}
}

// ─── POST /api/login ──────────────────────────────────────────────────────────
// Validates against STAFF_USERS env var set in Render
// Format: {"ali":{"password":"1234","displayName":"Ali Khan"},"sara":{"password":"5678","displayName":"Sara Ahmed"}}
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  let users = {};
  try { users = JSON.parse(process.env.STAFF_USERS || '{}'); } catch (_) {
    return res.status(500).json({ error: 'Staff users not configured — contact admin' });
  }

  const user = users[username.toLowerCase()];
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Wrong username or password' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const sessionData = {
    username: username.toLowerCase(),
    displayName: user.displayName || username,
    expiry: Date.now() + 8 * 60 * 60 * 1000
  };
  activeSessions.set(token, sessionData);
  // Save to MongoDB async (don't await)
  sessionsCol.updateOne({ token }, { $set: { token, ...sessionData } }, { upsert: true }).catch(() => {});

  res.json({ token, displayName: user.displayName || username });
});

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  const session = token && activeSessions.get(token);
  if (!session || Date.now() > session.expiry) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  req.user = session;
  next();
}

// ─── POST /api/logout ────────────────────────────────────────────────────────
app.post('/api/logout', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token) {
    activeSessions.delete(token);
    sessionsCol.deleteOne({ token }).catch(() => {});
  }
  res.json({ ok: true });
});

// ─── GET /api/logs ────────────────────────────────────────────────────────────
app.get('/api/logs', requireAuth, async (req, res) => {
  const limit = parseInt(req.query.limit) || 50000;
  const log = await readLog(limit);
  res.json(log);
});

// ─── Linnworks session cache ──────────────────────────────────────────────────
let session = { token: null, server: null, expiry: 0 };

async function getSession() {
  if (session.token && Date.now() < session.expiry) return session;

  const params = new URLSearchParams({
    ApplicationId: APP_ID,
    ApplicationSecret: APP_SECRET,
    Token: APP_TOKEN
  });

  const res = await fetch('https://api.linnworks.net/api/Auth/AuthorizeByApplication', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Auth failed: ${res.status} ${txt}`);
  }

  const data = await res.json();
  session = {
    token: data.Token,
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
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': s.token },
    body: bodyStr
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`${endpoint} failed: ${res.status} ${txt}`);
  }
  return res.json();
}

// ─── GET /api/health ──────────────────────────────────────────────────────────
app.get('/api/health', requireAuth, async (req, res) => {
  try {
    await getSession();
    res.json({ status: 'ok', connected: true, user: req.user.displayName });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ─── GET /api/locations ───────────────────────────────────────────────────────
app.get('/api/locations', requireAuth, async (req, res) => {
  try {
    const s = await getSession();
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
        LocationName: l.LocationName || l.Name || ''
      })).filter(l => l.LocationName));
    }

    res.json([
      { StockLocationId: '28f60e93-7de6-4983-9d2d-6631d9d2a8c1', LocationName: 'WMS New' },
      { StockLocationId: '', LocationName: 'WMS' },
      { StockLocationId: '', LocationName: 'Default' },
      { StockLocationId: '', LocationName: 'Janan Bradford Store' },
      { StockLocationId: '', LocationName: 'Janan Fragrances Amazon FBA' },
      { StockLocationId: '', LocationName: 'Initial Stock' }
    ]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/search?sku=SKU123 ───────────────────────────────────────────────
app.get('/api/search', requireAuth, async (req, res) => {
  const sku = (req.query.sku || '').trim();
  if (!sku) return res.status(400).json({ error: 'sku is required' });

  try {
    const dataReq = encodeURIComponent(JSON.stringify(['StockLevels']));
    let list = [];

    for (const searchType of ['SKU', 'Barcode']) {
      const searchT = encodeURIComponent(JSON.stringify([searchType]));
      const body = `keyword=${encodeURIComponent(sku)}&loadCompositeParents=false&loadVariationParents=false&entriesPerPage=10&pageNumber=1&dataRequirements=${dataReq}&searchTypes=${searchT}`;
      try {
        const data = await lwPost('Stock/GetStockItemsFull', body);
        if (Array.isArray(data) && data.length) { list = data; break; }
      } catch (_) {}
    }

    if (!list.length) {
      return res.status(404).json({ error: `No item found for SKU/barcode: ${sku}` });
    }

    const item = list.find(i =>
      (i.ItemNumber || '').toLowerCase() === sku.toLowerCase() ||
      (i.BarcodeNumber || '').toLowerCase() === sku.toLowerCase()
    ) || list[0];

    res.json({
      stockItemId: item.StockItemId,
      sku: item.ItemNumber,
      title: item.ItemTitle,
      category: item.CategoryName || '',
      stockLevels: (item.StockLevels || []).map(sl => ({
        locationId: sl.Location ? sl.Location.StockLocationId : '',
        locationName: sl.Location ? sl.Location.LocationName : '',
        available: sl.Available || 0,
        inOrders: sl.InOrders || 0,
        binRack: sl.Location ? (sl.Location.BinRack || '') : ''
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/binrack-items?locationId=&binRack= ─────────────────────────────
app.get('/api/binrack-items', requireAuth, async (req, res) => {
  const { locationId, binRack } = req.query;
  if (!locationId || !binRack) return res.status(400).json({ error: 'locationId and binRack required' });

  try {
    const searchRes = await lwPost('Stock/SearchBinracks',
      `request=${encodeURIComponent(JSON.stringify({ BinRack: binRack, LocationId: locationId, StockItemId: '00000000-0000-0000-0000-000000000000', PageNumber: 1 }))}`
    );
    const binRacks = searchRes.BinRacks || [];
    const found = binRacks.find(b => b.BinRack === binRack) || binRacks[0];
    if (!found) return res.status(404).json({ error: `Bin rack "${binRack}" not found` });

    const skuRes = await lwPost('Stock/GetBinrackSkus',
      `request=${encodeURIComponent(JSON.stringify({ BinRackId: found.BinRackId, DetailLevel: [] }))}`
    );

    const items = {};
    for (const batch of (skuRes.Skus || [])) {
      for (const inv of (batch.Inventory || [])) {
        if (!inv.IsDeleted && inv.BinRackId === found.BinRackId) {
          const id = String(batch.StockItemId).toLowerCase();
          items[id] = { qty: (items[id] ? items[id].qty : 0) + inv.Quantity, sku: batch.SKU };
        }
      }
    }
    res.json({ binRackId: found.BinRackId, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/transfer-debug ──────────────────────────────────────────────────
app.get('/api/transfer-debug', requireAuth, async (req, res) => {
  const { stockItemId, locationId, fromBinRack, toBinRack } = req.query;
  const results = {};
  try {
    try {
      const r = await lwPost('Stock/SearchBinracks',
        `request=${encodeURIComponent(JSON.stringify({ BinRack: fromBinRack, LocationId: locationId, StockItemId: stockItemId, PageNumber: 1 }))}`
      );
      results.step1_sourceBinRack = r;
    } catch(e) { results.step1_sourceBinRack = { error: e.message }; }

    try {
      const r = await lwPost('Stock/SearchBinracks',
        `request=${encodeURIComponent(JSON.stringify({ BinRack: toBinRack, LocationId: locationId, StockItemId: stockItemId, PageNumber: 1 }))}`
      );
      results.step2_destBinRack = r;
    } catch(e) { results.step2_destBinRack = { error: e.message }; }

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

    results.step4_ready = batchInventoryId && dstBinRacks && dstBinRacks.length ? {
      ready: true,
      BatchInventoryId: batchInventoryId,
      dstBinRackId: dstBinRacks[0].BinRackId
    } : { ready: false };

    res.json(results);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/transfer ───────────────────────────────────────────────────────
app.post('/api/transfer', requireAuth, async (req, res) => {
  const { stockItemId, locationId, fromBinRack, toBinRack, qty, sku, title, transferId } = req.body;
  if (!stockItemId || !locationId || !fromBinRack || !toBinRack || !qty) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const srcRes = await lwPost('Stock/SearchBinracks',
      `request=${encodeURIComponent(JSON.stringify({ BinRack: fromBinRack, LocationId: locationId, StockItemId: stockItemId, PageNumber: 1 }))}`
    );
    const srcBinRacks = srcRes.BinRacks || [];
    const srcBinRack = srcBinRacks.find(b => b.BinRack === fromBinRack) || srcBinRacks[0];
    if (!srcBinRack) return res.status(404).json({ error: `Source bin rack "${fromBinRack}" not found in WMS` });
    const srcId = srcBinRack.BinRackId;

    const dstRes = await lwPost('Stock/SearchBinracks',
      `request=${encodeURIComponent(JSON.stringify({ BinRack: toBinRack, LocationId: locationId, StockItemId: stockItemId, PageNumber: 1 }))}`
    );
    const dstBinRacks = dstRes.BinRacks || [];
    const dstBinRack = dstBinRacks.find(b => b.BinRack === toBinRack) || dstBinRacks[0];
    if (!dstBinRack) return res.status(404).json({ error: `Destination bin rack "${toBinRack}" not found in WMS` });
    const dstId = dstBinRack.BinRackId;

    const skuRes = await lwPost('Stock/GetBinrackSkus',
      `request=${encodeURIComponent(JSON.stringify({ BinRackId: srcId, DetailLevel: [] }))}`
    );
    const skus = skuRes.Skus || [];

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

    const staffName = req.user ? req.user.displayName : 'Unknown';
    const moveRes = await lwPost('Stock/CreateWarehouseMove',
      `request=${encodeURIComponent(JSON.stringify({ BatchInventoryId: batchInventoryId, BinrackIdDestination: dstId, Quantity: qty, TxType: 'InTransit', Note: `Transferred by: ${staffName}`, Notes: `Transferred by: ${staffName}`, UserName: staffName, ChangeNote: `Transferred by: ${staffName}` }))}`
    );

    const moveId = moveRes.WarehouseMove && moveRes.WarehouseMove.MoveId;
    if (moveId) {
      try {
        await lwPost('Stock/CompleteWarehouseMove',
          `request=${encodeURIComponent(JSON.stringify({ MoveId: moveId }))}`
        );
      } catch (e2) {
        try {
          await lwPost('Stock/CompleteWarehouseMove',
            `request=${encodeURIComponent(JSON.stringify({ WarehouseMoveId: moveId }))}`
          );
        } catch (_) {}
      }
    }

    // ── Log the transfer ───────────────────────────────────────────────────────
    appendLog({
      timestamp: new Date().toISOString(),
      user: req.user ? req.user.displayName : 'Unknown',
      transferId: transferId || null,
      fromBinRack,
      toBinRack,
      qty,
      sku: sku || stockItemId,
      title: title || '',
      moveId: moveId || null
    });

    res.json({ success: true, srcBinRackId: srcId, dstBinRackId: dstId, batchInventoryId, moveId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/transfer-batch ─────────────────────────────────────────────────
// Body: { fromBinRack, toBinRack, locationId, transferId, items: [{stockItemId, qty, sku, title}] }
// Looks up bin racks ONCE, gets all skus ONCE, then moves all items in parallel
app.post('/api/transfer-batch', requireAuth, async (req, res) => {
  const { fromBinRack, toBinRack, locationId, transferId, items } = req.body;
  if (!fromBinRack || !toBinRack || !locationId || !items || !items.length) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // ── Step 1: Look up source + destination bin racks ONCE ───────────────────
    const [srcRes, dstRes] = await Promise.all([
      lwPost('Stock/SearchBinracks', `request=${encodeURIComponent(JSON.stringify({ BinRack: fromBinRack, LocationId: locationId, StockItemId: '00000000-0000-0000-0000-000000000000', PageNumber: 1 }))}`),
      lwPost('Stock/SearchBinracks', `request=${encodeURIComponent(JSON.stringify({ BinRack: toBinRack, LocationId: locationId, StockItemId: '00000000-0000-0000-0000-000000000000', PageNumber: 1 }))}`),
    ]);

    const srcBinRack = (srcRes.BinRacks || []).find(b => b.BinRack === fromBinRack) || (srcRes.BinRacks || [])[0];
    const dstBinRack = (dstRes.BinRacks || []).find(b => b.BinRack === toBinRack) || (dstRes.BinRacks || [])[0];
    if (!srcBinRack) return res.status(404).json({ error: `Source bin rack "${fromBinRack}" not found` });
    if (!dstBinRack) return res.status(404).json({ error: `Destination bin rack "${toBinRack}" not found` });

    const srcId = srcBinRack.BinRackId;
    const dstId = dstBinRack.BinRackId;

    // ── Step 2: Get all SKUs in source bin rack ONCE ──────────────────────────
    const skuRes = await lwPost('Stock/GetBinrackSkus', `request=${encodeURIComponent(JSON.stringify({ BinRackId: srcId, DetailLevel: [] }))}`);
    const skus = skuRes.Skus || [];

    // Build map: stockItemId → batchInventoryId
    const batchMap = {};
    for (const batch of skus) {
      const id = String(batch.StockItemId).toLowerCase();
      for (const inv of (batch.Inventory || [])) {
        if (!inv.IsDeleted && inv.BinRackId === srcId) {
          batchMap[id] = inv.BatchInventoryId;
          break;
        }
      }
    }

    const staffName = req.user ? req.user.displayName : 'Unknown';

    // ── Step 3: Move all items in parallel ────────────────────────────────────
    const results = await Promise.all(items.map(async item => {
      const batchInventoryId = batchMap[String(item.stockItemId).toLowerCase()];
      if (!batchInventoryId) return { idx: item.idx, sku: item.sku, success: false, error: `Not found in bin rack "${fromBinRack}"` };

      try {
        const moveRes = await lwPost('Stock/CreateWarehouseMove',
          `request=${encodeURIComponent(JSON.stringify({ BatchInventoryId: batchInventoryId, BinrackIdDestination: dstId, Quantity: item.qty, TxType: 'InTransit' }))}`
        );
        const moveId = moveRes.WarehouseMove && moveRes.WarehouseMove.MoveId;
        if (moveId) {
          await lwPost('Stock/CompleteWarehouseMove', `request=${encodeURIComponent(JSON.stringify({ MoveId: moveId }))}`).catch(() =>
            lwPost('Stock/CompleteWarehouseMove', `request=${encodeURIComponent(JSON.stringify({ WarehouseMoveId: moveId }))}`)
          );
        }
        appendLog({ timestamp: new Date().toISOString(), user: staffName, transferId: transferId || null, fromBinRack, toBinRack, qty: item.qty, sku: item.sku, title: item.title, moveId: moveId || null });
        return { idx: item.idx, sku: item.sku, success: true };
      } catch (e) {
        return { idx: item.idx, sku: item.sku, success: false, error: e.message };
      }
    }));

    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Serve frontend ───────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start server after MongoDB connects ──────────────────────────────────────
connectDB().then(async () => {
  await loadSessions();
  app.listen(PORT, () => {
    console.log(`🚀 Linnworks Transfer app running on port ${PORT}`);
    if (!APP_ID || !APP_SECRET || !APP_TOKEN) {
      console.warn('⚠️ Missing env vars: LINNWORKS_APP_ID, LINNWORKS_APP_SECRET, LINNWORKS_TOKEN');
    }
  });
}).catch(err => {
  console.error('❌ Failed to connect to MongoDB:', err.message);
  process.exit(1);
});
