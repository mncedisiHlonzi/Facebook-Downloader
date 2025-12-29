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
  let page;
  
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1920,1080'
      ],
      ignoreHTTPSErrors: true,
      protocolTimeout: 180000
    });

    page = await browser.newPage();
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);

    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    console.log('Loading page:', url);

    // STRATEGY 1: Try to extract video data from page source/scripts
    const videoData = await extractVideoFromPageSource(page, url);
    
    if (videoData && videoData.videoUrl) {
      console.log('✓ Successfully extracted video from page source');
      return res.json({
        status: 'success',
        data: {
          name: videoData.title || 'Facebook Video',
          thumbnail: videoData.thumbnail,
          videoUrl: videoData.videoUrl,
          quality: videoData.quality || 'HD',
          duration: videoData.duration,
          description: videoData.description,
          method: 'page_source_extraction'
        }
      });
    }

    // STRATEGY 2: If page source extraction fails, use DOM-based approach
    console.log('Page source extraction failed, trying DOM approach...');
    const domVideoData = await extractVideoFromDOM(page, url);
    
    if (domVideoData && domVideoData.videoUrl) {
      console.log('✓ Successfully extracted video from DOM');
      return res.json({
        status: 'success',
        data: {
          name: domVideoData.title || 'Facebook Video',
          thumbnail: domVideoData.thumbnail,
          videoUrl: domVideoData.videoUrl,
          quality: domVideoData.quality || 'Available',
          duration: domVideoData.duration,
          description: domVideoData.description,
          method: 'dom_extraction'
        }
      });
    }

    // STRATEGY 3: Network monitoring as last resort (with improved filtering)
    console.log('DOM extraction failed, trying network monitoring...');
    const networkVideoData = await extractVideoFromNetwork(page, url);
    
    if (networkVideoData && networkVideoData.videoUrl) {
      console.log('✓ Successfully extracted video from network');
      return res.json({
        status: 'success',
        data: {
          name: networkVideoData.title || 'Facebook Video',
          thumbnail: networkVideoData.thumbnail,
          videoUrl: networkVideoData.videoUrl,
          audioUrl: networkVideoData.audioUrl,
          quality: networkVideoData.quality || 'Available',
          duration: networkVideoData.duration,
          description: networkVideoData.description,
          method: 'network_monitoring'
        }
      });
    }

    return res.status(404).json({ 
      status: 'error', 
      message: 'Could not extract video. The video may be private, deleted, or inaccessible.'
    });

  } catch (err) {
    console.error('Scraping error:', err);
    return res.status(500).json({
      status: 'error',
      message: `Scraping failed: ${err.message}`
    });
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
});

/**
 * STRATEGY 1: Extract video directly from page scripts/JSON
 * This is the most reliable method as it gets the actual video URL from Facebook's data
 */
