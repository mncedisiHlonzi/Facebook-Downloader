const express = require('express');
const router = express.Router();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

/* ======================================================
   ROUTE 1: FETCH VIDEO DATA (ALL QUALITIES)
====================================================== */
router.post('/fetch-fb-video-data', async (req, res) => {
  const { url } = req.body;
  let browser, page;

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath:
        process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1920,1080'
      ],
      protocolTimeout: 180000
    });

    page = await browser.newPage();
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);

    /* ================= DESKTOP MODE ================= */
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
    );

    console.log('Loading page:', url);

    /* -------- STRATEGY 1: PAGE SOURCE -------- */
    console.log('Trying Strategy 1: Page source extraction...');
    const s1 = await extractVideoFromPageSource(page, url);
    if (s1) return respond(res, s1, 'page_source');

    /* -------- STRATEGY 2: DOM -------- */
    console.log('Trying Strategy 2: DOM extraction...');
    const s2 = await extractVideoFromDOM(page, url);
    if (s2) return respond(res, s2, 'dom');

    /* -------- STRATEGY 3: NETWORK -------- */
    console.log('Trying Strategy 3: Network monitoring...');
    const s3 = await extractVideoFromNetwork(page, url);
    if (s3) return respond(res, s3, 'network');

    /* 🔥 -------- STRATEGY 4: AGGRESSIVE MOBILE MODE -------- 🔥 */
    console.log('Trying Strategy 4: Aggressive mobile reel mode...');
    const s4 = await extractVideoAggressiveMobile(browser, url);
    if (s4) return respond(res, s4, 'aggressive_mobile');

    return res.status(404).json({
      status: 'protected',
      message:
        'This Facebook video uses protected streaming (Reels/MSE) and cannot be extracted server-side.'
    });

  } catch (err) {
    console.error('Scraping error:', err);
    return res.status(500).json({
      status: 'error',
      message: err.message
    });
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
});

/* ======================================================
   ROUTE 2: DOWNLOAD VIDEO
====================================================== */
router.post('/download-fb-video', async (req, res) => {
  const { videoUrl, audioUrl, quality, mergeAudio } = req.body;
  const tempDir = path.join(__dirname, 'temp');

  if (!fsSync.existsSync(tempDir)) {
    fsSync.mkdirSync(tempDir, { recursive: true });
  }

  try {
    if (mergeAudio && videoUrl && audioUrl) {
      const mergedPath = await mergeStreams(videoUrl, audioUrl, tempDir);
      const finalUrl = `${req.protocol}://${req.get('host')}/temp/${path.basename(
        mergedPath
      )}`;

      return res.json({
        status: 'success',
        data: {
          downloadUrl: finalUrl,
          quality,
          type: 'merged'
        }
      });
    }

    return res.json({
      status: 'success',
      data: {
        downloadUrl: videoUrl || audioUrl,
        quality,
        type: audioUrl && !videoUrl ? 'audio_only' : 'video_only'
      }
    });
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/* ======================================================
   STRATEGY 1: PAGE SOURCE EXTRACTION
====================================================== */
async function extractVideoFromPageSource(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise(r => setTimeout(r, 3000));

    const data = await page.evaluate(() => {
      const results = {
        qualities: [],
        audioUrl: null,
        title: null,
        thumbnail: null,
        duration: null,
        description: null
      };

      const scripts = document.querySelectorAll('script');
      const urls = { hd: null, sd: null };

      for (const s of scripts) {
        const t = s.textContent || '';

        const hd = t.match(/"playable_url_quality_hd":"([^"]+)"/);
        if (hd && !urls.hd) urls.hd = hd[1];

        const sd = t.match(/"playable_url":"([^"]+)"/);
        if (sd && !urls.sd) urls.sd = sd[1];

        if (!results.audioUrl) {
          const a = t.match(/"audio_url":"([^"]+)"/);
          if (a) results.audioUrl = a[1];
        }
      }

      if (urls.hd)
        results.qualities.push({
          quality: 'hd',
          url: urls.hd,
          label: 'HD'
        });

      if (urls.sd && urls.sd !== urls.hd)
        results.qualities.push({
          quality: 'sd',
          url: urls.sd,
          label: 'SD'
        });

      results.title =
        document.querySelector('meta[property="og:title"]')?.content ||
        document.title;
      results.thumbnail =
        document.querySelector('meta[property="og:image"]')?.content || null;
      results.description =
        document.querySelector('meta[property="og:description"]')?.content ||
        null;

      return results;
    });

    return data.qualities.length || data.audioUrl ? data : null;
  } catch {
    return null;
  }
}

