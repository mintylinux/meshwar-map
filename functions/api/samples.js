// Cloudflare Pages Function for handling wardrive samples
// Automatically deployed as /api/samples

export async function onRequestGet(context) {
  try {
    // Get samples from KV storage
    const samplesJson = await context.env.WARDRIVE_DATA.get('samples');
    
    if (!samplesJson) {
      return new Response(JSON.stringify({ samples: [] }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
    
    const samples = JSON.parse(samplesJson);
    
    return new Response(JSON.stringify({ samples }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    
    // Validate request
    if (!body.samples || !Array.isArray(body.samples)) {
      return new Response(JSON.stringify({ error: 'Invalid request: samples array required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    // Get existing samples
    const existingSamplesJson = await context.env.WARDRIVE_DATA.get('samples');
    let existingSamples = existingSamplesJson ? JSON.parse(existingSamplesJson) : [];
    
    // Add new samples
    const newSamples = body.samples.map(sample => ({
      nodeId: sample.nodeId,
      latitude: sample.latitude || sample.lat,
      longitude: sample.longitude || sample.lng,
      rssi: sample.rssi,
      snr: sample.snr,
      timestamp: sample.timestamp || new Date().toISOString(),
    }));
    
    // Merge with existing (keep last 10,000 samples)
    const allSamples = [...existingSamples, ...newSamples].slice(-10000);
    
    // Store back to KV
    await context.env.WARDRIVE_DATA.put('samples', JSON.stringify(allSamples));
    
    return new Response(JSON.stringify({ 
      success: true, 
      added: newSamples.length,
      total: allSamples.length 
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// Handle CORS preflight
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
