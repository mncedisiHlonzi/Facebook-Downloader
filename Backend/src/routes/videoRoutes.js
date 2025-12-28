const express = require('express');
const router = express.Router();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

/**
 * STRATEGY: Instead of monitoring all network traffic and trying to guess which video is correct,
 * we use a DOM-based approach to extract video URLs directly from the page's JavaScript data.
 * This is far more reliable because Facebook embeds video metadata in the page source.
 */

router.post('/fetch-fb-video-data', async (req, res) => {
  const { url } = req.body;
  const tempDir = path.join(__dirname, 'temp');

  if (!fsSync.existsSync(tempDir)) {
    fsSync.mkdirSync(tempDir, { recursive: true });
  }

  let browser;
  let page;
  
  try {
    console.log('🎯 Target URL:', url);
    
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--window-size=1920,1080'
      ],
      ignoreHTTPSErrors: true,
      protocolTimeout: 180000
    });

    page = await browser.newPage();
    await page.setDefaultTimeout(60000);
    await page.setDefaultNavigationTimeout(60000);
    
    // Enhanced stealth - remove automation indicators
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      delete window.chrome;
      window.chrome = { runtime: {} };
      
      // Override permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );
    });

    // Use mobile user agent - often bypasses login walls better
    await page.setUserAgent('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36');
    
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120"',
      'sec-ch-ua-mobile': '?1',
      'sec-ch-ua-platform': '"Android"',
      'Upgrade-Insecure-Requests': '1'
    });

    // Try multiple URL formats to bypass login walls
    const urlVariants = [
      url,
      url.replace('www.facebook.com', 'm.facebook.com'),
      url.replace('facebook.com', 'mbasic.facebook.com'),
      url.replace('/share/v/', '/reel/'),
      url.replace('/share/v/', '/watch/?v=')
    ];

    let pageLoaded = false;
    let currentUrl = url;

    for (const testUrl of urlVariants) {
      try {
        console.log(`📄 Trying: ${testUrl.substring(0, 60)}...`);
        
        const response = await page.goto(testUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 45000
        });

        if (!response || response.status() === 404) {
          console.log('   ❌ 404 error');
          continue;
        }

        // Wait for content
        await new Promise(resolve => setTimeout(resolve, 4000));

        // Check page state
        const pageCheck = await page.evaluate(() => {
          const bodyText = document.body.innerText.toLowerCase();
          const hasVideo = document.querySelector('video') !== null ||
                          bodyText.includes('video') ||
                          document.querySelector('[role="main"]') !== null;
          
          return {
            needsLogin: bodyText.includes('log in to facebook') || 
                       bodyText.includes('sign up for facebook') ||
                       (document.querySelector('input[name="email"]') !== null && !hasVideo),
            isError: bodyText.includes('content not found') ||
                    bodyText.includes('this content isn\'t available') ||
                    bodyText.includes('page not found'),
            hasContent: hasVideo || bodyText.length > 500
          };
        });

        console.log(`   Login: ${pageCheck.needsLogin}, Error: ${pageCheck.isError}, Content: ${pageCheck.hasContent}`);

        if (pageCheck.isError) {
          console.log('   ❌ Error page detected');
          continue;
        }

        if (pageCheck.needsLogin && !pageCheck.hasContent) {
          console.log('   ❌ Login wall');
          continue;
        }

        // Success - we have content
        console.log('   ✅ Page loaded successfully');
        pageLoaded = true;
        currentUrl = testUrl;
        break;

      } catch (error) {
        console.log(`   ❌ Failed: ${error.message}`);
        continue;
      }
    }

    if (!pageLoaded) {
      throw new Error('Could not access video. It may be private, deleted, or require login. Try a different video URL format.');
    }

    console.log(`✅ Successfully loaded: ${currentUrl.substring(0, 60)}...`);

    console.log('🔍 Extracting video data from page...');

    // **CORE EXTRACTION LOGIC**
    // Facebook embeds video data in <script> tags as JSON objects
    const videoData = await page.evaluate(() => {
      const extractFromScripts = () => {
        const scripts = Array.from(document.querySelectorAll('script'));
        let allVideoUrls = [];
        let metadata = {
          title: null,
          thumbnail: null,
          duration: null
        };

        // Extract metadata from meta tags first
        const getMeta = (property) => {
          const meta = document.querySelector(`meta[property="${property}"], meta[name="${property}"]`);
          return meta ? meta.content : null;
        };

        metadata.title = getMeta('og:title') || 
                        getMeta('twitter:title') ||
                        document.title.replace(/\s*\|\s*Facebook\s*$/, '').trim() ||
                        'Facebook Video';
        metadata.thumbnail = getMeta('og:image') || getMeta('twitter:image');
        metadata.duration = getMeta('og:video:duration') || getMeta('video:duration');

        // **METHOD 1: Check video element src directly (mobile pages)**
        const videoElements = document.querySelectorAll('video');
        videoElements.forEach(video => {
          if (video.src && video.src.includes('video')) {
            allVideoUrls.push({
              url: video.src,
              quality: video.videoHeight || null,
              source: 'video_element_src'
            });
          }
          
          // Check source elements
          const sources = video.querySelectorAll('source');
          sources.forEach(source => {
            if (source.src && source.src.includes('video')) {
              allVideoUrls.push({
                url: source.src,
                quality: parseInt(source.getAttribute('data-quality')) || null,
                source: 'video_source_element'
              });
            }
          });
        });

        // **METHOD 2: Extract from script tags**
        scripts.forEach(script => {
          const content = script.textContent || script.innerText || '';
          
          try {
            // Pattern 1: video_url fields
            const videoUrlPattern = /"video_url"\s*:\s*"([^"]+)"/g;
            let match;
            while ((match = videoUrlPattern.exec(content)) !== null) {
              allVideoUrls.push({
                url: match[1].replace(/\\u0026/g, '&').replace(/\\/g, ''),
                quality: null,
                source: 'video_url_field'
              });
            }

            // Pattern 2: playable_url fields
            const playablePattern = /"playable_url"\s*:\s*"([^"]+)"/g;
            while ((match = playablePattern.exec(content)) !== null) {
              allVideoUrls.push({
                url: match[1].replace(/\\u0026/g, '&').replace(/\\/g, ''),
                quality: null,
                source: 'playable_url_field'
              });
            }

            // Pattern 3: src fields in video data
            const srcPattern = /"src"\s*:\s*"(https:\/\/[^"]*video[^"]*\.mp4[^"]*)"/g;
            while ((match = srcPattern.exec(content)) !== null) {
              allVideoUrls.push({
                url: match[1].replace(/\\u0026/g, '&').replace(/\\/g, ''),
                quality: null,
                source: 'src_field'
              });
            }

            // Pattern 4: Direct URLs with context
            const urlPattern = /https:\/\/[^\s"']*video[^\s"']*(\.mp4|dash|progressive)[^\s"']*/gi;
            const urlMatches = content.match(urlPattern);
            if (urlMatches) {
              urlMatches.forEach(url => {
                url = url.replace(/\\u0026/g, '&').replace(/\\/g, '').replace(/&amp;/g, '&');
                
                // Extract quality indicators
                const qualityMatch = url.match(/(\d{3,4})p/) || 
                                    url.match(/hd_(\d{3,4})/) ||
                                    url.match(/quality[_=](\d{3,4})/) ||
                                    url.match(/height[_=](\d{3,4})/);
                
                // Extract bitrate
                const bitrateMatch = url.match(/bitrate[_=](\d+)/);
                
                allVideoUrls.push({
                  url: url,
                  quality: qualityMatch ? parseInt(qualityMatch[1]) : null,
                  bitrate: bitrateMatch ? parseInt(bitrateMatch[1]) : null,
                  source: 'url_pattern'
                });
              });
            }

            // Pattern 5: representations array (DASH)
            const repPattern = /"representations"\s*:\s*\[(.*?)\]/gs;
            const repMatches = content.match(repPattern);
            if (repMatches) {
              repMatches.forEach(match => {
                try {
                  const arrayContent = match.match(/\[(.*)\]/s)[1];
                  const repObjects = arrayContent.match(/\{[^{}]*\}/g);
                  
                  if (repObjects) {
                    repObjects.forEach(obj => {
                      try {
                        const parsed = JSON.parse(obj);
                        if (parsed.base_url && parsed.base_url.includes('video')) {
                          allVideoUrls.push({
                            url: parsed.base_url.replace(/\\u0026/g, '&').replace(/\\/g, ''),
                            quality: parsed.height || null,
                            bitrate: parsed.bandwidth || null,
                            source: 'representations'
                          });
                        }
                      } catch (e) {}
                    });
                  }
                } catch (e) {}
              });
            }

            // Pattern 6: Mobile-specific data-video-url attributes
            const dataVideoPattern = /data-video-url="([^"]+)"/g;
            while ((match = dataVideoPattern.exec(content)) !== null) {
              allVideoUrls.push({
                url: match[1].replace(/&amp;/g, '&'),
                quality: null,
                source: 'data_video_url'
              });
            }

          } catch (error) {
            // Continue to next script
          }
        });

        // **METHOD 3: Check for data attributes on page**
        const videoContainers = document.querySelectorAll('[data-video-url], [data-src]');
        videoContainers.forEach(container => {
          const dataUrl = container.getAttribute('data-video-url') || 
                         container.getAttribute('data-src');
          if (dataUrl && dataUrl.includes('video')) {
            allVideoUrls.push({
              url: dataUrl.replace(/&amp;/g, '&'),
              quality: null,
              source: 'data_attribute'
            });
          }
        });

        return {
          videos: allVideoUrls,
          metadata: metadata
        };
      };

      return extractFromScripts();
    });

    console.log(`📦 Found ${videoData.videos.length} video URLs`);

    if (videoData.videos.length === 0) {
      throw new Error('No video URLs found in page. The video may be private or embedded differently.');
    }

    // **INTELLIGENT VIDEO SELECTION**
    // Select the best quality video
    const bestVideo = selectBestVideo(videoData.videos);
    
    if (!bestVideo) {
      throw new Error('Could not determine best video quality');
    }

    console.log(`✅ Selected: ${bestVideo.quality || 'unknown'}p - ${bestVideo.source}`);
    console.log(`🔗 URL: ${bestVideo.url.substring(0, 100)}...`);

    // Try to find matching audio stream
    const audioUrl = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script'));
      let audioUrls = [];

      scripts.forEach(script => {
        const content = script.textContent || '';
        
        // Look for audio URLs
        const audioPattern = /https:\/\/[^\s"']*audio[^\s"']*(\.mp4|dashinit)[^\s"']*/gi;
        const matches = content.match(audioPattern);
        
        if (matches) {
          matches.forEach(url => {
            url = url.replace(/\\u0026/g, '&').replace(/\\/g, '');
            audioUrls.push(url);
          });
        }
      });

      return audioUrls.length > 0 ? audioUrls[0] : null;
    });

    // Prepare response
    const responseData = {
      name: videoData.metadata.title,
      thumbnail: videoData.metadata.thumbnail || '../assets/images/defaultThumbnail.png',
      videoUrl: bestVideo.url,
      audioUrl: audioUrl,
      quality: bestVideo.quality ? `${bestVideo.quality}p` : 'HD',
      duration: videoData.metadata.duration,
      description: videoData.metadata.description || '',
      confidence: 'high',
      debug: {
        totalVideosFound: videoData.videos.length,
        selectedQuality: bestVideo.quality,
        selectedSource: bestVideo.source,
        hasAudio: !!audioUrl
      }
    };

    // If we have both video and audio, try to merge
    if (bestVideo.url && audioUrl) {
      try {
        console.log('🎵 Merging video and audio...');
        const mergedPath = await mergeStreams(bestVideo.url, audioUrl, tempDir);
        const finalUrl = `${req.protocol}://${req.get('host')}/temp/${path.basename(mergedPath)}`;
        
        responseData.videoUrl = finalUrl;
        responseData.quality = 'Merged HD';
        responseData.debug.merged = true;
      } catch (mergeError) {
        console.error('❌ Merge failed:', mergeError.message);
        // Continue with video-only
      }
    }

    return res.json({
      status: 'success',
      data: responseData
    });

  } catch (err) {
    console.error('❌ Scraping error:', err);
    return res.status(500).json({
      status: 'error',
      message: err.message || 'Failed to fetch video data',
      debug: { url }
    });
  } finally {
    if (page) {
      try { await page.close(); } catch (e) {}
    }
    if (browser) {
      await browser.close();
    }
  }
});

