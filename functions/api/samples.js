// Cloudflare Pages Function for handling wardrive samples
// Automatically deployed as /api/samples
// Uses geohash-based SHARDED storage (shard:XXX keys) with time decay
// Implements server-side de-duplication using per-sample IDs stored in KV with TTL

// Shard prefix length: 3 chars = ~156km × 156km coverage areas
const SHARD_PREFIX_LEN = 3;

// Cells older than this are pruned from storage entirely
const EXPIRY_DAYS = 90;

function shardPrefix(hash) {
  return hash.substring(0, SHARD_PREFIX_LEN);
}

// Simple geohash encoder (precision 7 = ~153m squares)
function encodeGeohash(lat, lon, precision = 7) {
  const base32 = '0123456789bcdefghjkmnpqrstuvwxyz';
  let idx = 0;
  let bit = 0;
  let evenBit = true;
  let geohash = '';
  let latMin = -90, latMax = 90;
  let lonMin = -180, lonMax = 180;

  while (geohash.length < precision) {
    if (evenBit) {
      const lonMid = (lonMin + lonMax) / 2;
      if (lon > lonMid) {
        idx |= (1 << (4 - bit));
        lonMin = lonMid;
      } else {
        lonMax = lonMid;
      }
    } else {
      const latMid = (latMin + latMax) / 2;
      if (lat > latMid) {
        idx |= (1 << (4 - bit));
        latMin = latMid;
      } else {
        latMax = latMid;
      }
    }
    evenBit = !evenBit;

    if (bit < 4) {
      bit++;
    } else {
      geohash += base32[idx];
      bit = 0;
      idx = 0;
    }
  }

  return geohash;
}

