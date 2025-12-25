const express = require('express');
const router = express.Router();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

router.post('/fetch-fb-video-data', async (req, res) => {
  const { url } = req.body;
  const tempDir = path.join(__dirname, 'temp');

  if (!fsSync.existsSync(tempDir)) {
    fsSync.mkdirSync(tempDir, { recursive: true });
  }

  let browser;

  try {
    browser = await puppeteer.launch({
      headless: 'new',

      // 🔥 CRITICAL FIX
      executablePath: puppeteer.executablePath(),

      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-zygote',
        '--single-process'
      ],

      ignoreDefaultArgs: ['--enable-automation']
    });

    const page = await browser.newPage();

    /* =================== STEALTH HARDENING =================== */
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

      window.chrome = { runtime: {} };
    });

    await page.setViewport({ width: 375, height: 667 });

    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile Safari/604.1'
    );

    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Upgrade-Insecure-Requests': '1'
    });

    /* =================== STREAM TRACKING =================== */
    const streams = {
      videos: new Map(),
      audios: [],
      targetVideoFound: false,
      mainVideoInteractionTime: null,
      allVideoStreams: []
    };

    const postId = extractPostId(url);
    console.log('Target post ID:', postId);

    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      const u = req.url();

      if (
        ['document', 'xhr', 'fetch'].includes(type) ||
        u.includes('video') ||
        u.includes('audio') ||
        u.includes('.mp4')
      ) {
        req.continue();
      } else {
        req.abort();
      }
    });

    page.on('response', async response => {
      try {
        const u = response.url();
        const headers = response.headers();
        const type = headers['content-type'] || '';
        const size = parseInt(headers['content-length'] || '0');

        if (type.includes('video') || u.includes('.mp4')) {
          const quality = extractQualityImproved(u);
          const bitrate = extractBitrate(u);
          const isTarget = checkIfTargetStream(u, postId);

          const data = {
            url: u.split('&bytestart=')[0].split('&range=')[0],
            quality,
            bitrate,
            contentLength: size,
            isTarget,
            timestamp: Date.now(),
            isDash: u.includes('dash'),
            isProgressive: u.includes('progressive')
          };

          streams.allVideoStreams.push(data);

          if (quality || isTarget) {
            const key = quality || 'unknown';
            if (!streams.videos.has(key) || streams.videos.get(key).bitrate < bitrate) {
              streams.videos.set(key, data);
            }
          }

          if (isTarget) streams.targetVideoFound = true;
        }

        if (type.includes('audio')) {
          const bitrate = extractBitrate(u);
          const isTarget = checkIfTargetStream(u, postId);

          if (!streams.audios.find(a => a.url === u)) {
            streams.audios.push({ url: u, bitrate, isTarget, timestamp: Date.now() });
          }
        }
      } catch (e) {
        console.error('Response parse error:', e);
      }
    });

    /* =================== PAGE LOAD =================== */
    const urlsToTry = [
      convertToMobileUrl(url),
      convertToDesktopUrl(url),
      url
    ];

    let loaded = false;
    for (const testUrl of urlsToTry) {
      try {
        await page.goto(testUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForTimeout(3000);

        const hasVideo = await page.$('video');
        if (hasVideo) {
          loaded = true;
          break;
        }
      } catch {}
    }

    if (!loaded) throw new Error('Could not load Facebook video page');

    /* =================== INTERACT =================== */
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) {
        v.muted = false;
        v.play().catch(() => {});
        v.currentTime = 5;
      }
    });

    streams.mainVideoInteractionTime = Date.now();
    await page.waitForTimeout(12000);

    /* =================== METADATA =================== */
    const metadata = await page.evaluate(() => {
      const meta = p => document.querySelector(`meta[property="${p}"]`)?.content;
      return {
        title: meta('og:title') || document.title,
        thumbnail: meta('og:image'),
        description: meta('og:description')
      };
    });

    const bestVideo = selectBestVideoStream(streams, postId);
    const bestAudio = selectBestAudioStream(streams, postId);

    if (!bestVideo) {
      return res.status(404).json({ status: 'error', message: 'No video stream found' });
    }

    if (bestVideo && bestAudio) {
      try {
        const merged = await mergeStreams(bestVideo.url, bestAudio, tempDir);
        return res.json({
          status: 'success',
          data: {
            name: metadata.title,
            thumbnail: metadata.thumbnail,
            videoUrl: `/temp/${path.basename(merged)}`,
            quality: 'HD (merged)'
          }
        });
      } catch {}
    }

    return res.json({
      status: 'success',
      data: {
        name: metadata.title,
        thumbnail: metadata.thumbnail,
        videoUrl: bestVideo.url,
        audioUrl: bestAudio,
        quality: bestVideo.quality
      }
    });

  } catch (err) {
    console.error('Scraping error:', err);
    return res.status(500).json({
      status: 'error',
      message: err.message
    });
  } finally {
    if (browser) await browser.close();
  }
});

/* =================== HELPERS (UNCHANGED) =================== */

function extractPostId(url) {
  try {
    const patterns = [
      /\/videos\/(\d+)/,
      /story_fbid=(\d+)/,
      /watch\/?\?v=(\d+)/,
      /\/reel\/(\d+)/,
      /\/(\d{10,})/
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

function extractQualityImproved(url) {
  const m = url.match(/(\d+)p/);
  return m ? parseInt(m[1]) : null;
}

function extractBitrate(url) {
  const m = url.match(/bitrate=(\d+)/);
  return m ? parseInt(m[1]) : 0;
}

function checkIfTargetStream(url, postId) {
  if (!postId) return false;
  return url.includes(postId);
}

function selectBestVideoStream(streams) {
  return [...streams.videos.values()]
    .sort((a, b) => (b.quality || 0) - (a.quality || 0))[0];
}

function selectBestAudioStream(streams) {
  return streams.audios.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]?.url;
}

function convertToMobileUrl(url) {
  return url.replace('www.facebook.com', 'm.facebook.com');
}

function convertToDesktopUrl(url) {
  return url.replace('m.facebook.com', 'www.facebook.com');
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
  const r = await fetch(url);
  const w = fsSync.createWriteStream(file);
  return new Promise((res, rej) => {
    r.body.pipe(w);
    w.on('finish', res);
    w.on('error', rej);
  });
}

module.exports = router;