async function extractVideoFromPageSource(page, url) {
  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });

    if (!response || response.status() === 404) {
      throw new Error('Page not found');
    }

    await page.waitForTimeout(3000);

    // Extract video data from page scripts and JSON-LD
    const videoData = await page.evaluate(() => {
      const results = {
        videoUrl: null,
        title: null,
        thumbnail: null,
        duration: null,
        description: null,
        quality: null
      };

      // Method 1: Check for JSON-LD structured data
      const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of jsonLdScripts) {
        try {
          const data = JSON.parse(script.textContent);
          if (data['@type'] === 'VideoObject') {
            results.videoUrl = data.contentUrl || data.embedUrl;
            results.title = data.name || data.headline;
            results.thumbnail = data.thumbnailUrl;
            results.duration = data.duration;
            results.description = data.description;
            
            if (results.videoUrl) {
              console.log('Found video via JSON-LD');
              return results;
            }
          }
        } catch (e) {}
      }

      // Method 2: Search through all scripts for video URLs in JavaScript objects
      const allScripts = document.querySelectorAll('script');
      for (const script of allScripts) {
        const content = script.textContent || script.innerHTML;
        
        // Look for playable_url, which is Facebook's video URL field
        const playableUrlMatch = content.match(/"playable_url(?:_quality_hd)?":"([^"]+)"/);
        if (playableUrlMatch) {
          results.videoUrl = playableUrlMatch[1].replace(/\\u0025/g, '%').replace(/\\u002F/g, '/').replace(/\\\//g, '/');
          console.log('Found video via playable_url');
        }

        // Look for browser_native_hd_url or browser_native_sd_url
        const browserNativeMatch = content.match(/"browser_native_(?:hd|sd)_url":"([^"]+)"/);
        if (browserNativeMatch && !results.videoUrl) {
          results.videoUrl = browserNativeMatch[1].replace(/\\u0025/g, '%').replace(/\\u002F/g, '/').replace(/\\\//g, '/');
          console.log('Found video via browser_native_url');
        }

        // Look for video_url
        const videoUrlMatch = content.match(/"video_url":"([^"]+)"/);
        if (videoUrlMatch && !results.videoUrl) {
          results.videoUrl = videoUrlMatch[1].replace(/\\u0025/g, '%').replace(/\\u002F/g, '/').replace(/\\\//g, '/');
          console.log('Found video via video_url');
        }

        // Extract title
        if (!results.title) {
          const titleMatch = content.match(/"title":\{"text":"([^"]+)"/);
          if (titleMatch) {
            results.title = titleMatch[1].replace(/\\u([0-9a-fA-F]{4})/g, (match, code) => 
              String.fromCharCode(parseInt(code, 16))
            );
          }
        }

        // Extract thumbnail
        if (!results.thumbnail) {
          const thumbMatch = content.match(/"preferred_thumbnail":\{"image":\{"uri":"([^"]+)"/);
          if (thumbMatch) {
            results.thumbnail = thumbMatch[1].replace(/\\u0025/g, '%').replace(/\\\//g, '/');
          }
        }
      }

      // Method 3: Check meta tags as fallback
      if (!results.videoUrl) {
        const videoMeta = document.querySelector('meta[property="og:video"], meta[property="og:video:url"]');
        if (videoMeta) {
          results.videoUrl = videoMeta.content;
          console.log('Found video via meta tags');
        }
      }

      if (!results.title) {
        const titleMeta = document.querySelector('meta[property="og:title"]');
        results.title = titleMeta ? titleMeta.content : document.title;
      }

      if (!results.thumbnail) {
        const thumbMeta = document.querySelector('meta[property="og:image"]');
        results.thumbnail = thumbMeta ? thumbMeta.content : null;
      }

      if (!results.description) {
        const descMeta = document.querySelector('meta[property="og:description"]');
        results.description = descMeta ? descMeta.content : null;
      }

      return results;
    });

    // Clean up the video URL
    if (videoData.videoUrl) {
      videoData.videoUrl = decodeURIComponent(videoData.videoUrl)
        .replace(/\\u0025/g, '%')
        .replace(/\\u002F/g, '/')
        .replace(/\\\//g, '/')
        .replace(/\\/g, '');
      
      // Detect quality from URL
      if (videoData.videoUrl.includes('hd')) {
        videoData.quality = 'HD';
      } else if (videoData.videoUrl.match(/\d+p/)) {
        const qualityMatch = videoData.videoUrl.match(/(\d+)p/);
        videoData.quality = qualityMatch ? `${qualityMatch[1]}p` : 'SD';
      }
    }

    return videoData.videoUrl ? videoData : null;

  } catch (error) {
    console.error('Page source extraction error:', error.message);
    return null;
  }
}

/**
 * STRATEGY 2: Extract video from DOM video element
 * Works when video is actually embedded in the page
 */