// Calculate age in days
function ageInDays(timestamp) {
  const now = new Date();
  const sampleDate = new Date(timestamp);
  const diffMs = now - sampleDate;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

// Prune expired cells from a shard object (mutates in place, returns pruned count)
function pruneExpired(shard) {
  let pruned = 0;
  for (const hash of Object.keys(shard)) {
    if (ageInDays(shard[hash].lastUpdate) > EXPIRY_DAYS) {
      delete shard[hash];
      pruned++;
    }
  }
  return pruned;
}

// Apply time-based decay to existing coverage cell
function applyDecay(cell) {
  const age = ageInDays(cell.lastUpdate);

  let decayFactor = 1.0;
  if (age > 90) {
    decayFactor = 0.2;
  } else if (age > 30) {
    decayFactor = 0.5;
  } else if (age > 14) {
    decayFactor = 0.7;
  } else if (age > 7) {
    decayFactor = 0.85;
  }

  cell.received *= decayFactor;
  cell.lost *= decayFactor;

  return cell;
}

// Build shard index metadata for a single shard
function buildShardMeta(shardData, previousVersion) {
  const cells = Object.keys(shardData).length;
  const samples = Object.values(shardData).reduce((sum, c) => sum + (c.samples || 0), 0);
  const lastUpdate = Object.values(shardData).reduce(
    (latest, c) => (c.lastUpdate > latest ? c.lastUpdate : latest), ''
  );
  return {
    cells,
    samples,
    lastUpdate,
    version: (previousVersion || 0) + 1,
  };
}

// Aggregate samples by geohash
function aggregateSamples(samples) {
  const coverage = {};
  const now = new Date().toISOString();

  samples.forEach(sample => {
    const lat = sample.latitude || sample.lat;
    const lng = sample.longitude || sample.lng;

    if (!lat || !lng) return;

    const hash = encodeGeohash(lat, lng, 7);

    if (!coverage[hash]) {
      coverage[hash] = {
        received: 0,
        lost: 0,
        samples: 0,
        repeaters: {},
        firstSeen: sample.timestamp || now,
        lastUpdate: sample.timestamp || now,
        appVersion: sample.appVersion || 'unknown',
      };
    }

    // Skip GPS-only samples (no ping attempted)
    if (sample.pingSuccess === null || sample.pingSuccess === undefined) return;
    
    const success = sample.pingSuccess === true ||
                   (sample.nodeId && sample.nodeId !== 'Unknown');
    const failed = sample.pingSuccess === false;

    if (sample.appVersion && sample.timestamp >= coverage[hash].lastUpdate) {
      coverage[hash].appVersion = sample.appVersion;
    }

    if (success) {
      coverage[hash].received += 1;

      if (sample.nodeId && sample.nodeId !== 'Unknown') {
        const nodeId = sample.nodeId;
        const sampleTime = new Date(sample.timestamp || now).getTime();

        if (!coverage[hash].repeaters[nodeId] ||
            new Date(coverage[hash].repeaters[nodeId].lastSeen).getTime() < sampleTime) {
          coverage[hash].repeaters[nodeId] = {
            name: sample.repeaterName || nodeId,
            rssi: sample.rssi || null,
            snr: sample.snr || null,
            lastSeen: sample.timestamp || now,
          };
        }
      }
    } else if (failed) {
      coverage[hash].lost += 1;
    }

    coverage[hash].samples += 1;

    if (sample.timestamp > coverage[hash].lastUpdate) {
      coverage[hash].lastUpdate = sample.timestamp;
    }
  });

  return coverage;
}

function computeSampleId(sample) {
  if (sample.id) return String(sample.id);
  const lat = sample.latitude ?? sample.lat;
  const lng = sample.longitude ?? sample.lng;
  const ts = sample.timestamp || '';
  const node = sample.nodeId || '';
  const key = `${lat?.toFixed?.(6)}|${lng?.toFixed?.(6)}|${ts}|${node}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) - h) + key.charCodeAt(i);
    h |= 0;
  }
  return `h${Math.abs(h)}`;
}

// ==================== GET ====================
export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const prefixes = url.searchParams.get('prefixes');

    // Global version for ETag
    const version = await context.env.WARDRIVE_DATA.get('coverage_version') || '0';
    const etag = `"v${version}"`;

    const ifNoneMatch = context.request.headers.get('If-None-Match');
    if (ifNoneMatch === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          'ETag': etag,
          'Cache-Control': 'public, max-age=10',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    const commonHeaders = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'ETag': etag,
      'Cache-Control': 'public, max-age=10',
    };

    // --- Fetch specific shards by prefix ---
    if (prefixes) {
      const prefixList = prefixes.split(',').filter(Boolean);
      const results = await Promise.all(
        prefixList.map(p => context.env.WARDRIVE_DATA.get(`shard:${p}`))
      );

      const coverage = {};
      results.forEach(json => {
        if (json) Object.assign(coverage, JSON.parse(json));
      });

      return new Response(JSON.stringify({ coverage }), { headers: commonHeaders });
    }

    // --- Return shard index if available ---
    const indexJson = await context.env.WARDRIVE_DATA.get('shard_index');
    if (indexJson) {
      const index = JSON.parse(indexJson);
      let totalCells = 0, totalSamples = 0;
      Object.values(index).forEach(m => {
        totalCells += m.cells || 0;
        totalSamples += m.samples || 0;
      });

      return new Response(JSON.stringify({
        shards: index,
        version: parseInt(version),
        totalCells,
        totalSamples,
      }), { headers: commonHeaders });
    }

    // --- Legacy fallback: monolithic coverage key ---
    const coverageJson = await context.env.WARDRIVE_DATA.get('coverage');
    if (coverageJson) {
      return new Response(JSON.stringify({
        coverage: JSON.parse(coverageJson),
      }), { headers: commonHeaders });
    }

    // No data at all
    return new Response(JSON.stringify({
      shards: {},
      version: 0,
      totalCells: 0,
      totalSamples: 0,
    }), { headers: commonHeaders });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ==================== POST ====================
export async function onRequestPost(context) {
  try {
    const body = await context.request.json();

    if (!body.samples || !Array.isArray(body.samples)) {
      return new Response(JSON.stringify({ error: 'Invalid request: samples array required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // --- De-duplicate (in-batch + KV) ---
    const incoming = body.samples;
    const batchUnique = [];
    const batchIds = new Set();
    for (const s of incoming) {
      const sid = computeSampleId(s);
      if (batchIds.has(sid)) continue;
      batchIds.add(sid);
      batchUnique.push({ ...s, __id: sid });
    }

    const seenResults = await Promise.all(
      batchUnique.map(s => context.env.WARDRIVE_DATA.get(`seen:${s.__id}`))
    );
    const deduped = batchUnique.filter((s, idx) => !seenResults[idx]);

    // --- Aggregate new samples by geohash ---
    const newCoverage = aggregateSamples(deduped);

    // --- Group by shard prefix ---
    const affectedPrefixes = {};
    Object.entries(newCoverage).forEach(([hash, cell]) => {
      const prefix = shardPrefix(hash);
      if (!affectedPrefixes[prefix]) affectedPrefixes[prefix] = {};
      affectedPrefixes[prefix][hash] = cell;
    });

    const prefixKeys = Object.keys(affectedPrefixes);

    if (prefixKeys.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        samplesReceived: incoming.length,
        samplesDeduped: incoming.length,
        samplesProcessed: 0,
        cellsUpdated: 0,
        cellsCreated: 0,
        cellsPruned: 0,
        totalCells: 0,
      }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // --- Batch-read: shard index + affected shards + version ---
    const [indexJson, currentVersionStr, ...existingShards] = await Promise.all([
      context.env.WARDRIVE_DATA.get('shard_index'),
      context.env.WARDRIVE_DATA.get('coverage_version'),
      ...prefixKeys.map(p => context.env.WARDRIVE_DATA.get(`shard:${p}`)),
    ]);

    const shardIndex = indexJson ? JSON.parse(indexJson) : {};
    const currentVersion = parseInt(currentVersionStr || '0');

    let cellsUpdated = 0, cellsCreated = 0, cellsPruned = 0;
    const writes = [];

    prefixKeys.forEach((prefix, i) => {
      let existing = existingShards[i] ? JSON.parse(existingShards[i]) : {};
      const newCells = affectedPrefixes[prefix];

      // Prune expired cells from existing shard
      cellsPruned += pruneExpired(existing);

      // Apply decay to surviving cells
      Object.keys(existing).forEach(hash => applyDecay(existing[hash]));

      // Merge new cells (overwrite matching, add new)
      Object.entries(newCells).forEach(([hash, newCell]) => {
        if (existing[hash]) {
          existing[hash].received = newCell.received;
          existing[hash].lost = newCell.lost;
          existing[hash].samples = newCell.samples;
          existing[hash].repeaters = newCell.repeaters;
          existing[hash].lastUpdate = newCell.lastUpdate;
          existing[hash].appVersion = newCell.appVersion;
          cellsUpdated++;
        } else {
          existing[hash] = newCell;
          cellsCreated++;
        }
      });

      // Update shard index entry
      shardIndex[prefix] = buildShardMeta(existing, shardIndex[prefix]?.version);

      // Delete shard key if empty after pruning
      if (Object.keys(existing).length === 0) {
        writes.push(context.env.WARDRIVE_DATA.delete(`shard:${prefix}`));
        delete shardIndex[prefix];
      } else {
        writes.push(context.env.WARDRIVE_DATA.put(`shard:${prefix}`, JSON.stringify(existing)));
      }
    });

    // Write shard index + bump global version
    writes.push(context.env.WARDRIVE_DATA.put('shard_index', JSON.stringify(shardIndex)));
    writes.push(context.env.WARDRIVE_DATA.put('coverage_version', String(currentVersion + 1)));
    await Promise.all(writes);

    // Mark processed samples as seen (90-day TTL)
    try {
      const ttlSeconds = 60 * 60 * 24 * 90;
      await Promise.all(
        deduped.map(s => context.env.WARDRIVE_DATA.put(`seen:${s.__id}`, '1', { expirationTtl: ttlSeconds }))
      );
    } catch (seenError) {
      console.error('Failed to mark samples as seen:', seenError.message);
    }

    // Total cells from index
    let totalCells = 0;
    Object.values(shardIndex).forEach(m => { totalCells += m.cells || 0; });

    return new Response(JSON.stringify({
      success: true,
      samplesReceived: incoming.length,
      samplesDeduped: incoming.length - deduped.length,
      samplesProcessed: deduped.length,
      cellsUpdated,
      cellsCreated,
      cellsPruned,
      totalCells,
    }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ==================== DELETE ====================
export async function onRequestDelete(context) {
  try {
    const authHeader = context.request.headers.get('Authorization');
    const adminToken = context.env.ADMIN_TOKEN;

    if (!authHeader || authHeader !== `Bearer ${adminToken}`) {
      return new Response(JSON.stringify({
        error: 'Unauthorized: Invalid or missing authentication token',
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // Delete all shards listed in index
    const indexJson = await context.env.WARDRIVE_DATA.get('shard_index');
    if (indexJson) {
      const index = JSON.parse(indexJson);
      const deletes = Object.keys(index).map(p => context.env.WARDRIVE_DATA.delete(`shard:${p}`));
      deletes.push(context.env.WARDRIVE_DATA.delete('shard_index'));
      await Promise.all(deletes);
    }

    // Also delete legacy key if it exists
    await context.env.WARDRIVE_DATA.delete('coverage');

    return new Response(JSON.stringify({ success: true, message: 'All data cleared' }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ==================== CORS ====================
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
