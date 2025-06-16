const express = require('express');
const router = express.Router();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin()); // Bypass bot detection

router.post('/fetch-fb-video-data', async (req, res) => {
  const { url } = req.body;
  const tempDir = path.join(__dirname, 'temp');

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
  }

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security'
      ]
    });
    const page = await browser.newPage();

    await page.setRequestInterception(true);
    const streams = {
      videos: new Map(),
      audios: []
    };

    page.on('request', (request) => request.continue());

    page.on('response', async (response) => {
      const url = response.url();
      const headers = response.headers();

      if (headers['content-type']?.includes('video/mp4')) {
        const quality = extractQuality(url);
        if (quality && !streams.videos.has(quality)) {
          streams.videos.set(quality, url.split('&bytestart=')[0]);
        }
      }

      if (headers['content-type']?.includes('audio/mp4')) {
        streams.audios.push(url.split('&bytestart=')[0]);
      }
    });

    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1');

    await page.goto(url.replace('www.facebook.com', 'm.facebook.com'), {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await new Promise(res => setTimeout(res, 8000));

    const metadata = await page.evaluate(() => ({
      title: document.title,
      thumbnail: document.querySelector('meta[property="og:image"]')?.content,
      duration: document.querySelector('meta[property="og:video:duration"]')?.content
    }));

    await browser.close();

    const qualities = Array.from(streams.videos.keys()).sort((a, b) => b - a);
    const bestQuality = qualities[0];
    const videoUrl = streams.videos.get(bestQuality);
    const audioUrl = streams.audios[0];

    if (!videoUrl) {
      return res.status(404).json({ status: 'error', message: 'No video streams found' });
    }

    if (videoUrl && audioUrl) {
      try {
        const mergedPath = await mergeStreams(videoUrl, audioUrl, tempDir);
        const finalUrl = `${req.protocol}://${req.get('host')}/temp/${path.basename(mergedPath)}`;

        return res.json({
          status: 'success',
          data: {
            name: metadata.title, 
            thumbnail: metadata.thumbnail,
            videoUrl: finalUrl,
            quality: 'Merged HD',
            duration: metadata.duration 
          }
        });
      } catch (mergeError) {
        console.error('Merge failed, sending separate streams:', mergeError);
      }
    }

    return res.json({
      status: 'success',
      data: {
        name: metadata.title,
        thumbnail: metadata.thumbnail,
        videoUrl: videoUrl,
        audioUrl: audioUrl,
        quality: `${bestQuality}p`,
        duration: metadata.duration
      }
    });

  } catch (err) {
    console.error('Scraping error:', err);
    return res.status(500).json({
      status: 'error',
      message: err.message 
    });
  }
});

function extractQuality(url) {
  const qualityMatch = url.match(/(\d+)p\.mp4/);
  if (qualityMatch) return parseInt(qualityMatch[1]);

  if (url.includes('f4/m69')) return 2160;
  if (url.includes('f3/m69')) return 1080;
  if (url.includes('f2/m69')) return 720;
  if (url.includes('f1/m69')) return 480;

  return null;
}

async function mergeStreams(videoUrl, audioUrl, outputDir) {
  const videoPath = path.join(outputDir, 'video.mp4');
  const audioPath = path.join(outputDir, 'audio.mp4');
  const outputPath = path.join(outputDir, `merged_${Date.now()}.mp4`);

  await downloadFile(videoUrl, videoPath);
  await downloadFile(audioUrl, audioPath);

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        '-c:v copy',
        '-c:a aac',
        '-strict experimental',
        '-map 0:v:0',
        '-map 1:a:0'
      ])
      .save(outputPath)
      .on('end', resolve)
      .on('error', reject);
  });

  fs.unlinkSync(videoPath);
  fs.unlinkSync(audioPath);

  return outputPath;
}

async function downloadFile(url, path) {
  const response = await fetch(url);
  const writer = fs.createWriteStream(path);
  response.body.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

module.exports = router;