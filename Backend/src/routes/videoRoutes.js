const express = require('express');
const router = express.Router();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

/* =========================================================
   🚀 BROWSER SINGLETON (MAJOR SPEED BOOST)
========================================================= */
let browserInstance = null;

async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await puppeteer.launch({
      headless: 'new',
      executablePath:
        process.env.PUPPETEER_EXECUTABLE_PATH ||
        '/usr/bin/google-chrome-stable',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--window-size=1280,720'
      ],
      protocolTimeout: 180000
    });
  }
  return browserInstance;
}

/* =========================================================
   ROUTE 1: FETCH VIDEO DATA (FAST ⚡)
========================================================= */
router.post('/fetch-fb-video-data', async (req, res) => {
  const { url } = req.body;

  let page;

  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);

    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    );

    /* 🚫 BLOCK HEAVY RESOURCES */
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (
        type === 'image' ||
        type === 'stylesheet' ||
        type === 'font' ||
        type === 'media'
      ) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log('⚡ Loading:', url);

    /* ================= STRATEGY 1 ================= */
    const pageSourceData = await extractVideoFromPageSource(page, url);

    if (
      pageSourceData &&
      pageSourceData.qualities.some(q => q.quality === 'hd')
    ) {
      return res.json({
        status: 'success',
        data: { ...pageSourceData, method: 'page_source_extraction' }
      });
    }

    /* ================= STRATEGY 2 ================= */
    const domData = await extractVideoFromDOM(page, url);

    if (domData && domData.qualities.length > 0) {
      return res.json({
        status: 'success',
        data: { ...domData, method: 'dom_extraction' }
      });
    }

    /* ================= STRATEGY 3 ================= */
    const networkData = await extractVideoFromNetwork(page, url);

    if (networkData && networkData.qualities.length > 0) {
      return res.json({
        status: 'success',
        data: { ...networkData, method: 'network_monitoring' }
      });
    }

    return res.status(404).json({
      status: 'error',
      message: 'Video not accessible or private'
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      status: 'error',
      message: err.message
    });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

/* =========================================================
   ROUTE 2: DOWNLOAD VIDEO
========================================================= */
router.post('/download-fb-video', async (req, res) => {
  const { videoUrl, audioUrl, quality, mergeAudio } = req.body;
  const tempDir = path.join(__dirname, 'temp');

  if (!fsSync.existsSync(tempDir)) {
    fsSync.mkdirSync(tempDir, { recursive: true });
  }

  try {
    if (mergeAudio && videoUrl && audioUrl) {
      const mergedPath = await mergeStreams(videoUrl, audioUrl, tempDir);
      return res.json({
        status: 'success',
        data: {
          downloadUrl: `/temp/${path.basename(mergedPath)}`,
          quality,
          type: 'merged'
        }
      });
    }

    return res.json({
      status: 'success',
      data: {
        downloadUrl: videoUrl || audioUrl,
        quality: quality || 'available',
        type: audioUrl && !videoUrl ? 'audio_only' : 'video_only'
      }
    });

  } catch (err) {
    return res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

/* =========================================================
   STRATEGY 1: PAGE SOURCE EXTRACTION
========================================================= */
async function extractVideoFromPageSource(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);

    return await page.evaluate(() => {
      const res = { qualities: [], audioUrl: null };

      const scripts = document.querySelectorAll('script');
      scripts.forEach(s => {
        const t = s.innerHTML;

        const hd = t.match(/"playable_url_quality_hd":"([^"]+)"/);
        const sd = t.match(/"playable_url":"([^"]+)"/);
        const audio = t.match(/"audio_url":"([^"]+)"/);

        if (hd) res.qualities.push({ quality: 'hd', url: hd[1], label: 'HD' });
        if (sd && !hd) res.qualities.push({ quality: 'sd', url: sd[1], label: 'SD' });
        if (audio && !res.audioUrl) res.audioUrl = audio[1];
      });

      return res.qualities.length ? res : null;
    });

  } catch {
    return null;
  }
}

/* =========================================================
   STRATEGY 2: DOM EXTRACTION
========================================================= */
async function extractVideoFromDOM(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);

    return await page.evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return null;

      return {
        qualities: [{ quality: 'available', url: v.src, label: 'Available' }],
        audioUrl: null
      };
    });

  } catch {
    return null;
  }
}

/* =========================================================
   STRATEGY 3: NETWORK MONITORING
========================================================= */
async function extractVideoFromNetwork(page, url) {
  try {
    const videos = new Map();

    const client = await page.target().createCDPSession();
    await client.send('Network.enable');

    client.on('Network.responseReceived', ({ response }) => {
      if (response.mimeType.includes('video')) {
        videos.set('available', response.url);
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    if (!videos.size) return null;

    return {
      qualities: [{ quality: 'available', url: [...videos.values()][0], label: 'Available' }],
      audioUrl: null
    };

  } catch {
    return null;
  }
}

/* =========================================================
   MERGE STREAMS
========================================================= */
async function mergeStreams(videoUrl, audioUrl, dir) {
  const v = path.join(dir, `v_${Date.now()}.mp4`);
  const a = path.join(dir, `a_${Date.now()}.mp4`);
  const o = path.join(dir, `m_${Date.now()}.mp4`);

  await downloadFile(videoUrl, v);
  await downloadFile(audioUrl, a);

  await new Promise((res, rej) => {
    ffmpeg()
      .input(v)
      .input(a)
      .outputOptions(['-c copy'])
      .save(o)
      .on('end', res)
      .on('error', rej);
  });

  await fs.unlink(v).catch(() => {});
  await fs.unlink(a).catch(() => {});
  return o;
}

async function downloadFile(url, file) {
  const res = await fetch(url, { headers: { Range: 'bytes=0-' } });
  const stream = fsSync.createWriteStream(file);
  return new Promise((r, j) => {
    res.body.pipe(stream);
    stream.on('finish', r);
    stream.on('error', j);
  });
}

module.exports = router;