/* ======================================================
   STRATEGY 2: DOM VIDEO
====================================================== */
async function extractVideoFromDOM(page, url) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('video', { timeout: 8000 }).catch(() => {});

    const data = await page.evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return null;

      return {
        qualities: [
          {
            quality: 'available',
            url: v.currentSrc || v.src,
            label: 'Available'
          }
        ],
        audioUrl: null,
        title:
          document.querySelector('meta[property="og:title"]')?.content ||
          document.title,
        thumbnail: v.poster,
        duration: v.duration,
        description:
          document.querySelector('meta[property="og:description"]')?.content ||
          null
      };
    });

    return data;
  } catch {
    return null;
  }
}

/* ======================================================
   STRATEGY 3: NETWORK MONITORING
====================================================== */
async function extractVideoFromNetwork(page, url) {
  try {
    const client = await page.target().createCDPSession();
    await client.send('Network.enable');

    const videos = new Map();
    let audio = null;

    client.on('Network.responseReceived', ({ response }) => {
      const u = response.url;
      if (u.includes('.mp4')) {
        videos.set(extractQuality(u) || 'available', u.split('&bytestart=')[0]);
      }
      if (response.mimeType?.includes('audio')) {
        audio = u.split('&bytestart=')[0];
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise(r => setTimeout(r, 5000));

    if (!videos.size) return null;

    return {
      qualities: [...videos.entries()].map(([q, u]) => ({
        quality: q,
        url: u,
        label: q.toUpperCase()
      })),
      audioUrl: audio,
      title: await page.title()
    };
  } catch {
    return null;
  }
}

/* ======================================================
   🔥 STRATEGY 4: AGGRESSIVE MOBILE / REELS
====================================================== */
async function extractVideoAggressiveMobile(browser, url) {
  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36'
    );
    await page.setViewport({ width: 412, height: 915 });

    const client = await page.target().createCDPSession();
    await client.send('Network.enable');

    const streams = new Map();
    let audio = null;

    client.on('Network.responseReceived', ({ response }) => {
      const u = response.url;
      if (u.includes('.m4s') || u.includes('videoplayback')) {
        streams.set(extractQuality(u) || 'available', u.split('&bytestart=')[0]);
      }
      if (response.mimeType?.includes('audio')) {
        audio = u.split('&bytestart=')[0];
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) {
        v.muted = true;
        v.play().catch(() => {});
      }
    });

    await new Promise(r => setTimeout(r, 6000));

    if (!streams.size) return null;

    return {
      qualities: [...streams.entries()].map(([q, u]) => ({
        quality: q,
        url: u,
        label: q.toUpperCase()
      })),
      audioUrl: audio,
      title: await page.title()
    };
  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

/* ======================================================
   HELPERS
====================================================== */
function extractQuality(url) {
  if (url.includes('hd')) return 'hd';
  if (url.includes('sd')) return 'sd';
  return null;
}

async function mergeStreams(videoUrl, audioUrl, dir) {
  const v = path.join(dir, `v_${Date.now()}.mp4`);
  const a = path.join(dir, `a_${Date.now()}.mp4`);
  const o = path.join(dir, `merged_${Date.now()}.mp4`);

  await downloadFile(videoUrl, v);
  await downloadFile(audioUrl, a);

  await new Promise((res, rej) => {
    ffmpeg()
      .input(v)
      .input(a)
      .outputOptions(['-c:v copy', '-c:a aac'])
      .save(o)
      .on('end', res)
      .on('error', rej);
  });

  await fs.unlink(v).catch(() => {});
  await fs.unlink(a).catch(() => {});
  return o;
}

async function downloadFile(url, file) {
  const r = await fetch(url);
  const w = fsSync.createWriteStream(file);
  return new Promise((res, rej) => {
    r.body.pipe(w);
    w.on('finish', res);
    w.on('error', rej);
  });
}

function respond(res, data, method) {
  return res.json({
    status: 'success',
    data: {
      name: data.title || 'Facebook Video',
      thumbnail: data.thumbnail,
      qualities: data.qualities,
      audioUrl: data.audioUrl,
      duration: data.duration,
      description: data.description,
      method
    }
  });
}

module.exports = router;