async function extractVideoFromDOM(page, url) {
  try {
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 45000
    });

    await page.waitForTimeout(3000);

    // Wait for video element to appear
    await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});

    const videoData = await page.evaluate(() => {
      const results = {
        videoUrl: null,
        title: null,
        thumbnail: null,
        duration: null,
        description: null
      };

      // Find the main video element (not thumbnails or suggested videos)
      const videos = Array.from(document.querySelectorAll('video'));
      
      if (videos.length === 0) return null;

      // If multiple videos, find the largest one (main video)
      let mainVideo = videos[0];
      if (videos.length > 1) {
        mainVideo = videos.reduce((largest, current) => {
          const largestArea = largest.offsetWidth * largest.offsetHeight;
          const currentArea = current.offsetWidth * current.offsetHeight;
          return currentArea > largestArea ? current : largest;
        });
      }

      // Get video source
      results.videoUrl = mainVideo.currentSrc || mainVideo.src;
      
      // If no src attribute, check source elements
      if (!results.videoUrl) {
        const source = mainVideo.querySelector('source');
        results.videoUrl = source ? source.src : null;
      }

      results.duration = mainVideo.duration;
      results.thumbnail = mainVideo.poster;

      // Get metadata from page
      const titleMeta = document.querySelector('meta[property="og:title"]');
      results.title = titleMeta ? titleMeta.content : document.title;

      const descMeta = document.querySelector('meta[property="og:description"]');
      results.description = descMeta ? descMeta.content : null;

      return results;
    });

    return videoData && videoData.videoUrl ? videoData : null;

  } catch (error) {
    console.error('DOM extraction error:', error.message);
    return null;
  }
}

/**
 * STRATEGY 3: Network monitoring (improved with better filtering)
 * Only used as last resort, with much better video identification
 */
async function extractVideoFromNetwork(page, url) {
  try {
    const streams = {
      video: null,
      audio: null,
      metadata: {}
    };

    let targetVideoElement = null;

    // Setup network interception
    await page.setRequestInterception(true);
    
    page.on('request', (request) => {
      const resourceType = request.resourceType();
      if (['document', 'xhr', 'fetch', 'media'].includes(resourceType)) {
        request.continue();
      } else {
        request.abort();
      }
    });

    page.on('response', async (response) => {
      try {
        const responseUrl = response.url();
        const contentType = response.headers()['content-type'] || '';

        // Only capture video from the main video element
        if (contentType.includes('video/mp4') || responseUrl.includes('.mp4')) {
          // Store but don't immediately select
          const quality = extractQuality(responseUrl);
          const size = parseInt(response.headers()['content-length'] || '0');
          
          if (!streams.video || (quality && (!streams.video.quality || quality > streams.video.quality))) {
            streams.video = {
              url: responseUrl.split('&bytestart=')[0],
              quality: quality,
              size: size
            };
          }
        }

        if (contentType.includes('audio/mp4')) {
          if (!streams.audio) {
            streams.audio = {
              url: responseUrl.split('&bytestart=')[0]
            };
          }
        }
      } catch (err) {
        console.error('Response handler error:', err);
      }
    });

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });

    await page.waitForTimeout(3000);

    // Find and interact with the MAIN video only
    await page.evaluate(() => {
      const videos = Array.from(document.querySelectorAll('video'));
      if (videos.length > 0) {
        // Get the largest video (main video)
        const mainVideo = videos.reduce((largest, current) => {
          const largestArea = largest.offsetWidth * largest.offsetHeight;
          const currentArea = current.offsetWidth * current.offsetHeight;
          return currentArea > largestArea ? current : largest;
        });

        // Mark it for identification
        mainVideo.setAttribute('data-main-video', 'true');
        mainVideo.scrollIntoView({ behavior: 'smooth', block: 'center' });
        
        setTimeout(() => {
          mainVideo.play().catch(() => {});
        }, 500);
      }
    });

    await page.waitForTimeout(5000);

    // Get metadata
    streams.metadata = await page.evaluate(() => {
      const getMetaContent = (property) => {
        const meta = document.querySelector(`meta[property="${property}"]`);
        return meta ? meta.content : null;
      };

      return {
        title: getMetaContent('og:title') || document.title,
        thumbnail: getMetaContent('og:image'),
        duration: getMetaContent('og:video:duration'),
        description: getMetaContent('og:description')
      };
    });

    return {
      videoUrl: streams.video?.url,
      audioUrl: streams.audio?.url,
      quality: streams.video?.quality,
      title: streams.metadata.title,
      thumbnail: streams.metadata.thumbnail,
      duration: streams.metadata.duration,
      description: streams.metadata.description
    };

  } catch (error) {
    console.error('Network monitoring error:', error.message);
    return null;
  }
}

function extractQuality(url) {
  const patterns = [
    /(\d+)p\.mp4/,
    /height_(\d+)/,
    /(\d+)p/,
    /hd_(\d+)/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return parseInt(match[1]);
    }
  }
  
  return null;
}

module.exports = router;