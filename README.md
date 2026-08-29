# MeshCore Wardrive Map

Live web map for displaying MeshCore wardrive data collected from your Flutter app.

## Features

- 🗺️ Dark theme map (CartoDB Dark Matter tiles)
- 📡 Real-time sample display with GPS locations
- 📊 Statistics panel (total samples, unique nodes, avg RSSI)
- 🔄 Auto-refresh every 30 seconds
- ☁️ Cloudflare Pages hosting (free)
- 💾 KV storage for data persistence

## Deployment Steps

### 1. Initialize Git Repository

```bash
cd /home/chuck/Desktop/meshcore-map-site
git init
git add .
git commit -m "Initial commit: MeshCore wardrive map"
```

### 2. Push to GitHub

```bash
# Create a new repo on GitHub (https://github.com/new)
# Name it: meshcore-map (or whatever you prefer)
# Then push:

git remote add origin https://github.com/YOUR_USERNAME/meshcore-map.git
git branch -M main
git push -u origin main
```

### 3. Deploy to Cloudflare Pages
Choose **one** of the following methods:

#### Option A: Cloudflare Dashboard (Easiest)
1. Go to https://dash.cloudflare.com/
2. Click **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**
3. Select your GitHub repo: `meshcore-map`
4. Configure:
   - **Project name**: `meshcore-map` (or your choice - this becomes your URL)
   - **Production branch**: `main`
   - **Build settings**: None needed (static site)
5. Click **Save and Deploy**
Then set up KV:
1. In Cloudflare dashboard, go to **Workers & Pages** → **KV**
2. Click **Create a namespace**
3. Name it: `WARDRIVE_DATA`
4. Go back to your Pages project → **Settings** → **Functions** → **KV namespace bindings**
5. Add binding:
   - **Variable name**: `WARDRIVE_DATA`
   - **KV namespace**: Select the one you just created
6. Click **Save**
#### Option B: Wrangler CLI (Recommended for developers)

```bash
# Install Wrangler
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Create KV namespace (copy the id from output)
wrangler kv namespace create WARDRIVE_DATA

# Update wrangler.toml with the KV namespace id from above

# Create Pages project
wrangler pages project create meshwar-map --production-branch main

# Set admin token secret (for DELETE endpoint auth)
wrangler pages secret put ADMIN_TOKEN --project-name meshwar-map

# Deploy
wrangler pages deploy . --project-name meshwar-map

# Tail the Worker for errors 
wrangler pages deployment tail --project-name meshwar-map
```

### 5. Your Site is Live! 🎉

Your map will be available at:
```
https://meshcore-map.pages.dev
```
(or whatever project name you chose)

## API Endpoints

### GET `/api/samples`
Returns all stored samples as JSON.

**Response:**
```json
{
  "samples": [
    {
      "nodeId": "ABC123",
      "latitude": 47.6062,
      "longitude": -122.3321,
      "rssi": -95,
      "snr": 8,
      "timestamp": "2026-01-06T00:00:00Z"
    }
  ]
}
```

### POST `/api/samples`
Upload new samples from your Flutter app.

**Request:**
```json
{
  "samples": [
    {
      "nodeId": "ABC123",
      "latitude": 47.6062,
      "longitude": -122.3321,
      "rssi": -95,
      "snr": 8,
      "timestamp": "2026-01-06T00:00:00Z"
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "added": 1,
  "total": 1234
}
```

## Next Steps

After deployment, update your Flutter app to upload samples to:
```
https://your-project-name.pages.dev/api/samples
```

The Flutter app changes will be provided separately.

## Storage Limits

- Free tier: 100,000 reads/day, 1,000 writes/day
- Keeps last 10,000 samples (older ones auto-deleted)
- Each upload can contain multiple samples

## Local Testing

To test locally, you can use `wrangler` (Cloudflare CLI):

```bash
npm install -g wrangler
wrangler pages dev .
```

This will start a local server at `http://localhost:8788`
