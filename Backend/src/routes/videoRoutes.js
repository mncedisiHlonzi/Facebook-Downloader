const express = require('express');
const router = express.Router();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

// Route 1: Fetch video data and return all available qualities
router.post('/fetch-fb-video-data', async (req, res) => {
  const { url } = req.body;

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
    console.log('Trying Strategy 1: Page source extraction...');
    const videoData = await extractVideoFromPageSource(page, url);
    
    if (videoData && (videoData.qualities.length > 0 || videoData.audioUrl)) {
      console.log('✓ Successfully extracted video from page source');
      console.log('Available qualities:', videoData.qualities.map(q => q.quality).join(', '));
      
      return res.json({
        status: 'success',
        data: {
          name: videoData.title || 'Facebook Video',
          thumbnail: videoData.thumbnail,
          qualities: videoData.qualities,
          audioUrl: videoData.audioUrl,
          duration: videoData.duration,
          description: videoData.description,
          method: 'page_source_extraction'
        }
      });
    }

    // STRATEGY 2: If page source extraction fails, use DOM-based approach
    console.log('Strategy 1 failed, trying Strategy 2: DOM extraction...');
    const domVideoData = await extractVideoFromDOM(page, url);
    
    if (domVideoData && (domVideoData.qualities.length > 0 || domVideoData.audioUrl)) {
      console.log('✓ Successfully extracted video from DOM');
      console.log('Available qualities:', domVideoData.qualities.map(q => q.quality).join(', '));
      
      return res.json({
        status: 'success',
        data: {
          name: domVideoData.title || 'Facebook Video',
          thumbnail: domVideoData.thumbnail,
          qualities: domVideoData.qualities,
          audioUrl: domVideoData.audioUrl,
          duration: domVideoData.duration,
          description: domVideoData.description,
          method: 'dom_extraction'
        }
      });
    }

    // STRATEGY 3: Network monitoring as last resort
    console.log('Strategy 2 failed, trying Strategy 3: Network monitoring...');
    const networkVideoData = await extractVideoFromNetwork(page, url);
    
    if (networkVideoData && (networkVideoData.qualities.length > 0 || networkVideoData.audioUrl)) {
      console.log('✓ Successfully extracted video from network');
      console.log('Available qualities:', networkVideoData.qualities.map(q => q.quality).join(', '));
      
      return res.json({
        status: 'success',
        data: {
          name: networkVideoData.title || 'Facebook Video',
          thumbnail: networkVideoData.thumbnail,
          qualities: networkVideoData.qualities,
          audioUrl: networkVideoData.audioUrl,
          duration: networkVideoData.duration,
          description: networkVideoData.description,
          method: 'network_monitoring'
        }
      });
    }

    // STRATEGY 4: Deep page analysis with mobile user agent
    console.log('Strategy 3 failed, trying Strategy 4: Mobile deep extraction...');
    const mobileVideoData = await extractVideoMobileDeep(page, url);
    
    if (mobileVideoData && (mobileVideoData.qualities.length > 0 || mobileVideoData.audioUrl)) {
      console.log('✓ Successfully extracted video via mobile deep extraction');
      console.log('Available qualities:', mobileVideoData.qualities.map(q => q.quality).join(', '));
      
      return res.json({
        status: 'success',
        data: {
          name: mobileVideoData.title || 'Facebook Video',
          thumbnail: mobileVideoData.thumbnail,
          qualities: mobileVideoData.qualities,
          audioUrl: mobileVideoData.audioUrl,
          duration: mobileVideoData.duration,
          description: mobileVideoData.description,
          method: 'mobile_deep_extraction'
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

// Route 2: Download video with selected quality
router.post('/download-fb-video', async (req, res) => {
  const { videoUrl, audioUrl, quality, mergeAudio } = req.body;
  const tempDir = path.join(__dirname, 'temp');

  if (!fsSync.existsSync(tempDir)) {
    fsSync.mkdirSync(tempDir, { recursive: true });
  }

  try {
    if (!videoUrl) {
      return res.status(400).json({
        status: 'error',
        message: 'Video URL is required'
      });
    }

    if (mergeAudio && audioUrl && videoUrl) {
      console.log('Merging video and audio...');
      const mergedPath = await mergeStreams(videoUrl, audioUrl, tempDir);
      const finalUrl = `${req.protocol}://${req.get('host')}/temp/${path.basename(mergedPath)}`;

      return res.json({
        status: 'success',
        data: {
          downloadUrl: finalUrl,
          quality: quality,
          type: 'merged'
        }
      });
    }

    if (!videoUrl && audioUrl) {
      return res.json({
        status: 'success',
        data: {
          downloadUrl: audioUrl,
          quality: 'audio',
          type: 'audio_only'
        }
      });
    }

    return res.json({
      status: 'success',
      data: {
        downloadUrl: videoUrl,
        quality: quality,
        type: 'video_only'
      }
    });

  } catch (err) {
    console.error('Download error:', err);
    return res.status(500).json({
      status: 'error',
      message: `Download failed: ${err.message}`
    });
  }
});

/**
 * STRATEGY 1: Extract video directly from page scripts/JSON
 * Returns all available qualities
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

    await new Promise(resolve => setTimeout(resolve, 3000));

    const videoData = await page.evaluate(() => {
      const results = {
        qualities: [],
        audioUrl: null,
        title: null,
        thumbnail: null,
        duration: null,
        description: null
      };

      // Method 1: Check for JSON-LD structured data
      const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of jsonLdScripts) {
        try {
          const data = JSON.parse(script.textContent);
          if (data['@type'] === 'VideoObject') {
            const videoUrl = data.contentUrl || data.embedUrl;
            if (videoUrl) {
              results.qualities.push({
                quality: 'hd',
                url: videoUrl,
                label: 'HD'
              });
              console.log('Found video via JSON-LD');
            }
            results.title = data.name || data.headline;
            results.thumbnail = data.thumbnailUrl;
            results.duration = data.duration;
            results.description = data.description;
          }
        } catch (e) {}
      }

      // Method 2: Search through all scripts for video URLs - ENHANCED
      const allScripts = document.querySelectorAll('script');
      let scriptCount = 0;
      
      const videoUrls = {
        hd: null,
        sd: null,
        playable: null,
        download: null
      };

      for (const script of allScripts) {
        const content = script.textContent || script.innerHTML;
        scriptCount++;
        
        // Enhanced pattern matching for difficult videos
        const patterns = [
          /"playable_url_quality_hd":"([^"]+)"/,
          /"browser_native_hd_url":"([^"]+)"/,
          /"playable_url":"([^"]+)"/,
          /"browser_native_sd_url":"([^"]+)"/,
          /"download_url":"([^"]+)"/,
          /"src":"(https:\/\/[^"]*video[^"]*\.mp4[^"]*)"/,
          /"video_url":"([^"]+)"/,
          // New patterns for protected videos
          /"playback_url":"([^"]+)"/,
          /"progressive_url":"([^"]+)"/,
          /"dash_manifest":"([^"]+)"/,
          /video_url\\?":\\?"([^"\\]+)/,
          /playableUrl\\?":\\?"([^"\\]+)/,
          /representationUrl\\?":\\?"([^"\\]+)/
        ];

        patterns.forEach((pattern, index) => {
          const match = content.match(pattern);
          if (match && match[1]) {
            let url = match[1]
              .replace(/\\u0025/g, '%')
              .replace(/\\u002F/g, '/')
              .replace(/\\\//g, '/')
              .replace(/\\/g, '');
            
            // Determine quality based on pattern
            if (index <= 1) videoUrls.hd = videoUrls.hd || url;
            else if (index <= 3) videoUrls.sd = videoUrls.sd || url;
            else videoUrls.playable = videoUrls.playable || url;
          }
        });

        // Look for audio URL
        if (!results.audioUrl) {
          const audioMatch = content.match(/"audio_url":"([^"]+)"/);
          if (audioMatch) {
            results.audioUrl = audioMatch[1]
              .replace(/\\u0025/g, '%')
              .replace(/\\u002F/g, '/')
              .replace(/\\\//g, '/')
              .replace(/\\/g, '');
          }
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
            results.thumbnail = thumbMatch[1]
              .replace(/\\u0025/g, '%')
              .replace(/\\\//g, '/');
          }
        }
      }
      
      console.log('Searched through', scriptCount, 'scripts');

      // Build qualities array
      if (videoUrls.hd) {
        results.qualities.push({
          quality: 'hd',
          url: videoUrls.hd,
          label: 'HD (High Quality)'
        });
      }

      if (videoUrls.sd && videoUrls.sd !== videoUrls.hd) {
        results.qualities.push({
          quality: 'sd',
          url: videoUrls.sd,
          label: 'SD (Standard Quality)'
        });
      }

      if (results.qualities.length === 0 && (videoUrls.download || videoUrls.playable)) {
        results.qualities.push({
          quality: 'available',
          url: videoUrls.download || videoUrls.playable,
          label: 'Available Quality'
        });
      }

      // Method 3: Check meta tags as fallback
      if (results.qualities.length === 0) {
        const videoMeta = document.querySelector('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]');
        if (videoMeta) {
          results.qualities.push({
            quality: 'available',
            url: videoMeta.content,
            label: 'Available Quality'
          });
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

    // Clean up URLs
    videoData.qualities = videoData.qualities.map(q => ({
      ...q,
      url: decodeURIComponent(q.url)
        .replace(/\\u0025/g, '%')
        .replace(/\\u002F/g, '/')
        .replace(/\\\//g, '/')
        .replace(/\\/g, '')
    }));

    if (videoData.audioUrl) {
      videoData.audioUrl = decodeURIComponent(videoData.audioUrl)
        .replace(/\\u0025/g, '%')
        .replace(/\\u002F/g, '/')
        .replace(/\\\//g, '/')
        .replace(/\\/g, '');
    }

    return (videoData.qualities.length > 0 || videoData.audioUrl) ? videoData : null;

  } catch (error) {
    console.error('Page source extraction error:', error.message);
    return null;
  }
}

/**
 * STRATEGY 2: Extract video from DOM video element
 */
async function extractVideoFromDOM(page, url) {
  try {
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 45000
    });

    await new Promise(resolve => setTimeout(resolve, 3000));

    await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});

    const videoData = await page.evaluate(() => {
      const results = {
        qualities: [],
        audioUrl: null,
        title: null,
        thumbnail: null,
        duration: null,
        description: null
      };

      const videos = Array.from(document.querySelectorAll('video'));
      
      if (videos.length === 0) return null;

      let mainVideo = videos[0];
      if (videos.length > 1) {
        mainVideo = videos.reduce((largest, current) => {
          const largestArea = largest.offsetWidth * largest.offsetHeight;
          const currentArea = current.offsetWidth * current.offsetHeight;
          return currentArea > largestArea ? current : largest;
        });
      }

      const videoUrl = mainVideo.currentSrc || mainVideo.src;
      
      const sources = mainVideo.querySelectorAll('source');
      if (sources.length > 0) {
        sources.forEach(source => {
          const url = source.src;
          const type = source.type || '';
          const quality = source.getAttribute('data-quality') || 
                         source.getAttribute('label') || 
                         'available';
          
          if (url && type.includes('video')) {
            results.qualities.push({
              quality: quality,
              url: url,
              label: quality.toUpperCase()
            });
          }
        });
      } else if (videoUrl) {
        results.qualities.push({
          quality: 'available',
          url: videoUrl,
          label: 'Available Quality'
        });
      }

      results.duration = mainVideo.duration;
      results.thumbnail = mainVideo.poster;

      const titleMeta = document.querySelector('meta[property="og:title"]');
      results.title = titleMeta ? titleMeta.content : document.title;

      const descMeta = document.querySelector('meta[property="og:description"]');
      results.description = descMeta ? descMeta.content : null;

      return results;
    });

    return videoData && videoData.qualities.length > 0 ? videoData : null;

  } catch (error) {
    console.error('DOM extraction error:', error.message);
    return null;
  }
}

/**
 * STRATEGY 3: Network monitoring
 */
async function extractVideoFromNetwork(page, url) {
  try {
    const streams = {
      videos: new Map(),
      audio: null,
      metadata: {}
    };

    const client = await page.target().createCDPSession();
    await client.send('Network.enable');

    client.on('Network.responseReceived', async (params) => {
      try {
        const response = params.response;
        const responseUrl = response.url;
        const contentType = response.mimeType || '';

        if (contentType.includes('video/mp4') || responseUrl.includes('.mp4')) {
          const quality = extractQuality(responseUrl);
          const size = parseInt(response.headers['content-length'] || '0');
          
          const qualityKey = quality || 'available';
          
          if (!streams.videos.has(qualityKey) || 
              streams.videos.get(qualityKey).size < size) {
            streams.videos.set(qualityKey, {
              url: responseUrl.split('&bytestart=')[0],
              quality: qualityKey,
              size: size
            });
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

    await new Promise(resolve => setTimeout(resolve, 3000));

    await page.evaluate(() => {
      const videos = Array.from(document.querySelectorAll('video'));
      if (videos.length > 0) {
        const mainVideo = videos.reduce((largest, current) => {
          const largestArea = largest.offsetWidth * largest.offsetHeight;
          const currentArea = current.offsetWidth * current.offsetHeight;
          return currentArea > largestArea ? current : largest;
        });

        mainVideo.setAttribute('data-main-video', 'true');
        mainVideo.scrollIntoView({ behavior: 'smooth', block: 'center' });
        
        setTimeout(() => {
          mainVideo.play().catch(() => {});
        }, 500);
      }
    });

    await new Promise(resolve => setTimeout(resolve, 5000));

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

    const qualities = Array.from(streams.videos.entries()).map(([quality, data]) => ({
      quality: quality,
      url: data.url,
      label: quality === 'hd' ? 'HD (High Quality)' : 
             quality === 'sd' ? 'SD (Standard Quality)' : 
             'Available Quality'
    }));

    qualities.sort((a, b) => {
      const order = { hd: 0, sd: 1, available: 2 };
      return (order[a.quality] || 3) - (order[b.quality] || 3);
    });

    return {
      qualities: qualities,
      audioUrl: streams.audio?.url || null,
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

/**
 * STRATEGY 4: Mobile deep extraction with aggressive patterns
 * This mimics what apps like AhaFast do
 */
async function extractVideoMobileDeep(page, url) {
  try {
    // Switch to mobile user agent
    await page.setUserAgent('Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36');
    await page.setViewport({ width: 375, height: 667 });

    const response = await page.goto(url, {
      waitUntil: 'networkidle0',
      timeout: 60000
    });

    if (!response || response.status() === 404) {
      throw new Error('Page not found');
    }

    await new Promise(resolve => setTimeout(resolve, 5000));

    // Try to find and click any "See More" or expand buttons
    await page.evaluate(() => {
      const expandButtons = document.querySelectorAll('[role="button"]');
      expandButtons.forEach(btn => {
        const text = btn.textContent?.toLowerCase() || '';
        if (text.includes('see more') || text.includes('show more')) {
          btn.click();
        }
      });
    });

    await new Promise(resolve => setTimeout(resolve, 2000));

    const videoData = await page.evaluate(() => {
      const results = {
        qualities: [],
        audioUrl: null,
        title: null,
        thumbnail: null,
        duration: null,
        description: null
      };

      // Deep script analysis with even more patterns
      const allScripts = document.querySelectorAll('script');
      const videoUrlSet = new Set();

      for (const script of allScripts) {
        const content = script.textContent || '';
        
        // Ultra-comprehensive pattern list
        const patterns = [
          // Standard patterns
          /"playable_url_quality_hd":"([^"]+)"/g,
          /"browser_native_hd_url":"([^"]+)"/g,
          /"playable_url":"([^"]+)"/g,
          /"browser_native_sd_url":"([^"]+)"/g,
          /"download_url":"([^"]+)"/g,
          /"video_url":"([^"]+)"/g,
          
          // Progressive and streaming
          /"progressive_url":"([^"]+)"/g,
          /"playback_url":"([^"]+)"/g,
          /"dash_manifest":"([^"]+)"/g,
          
          // Escaped versions
          /video_url\\":\\"([^"\\]+)/g,
          /playableUrl\\":\\"([^"\\]+)/g,
          /representationUrl\\":\\"([^"\\]+)/g,
          
          // Direct URL patterns
          /https:\/\/[^"'\s]*video[^"'\s]*\.mp4[^"'\s]*/g,
          /https:\/\/[^"'\s]*\.fbcdn\.net[^"'\s]*\.mp4[^"'\s]*/g,
          
          // Base64 encoded patterns
          /btoa\(['"](https:\/\/[^'"]*video[^'"]*)['"]\)/g,
          
          // URL in various object notations
          /url["']?\s*:\s*["'](https:\/\/[^"']*video[^"']*\.mp4[^"']*)/g,
          /src["']?\s*:\s*["'](https:\/\/[^"']*video[^"']*\.mp4[^"']*)/g
        ];

        patterns.forEach(pattern => {
          let match;
          while ((match = pattern.exec(content)) !== null) {
            if (match[1]) {
              let url = match[1]
                .replace(/\\u0025/g, '%')
                .replace(/\\u002F/g, '/')
                .replace(/\\\//g, '/')
                .replace(/\\"/g, '"')
                .replace(/\\/g, '');
              
              // Only add valid video URLs
              if (url.includes('http') && (url.includes('video') || url.includes('.mp4'))) {
                videoUrlSet.add(url);
              }
            }
          }
        });
      }

      // Convert Set to array and categorize by quality
      const videoUrls = Array.from(videoUrlSet);
      const hdUrls = videoUrls.filter(url => 
        url.includes('hd') || url.includes('quality_hd') || url.includes('_hd_')
      );
      const sdUrls = videoUrls.filter(url => 
        url.includes('sd') || url.includes('quality_sd') || url.includes('_sd_')
      );
      const otherUrls = videoUrls.filter(url => 
        !hdUrls.includes(url) && !sdUrls.includes(url)
      );

      // Add HD quality
      if (hdUrls.length > 0) {
        results.qualities.push({
          quality: 'hd',
          url: hdUrls[0],
          label: 'HD (High Quality)'
        });
      }

      // Add SD quality
      if (sdUrls.length > 0) {
        results.qualities.push({
          quality: 'sd',
          url: sdUrls[0],
          label: 'SD (Standard Quality)'
        });
      }

      // Add first available URL if no HD/SD found
      if (results.qualities.length === 0 && otherUrls.length > 0) {
        results.qualities.push({
          quality: 'available',
          url: otherUrls[0],
          label: 'Available Quality'
        });
      }

      // Get metadata
      const titleMeta = document.querySelector('meta[property="og:title"]');
      results.title = titleMeta ? titleMeta.content : document.title;

      const thumbMeta = document.querySelector('meta[property="og:image"]');
      results.thumbnail = thumbMeta ? thumbMeta.content : null;

      const descMeta = document.querySelector('meta[property="og:description"]');
      results.description = descMeta ? descMeta.content : null;

      const durationMeta = document.querySelector('meta[property="og:video:duration"]');
      results.duration = durationMeta ? durationMeta.content : null;

      return results;
    });

    // Clean up URLs
    videoData.qualities = videoData.qualities.map(q => ({
      ...q,
      url: decodeURIComponent(q.url)
    }));

    return (videoData.qualities.length > 0) ? videoData : null;

  } catch (error) {
    console.error('Mobile deep extraction error:', error.message);
    return null;
  }
}

function extractQuality(url) {
  if (url.includes('_hd') || url.includes('quality_hd') || url.includes('hd_')) {
    return 'hd';
  }
  
  if (url.includes('_sd') || url.includes('quality_sd') || url.includes('sd_')) {
    return 'sd';
  }

  const patterns = [
    /(\d+)p\.mp4/,
    /height_(\d+)/,
    /(\d+)p/,
    /res_(\d+)/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      const resolution = parseInt(match[1]);
      if (resolution >= 720) return 'hd';
      if (resolution >= 360) return 'sd';
    }
  }
  
  return null;
}

async function mergeStreams(videoUrl, audioUrl, outputDir) {
  const videoPath = path.join(outputDir, `video_${Date.now()}.mp4`);
  const audioPath = path.join(outputDir, `audio_${Date.now()}.mp4`);
  const outputPath = path.join(outputDir, `merged_${Date.now()}.mp4`);

  try {
    console.log('Downloading video and audio streams...');
    await downloadFile(videoUrl, videoPath);
    await downloadFile(audioUrl, audioPath);

    console.log('Merging streams with ffmpeg...');
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(videoPath)
        .input(audioPath)
        .outputOptions([
          '-c:v copy',
          '-c:a aac',
          '-strict experimental',
          '-map 0:v:0',
          '-map 1:a:0',
          '-movflags +faststart',
          '-avoid_negative_ts make_zero'
        ])
        .save(outputPath)
        .on('end', () => {
          console.log('Merge completed successfully');
          resolve();
        })
        .on('error', (err) => {
          console.error('FFmpeg error:', err);
          reject(err);
        });
    });

    await fs.unlink(videoPath).catch(() => {});
    await fs.unlink(audioPath).catch(() => {});

    return outputPath;
    } catch (error) {
    await fs.unlink(videoPath).catch(() => {});
    await fs.unlink(audioPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});
    throw error;
  }
}

/**
 * Download file helper with stream support
 */
async function downloadFile(url, outputPath) {
  const https = require('https');
  const http = require('http');

  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    const request = protocol.get(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Encoding': 'identity'
      }
    }, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download file: ${response.statusCode}`));
        return;
      }

      const fileStream = fsSync.createWriteStream(outputPath);
      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close(resolve);
      });
    });

    request.on('error', (err) => {
      fsSync.unlink(outputPath, () => {});
      reject(err);
    });

    request.setTimeout(30000, () => {
      request.destroy();
      reject(new Error('Download timeout'));
    });
  });
}

/**
 * Auto-clean temp folder (optional safety)
 */
async function cleanupTempFolder(tempDir, maxAgeMinutes = 60) {
  try {
    const files = await fs.readdir(tempDir);
    const now = Date.now();

    for (const file of files) {
      const filePath = path.join(tempDir, file);
      const stats = await fs.stat(filePath);

      if ((now - stats.mtimeMs) / 60000 > maxAgeMinutes) {
        await fs.unlink(filePath).catch(() => {});
      }
    }
  } catch (err) {
    console.warn('Temp cleanup warning:', err.message);
  }
}

module.exports = router;