/**
 * Select the best quality video from available options
 */
function selectBestVideo(videos) {
  if (videos.length === 0) return null;
  if (videos.length === 1) return videos[0];

  // Remove duplicates based on URL
  const uniqueVideos = [];
  const seenUrls = new Set();
  
  videos.forEach(video => {
    const baseUrl = video.url.split('?')[0].split('&bytestart=')[0];
    if (!seenUrls.has(baseUrl)) {
      seenUrls.add(baseUrl);
      uniqueVideos.push(video);
    }
  });

  console.log(`🎯 Unique videos after deduplication: ${uniqueVideos.length}`);

  // Score each video
  const scoredVideos = uniqueVideos.map(video => {
    let score = 0;
    
    // Quality scoring (highest priority)
    if (video.quality) {
      if (video.quality >= 1080) score += 100;
      else if (video.quality >= 720) score += 80;
      else if (video.quality >= 480) score += 60;
      else if (video.quality >= 360) score += 40;
      else score += 20;
    }

    // Bitrate scoring
    if (video.bitrate) {
      score += Math.min(video.bitrate / 100000, 50); // Cap at 50 points
    }

    // Source reliability
    if (video.source === 'video_url') score += 30;
    else if (video.source === 'playable_url') score += 25;
    else if (video.source === 'representations') score += 20;
    else score += 10;

    // Prefer progressive over DASH
    if (video.url.includes('progressive')) score += 15;
    if (video.url.includes('dash') && !video.url.includes('progressive')) score -= 5;

    // URL length heuristic (shorter URLs tend to be primary videos)
    if (video.url.length < 500) score += 10;

    return { ...video, score };
  });

  // Sort by score (highest first)
  scoredVideos.sort((a, b) => b.score - a.score);

  // Log top 3 candidates
  console.log('🏆 Top 3 candidates:');
  scoredVideos.slice(0, 3).forEach((v, i) => {
    console.log(`  ${i + 1}. Quality: ${v.quality || 'unknown'}p, Score: ${v.score.toFixed(1)}, Source: ${v.source}`);
  });

  return scoredVideos[0];
}

/**
 * Merge video and audio streams using FFmpeg
 */
async function mergeStreams(videoUrl, audioUrl, outputDir) {
  const videoPath = path.join(outputDir, `video_${Date.now()}.mp4`);
  const audioPath = path.join(outputDir, `audio_${Date.now()}.mp4`);
  const outputPath = path.join(outputDir, `merged_${Date.now()}.mp4`);

  try {
    // Download both streams
    await downloadFile(videoUrl, videoPath);
    await downloadFile(audioUrl, audioPath);

    // Merge using FFmpeg
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
        .on('end', resolve)
        .on('error', reject);
    });

    // Cleanup temp files
    await fs.unlink(videoPath).catch(() => {});
    await fs.unlink(audioPath).catch(() => {});

    return outputPath;
  } catch (error) {
    // Cleanup on error
    await fs.unlink(videoPath).catch(() => {});
    await fs.unlink(audioPath).catch(() => {});
    throw error;
  }
}

/**
 * Download a file from URL
 */
async function downloadFile(url, filepath) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
      'Range': 'bytes=0-'
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const writer = fsSync.createWriteStream(filepath);
  
  return new Promise((resolve, reject) => {
    response.body.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

module.exports = router;