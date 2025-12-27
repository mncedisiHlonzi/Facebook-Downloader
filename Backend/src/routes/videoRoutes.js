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

  // Ensure temp directory exists
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
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process,VizDisplayCompositor',
        '--disable-blink-features=AutomationControlled',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-extensions',
        '--disable-software-rasterizer',
        '--disable-translate',
        '--disable-site-isolation-trials',
        '--mute-audio',
        '--window-size=375,667'
      ],
      ignoreHTTPSErrors: true,
      protocolTimeout: 180000
    });

    page = await browser.newPage();
    
    // Set longer timeouts
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);
    
    // Enhanced stealth measures
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      
      delete window.chrome;
      window.chrome = { runtime: {} };
    });

    await page.setViewport({ width: 375, height: 667 });

    const streams = {
      videos: new Map(),
      audios: [],
      targetVideoFound: false,
      mainVideoInteractionTime: null,
      allVideoStreams: []
    };

    const postId = extractPostId(url);
    const extractedAssetIds = new Set(); // Track asset IDs we find
    console.log(`Target post ID: ${postId}`);

    // Helper function to setup page handlers
    const setupPageHandlers = (currentPage) => {
      currentPage.on('request', (request) => {
        const resourceType = request.resourceType();
        const requestUrl = request.url();
        
        if (['document', 'xhr', 'fetch'].includes(resourceType) || 
            requestUrl.includes('video') || 
            requestUrl.includes('audio') ||
            requestUrl.includes('.mp4')) {
          request.continue();
        } else if (['image', 'stylesheet', 'font', 'other'].includes(resourceType)) {
          request.abort();
        } else {
          request.continue();
        }
      });

      currentPage.on('response', async (response) => {
        try {
          const responseUrl = response.url();
          const headers = response.headers();
          const contentType = headers['content-type'] || '';
          const contentLength = parseInt(headers['content-length'] || '0');

          if (contentType.includes('video/mp4') || 
              contentType.includes('video/') ||
              responseUrl.includes('.mp4') ||
              responseUrl.includes('video_dashinit')) {
            
            const quality = extractQualityImproved(responseUrl);
            const bitrate = extractBitrate(responseUrl);
            const assetId = extractAssetId(responseUrl);
            
            // Track all asset IDs we encounter
            if (assetId) {
              extractedAssetIds.add(assetId);
            }
            
            // Check if this is the target stream
            const isTarget = checkIfTargetStream(responseUrl, postId, extractedAssetIds);
            
            const streamData = {
              url: responseUrl.split('&bytestart=')[0].split('&range=')[0],
              quality: quality,
              bitrate: bitrate,
              contentLength: contentLength,
              isTarget: isTarget,
              assetId: assetId,
              timestamp: Date.now(),
              responseOrder: streams.allVideoStreams.length,
              isDash: responseUrl.includes('dash'),
              isProgressive: responseUrl.includes('progressive')
            };
            
            streams.allVideoStreams.push(streamData);
            
            if (quality || isTarget) {
              const qualityKey = quality || 'unknown';
              if (!streams.videos.has(qualityKey) || streams.videos.get(qualityKey).bitrate < bitrate) {
                streams.videos.set(qualityKey, streamData);
              }
            }
            
            if (isTarget) {
              streams.targetVideoFound = true;
            }
            
            console.log(`Found video stream: ${quality || 'unknown'}p - Bitrate: ${bitrate} - Asset: ${assetId || 'none'} - Target: ${isTarget} - Progressive: ${streamData.isProgressive} - Size: ${contentLength}`);
          }

          if (contentType.includes('audio/mp4') || 
              contentType.includes('audio/') ||
              responseUrl.includes('audio_dashinit')) {
            
            const assetId = extractAssetId(responseUrl);
            const isTarget = checkIfTargetStream(responseUrl, postId, extractedAssetIds);
            const bitrate = extractBitrate(responseUrl);
            
            const audioData = {
              url: responseUrl.split('&bytestart=')[0].split('&range=')[0],
              isTarget: isTarget,
              assetId: assetId,
              bitrate: bitrate,
              timestamp: Date.now(),
              responseOrder: streams.audios.length
            };
            
            if (!streams.audios.find(a => a.url === audioData.url)) {
              streams.audios.push(audioData);
              console.log(`Found audio stream: Asset: ${assetId || 'none'} - Target: ${isTarget} - Bitrate: ${bitrate}`);
            }
          }
        } catch (err) {
          console.error('Response handler error:', err);
        }
      });
    };

    await page.setRequestInterception(true);
    setupPageHandlers(page);

    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
    
    await page.setExtraHTTPHeaders({
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none'
    });

    const urlsToTry = [
      url,
      convertToMobileUrl(url),
      convertToDesktopUrl(url)
    ];

    let pageLoaded = false;
    
    for (const testUrl of urlsToTry) {
      try {
        console.log(`Trying URL: ${testUrl}`);
        
        const response = await page.goto(testUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 45000
        });

        if (!response || response.status() === 404) {
          console.log(`Got 404 or no response for ${testUrl}`);
          continue;
        }

        await new Promise(resolve => setTimeout(resolve, 5000));

        const pageCheck = await page.evaluate(() => {
          const bodyText = document.body.innerText.toLowerCase();
          const isLoginPage = bodyText.includes('log in to facebook') || 
                             bodyText.includes('sign up for facebook') ||
                             document.querySelector('input[name="email"]') !== null;
          const isErrorPage = bodyText.includes('content not found') ||
                             bodyText.includes('this content isn\'t available') ||
                             bodyText.includes('page not found');
          
          return {
            isLoginPage,
            isErrorPage,
            hasVideo: document.querySelectorAll('video').length > 0 || 
                     document.querySelector('[data-testid*="video"]') !== null ||
                     document.querySelector('.videoStage') !== null,
            url: window.location.href
          };
        });

        console.log('Page check:', pageCheck);

        if (pageCheck.isLoginPage) {
          console.log('Detected login page, trying next URL...');
          continue;
        }

        if (pageCheck.isErrorPage) {
          console.log('Detected error page, trying next URL...');
          continue;
        }

        if (pageCheck.hasVideo) {
          console.log(`Successfully loaded video page with URL: ${testUrl}`);
          pageLoaded = true;
          break;
        } else {
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          const recheckVideo = await page.evaluate(() => {
            return document.querySelectorAll('video').length > 0;
          });
          
          if (recheckVideo) {
            console.log(`Video found after additional wait: ${testUrl}`);
            pageLoaded = true;
            break;
          }
        }
      } catch (error) {
        console.log(`Failed to load ${testUrl}:`, error.message);
        
        if (error.message.includes('detached')) {
          console.log('Frame detached, creating new page...');
          try {
            await page.close();
          } catch (e) {}
          
          page = await browser.newPage();
          page.setDefaultTimeout(60000);
          page.setDefaultNavigationTimeout(60000);
          
          await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            delete window.chrome;
            window.chrome = { runtime: {} };
          });

          await page.setViewport({ width: 375, height: 667 });
          await page.setRequestInterception(true);
          setupPageHandlers(page);

          await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
          
          await page.setExtraHTTPHeaders({
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none'
          });
        }
        
        continue;
      }
    }

    if (!pageLoaded) {
      throw new Error('Could not load video page with any URL variant. The video may be private, deleted, or require login.');
    }

    // Enhanced video interaction with quality triggering
    try {
      const videoInfo = await page.evaluate((targetPostId) => {
        const findMainVideo = () => {
          const videos = Array.from(document.querySelectorAll('video'));
          console.log(`Found ${videos.length} video elements on page`);
          
          if (videos.length === 0) return null;
          if (videos.length === 1) return { video: videos[0], reason: 'only-video', score: 100 };
          
          const videoAnalysis = videos.map(video => {
            const rect = video.getBoundingClientRect();
            const area = rect.width * rect.height;
            
            // Check if in main content area
            const isMainContent = !!(
              video.closest('article') || 
              video.closest('[data-pagelet*="FeedUnit"]') ||
              video.closest('[role="main"]') ||
              video.closest('main') ||
              video.closest('[data-pagelet*="PermalinkPost"]') ||
              video.closest('[data-pagelet="Watch"]')
            );
            
            // Check if in sidebar/suggested
            const isSuggested = !!(
              video.closest('[data-pagelet*="RightRail"]') ||
              video.closest('[data-pagelet*="Suggested"]') ||
              video.closest('.uiSideNav') ||
              video.closest('[aria-label*="Suggested"]') ||
              rect.width < 250  // Sidebar videos are typically smaller
            );
            
            // Check viewport position
            const viewportHeight = window.innerHeight;
            const isInViewport = rect.top >= 0 && rect.bottom <= viewportHeight;
            const distanceFromTop = Math.abs(rect.top);
            
            // Check for post description (strong indicator of main video)
            const container = video.closest('div[data-pagelet]') || 
                             video.closest('article') || 
                             video.parentElement;
            const hasDescription = container && !!(
              container.querySelector('[data-testid*="post-content"]') ||
              container.querySelector('.userContent') ||
              container.querySelector('[data-ad-preview="message"]')
            );
            
            // Check if video has controls or is autoplay
            const hasControls = video.hasAttribute('controls');
            const isAutoplay = video.hasAttribute('autoplay') || video.autoplay;
            
            // Check z-index and visibility
            const style = window.getComputedStyle(video);
            const zIndex = parseInt(style.zIndex) || 0;
            const isVisible = style.display !== 'none' && 
                             style.visibility !== 'hidden' &&
                             style.opacity !== '0';
            
            return {
              video,
              area,
              isMainContent,
              isSuggested,
              distanceFromTop,
              hasDescription,
              isInViewport,
              hasControls,
              isAutoplay,
              zIndex,
              isVisible,
              score: 0
            };
          });
          
          // Calculate scores
          videoAnalysis.forEach(analysis => {
            let score = 0;
            
            // Area scoring (heavily weighted)
            if (analysis.area > 100000) score += 10;
            else if (analysis.area > 50000) score += 7;
            else if (analysis.area > 20000) score += 4;
            else if (analysis.area > 5000) score += 1;
            else score -= 5; // Penalize very small videos
            
            // Content area (critical)
            if (analysis.isMainContent) score += 15;
            if (analysis.isSuggested) score -= 20; // Heavy penalty
            
            // Viewport position
            if (analysis.isInViewport) score += 5;
            if (analysis.distanceFromTop < 300) score += 5;
            else if (analysis.distanceFromTop < 800) score += 2;
            
            // Has description (strong indicator)
            if (analysis.hasDescription) score += 10;
            
            // Controls and autoplay
            if (analysis.hasControls) score += 3;
            if (analysis.isAutoplay) score += 2;
            
            // Visibility and z-index
            if (!analysis.isVisible) score -= 50; // Eliminate hidden videos
            if (analysis.zIndex > 0) score += 2;
            
            analysis.score = score;
          });
          
          // Sort by score
          videoAnalysis.sort((a, b) => b.score - a.score);
          
          // Log top 3 candidates
          console.log('Top video candidates:', videoAnalysis.slice(0, 3).map(v => ({
            score: v.score,
            area: v.area,
            isMainContent: v.isMainContent,
            isSuggested: v.isSuggested,
            hasDescription: v.hasDescription
          })));
          
          return { 
            video: videoAnalysis[0].video, 
            reason: 'enhanced-context-analysis',
            score: videoAnalysis[0].score
          };
        };

        const result = findMainVideo();
        const targetVideo = result?.video;
        
        if (targetVideo) {
          targetVideo.scrollIntoView({ behavior: 'smooth', block: 'center' });
          targetVideo.setAttribute('data-target-video', 'true');
          
          setTimeout(() => {
            try {
              targetVideo.play().catch(() => {});
              targetVideo.click();
              
              if (targetVideo.requestFullscreen) {
                targetVideo.requestFullscreen().then(() => {
                  setTimeout(() => {
                    document.exitFullscreen().catch(() => {});
                  }, 500);
                }).catch(() => {});
              }
              
              targetVideo.currentTime = Math.min(5, targetVideo.duration * 0.1);
              
              const container = targetVideo.closest('div[data-pagelet]') || 
                              targetVideo.closest('article') || 
                              targetVideo.closest('div');
              if (container) {
                const playButtons = container.querySelectorAll('[data-testid*="play"], .playButton, [aria-label*="Play"], [role="button"]');
                playButtons.forEach(button => {
                  if (button.offsetParent !== null) {
                    button.click();
                  }
                });
                
                const qualityButtons = container.querySelectorAll('[aria-label*="quality"], [aria-label*="HD"], [data-testid*="quality"]');
                qualityButtons.forEach(button => {
                  if (button.offsetParent !== null) {
                    button.click();
                  }
                });
              }
              
              targetVideo.preload = 'metadata';
              targetVideo.muted = false;
              targetVideo.dispatchEvent(new Event('loadstart'));
              targetVideo.dispatchEvent(new Event('canplay'));
              targetVideo.dispatchEvent(new Event('playing'));
              
            } catch (e) {
              console.log('Error during video interaction:', e);
            }
          }, 1000);
          
          return {
            found: true,
            method: result.reason,
            score: result.score
          };
        }
        
        return { found: false };
        
      }, postId);
      
      streams.mainVideoInteractionTime = Date.now();
      
      await new Promise(resolve => setTimeout(resolve, 12000));
      
    } catch (err) {
      console.log('Could not interact with video elements:', err.message);
    }

    await new Promise(resolve => setTimeout(resolve, 10000));

    const metadata = await page.evaluate(() => {
      const getMetaContent = (property) => {
        const meta = document.querySelector(`meta[property="${property}"], meta[name="${property}"]`);
        return meta ? meta.content : null;
      };
      
      let title = getMetaContent('og:title') || 
                  document.title ||
                  document.querySelector('h1')?.textContent ||
                  document.querySelector('[data-testid*="post"] h3')?.textContent ||
                  'Facebook Video';
      
      title = title.replace(/\s*\|\s*Facebook\s*$/, '').trim();
      
      return {
        title: title,
        thumbnail: getMetaContent('og:image') || 
                  getMetaContent('twitter:image') ||
                  document.querySelector('video')?.poster,
        duration: getMetaContent('og:video:duration') || 
                 getMetaContent('video:duration'),
        description: getMetaContent('og:description') || 
                    getMetaContent('description')
      };
    });

    console.log('All video streams found:', streams.allVideoStreams.map(s => ({
      quality: s.quality,
      bitrate: s.bitrate,
      isTarget: s.isTarget,
      isProgressive: s.isProgressive,
      contentLength: s.contentLength
    })));

    let bestVideoEntry = selectBestVideoStream(streams, postId);
    let bestAudioUrl = selectBestAudioStream(streams, postId);

    if (!bestVideoEntry) {
      console.log('No streams found via network monitoring, trying alternative method...');
      
      const alternativeStreams = await page.evaluate((targetPostId) => {
        const scripts = Array.from(document.querySelectorAll('script'));
        const videoData = [];
        
        scripts.forEach(script => {
          const content = script.textContent || '';
          
          const patterns = [
            /https:\/\/[^"]*\.mp4[^"]*/g,
            /https:\/\/[^"]*video[^"]*\.mp4[^"]*/g,
            /"video_url":"([^"]+)"/g,
            /"playable_url":"([^"]+)"/g,
            /"src":"([^"]+\.mp4[^"]*)"/g
          ];
          
          patterns.forEach(pattern => {
            const matches = content.match(pattern);
            if (matches) {
              matches.forEach(match => {
                let url = match;
                if (url.startsWith('"')) {
                  url = match.match(/"([^"]+)"/)?.[1] || match;
                }
                
                if (url.includes('video') || url.includes('.mp4')) {
                  videoData.push({ 
                    url: url.replace(/\\u0026/g, '&').replace(/\\/g, ''),
                    quality: null,
                    bitrate: 0,
                    isTarget: false
                  });
                }
              });
            }
          });
        });
        
        return videoData;
      }, postId);
      
      console.log('Alternative streams found:', alternativeStreams.length);
      
      alternativeStreams.forEach(streamData => {
        const quality = extractQualityImproved(streamData.url);
        const bitrate = extractBitrate(streamData.url);
        const assetId = extractAssetId(streamData.url);
        const isTarget = checkIfTargetStream(streamData.url, postId, extractedAssetIds);
        
        streamData.quality = quality;
        streamData.bitrate = bitrate;
        streamData.assetId = assetId;
        streamData.isTarget = isTarget;
        
        if (assetId) {
          extractedAssetIds.add(assetId);
        }
        
        const qualityKey = quality || 'unknown';
        if (!streams.videos.has(qualityKey) || 
            (streams.videos.get(qualityKey).bitrate || 0) < (bitrate || 0)) {
          streams.videos.set(qualityKey, {
            url: streamData.url,
            quality: quality,
            bitrate: bitrate,
            assetId: assetId,
            isTarget: isTarget,
            contentLength: 0,
            timestamp: Date.now(),
            responseOrder: 0,
            isDash: streamData.url.includes('dash'),
            isProgressive: streamData.url.includes('progressive')
          });
        }
      });
      
      bestVideoEntry = selectBestVideoStream(streams, postId);
    }

    // Verify stream selection
    const isVerified = verifyStreamSelection(bestVideoEntry, streams, postId);

    const videoUrl = bestVideoEntry ? (bestVideoEntry.url || bestVideoEntry[1]?.url) : null;
    const quality = bestVideoEntry ? (bestVideoEntry.quality || bestVideoEntry[0]) : null;

    if (!videoUrl) {
      return res.status(404).json({ 
        status: 'error', 
        message: 'No video streams found. The video may be private, deleted, or Facebook has changed their structure.',
        debug: {
          postId: postId,
          totalStreamsFound: streams.videos.size,
          allStreamsCount: streams.allVideoStreams.length,
          targetVideoFound: streams.targetVideoFound
        }
      });
    }

    console.log(`Selected video URL: ${videoUrl} (Quality: ${quality}p, Bitrate: ${bestVideoEntry.bitrate || 'unknown'})`);
    console.log(`Selection confidence: ${bestVideoEntry.isTarget ? 'HIGH' : isVerified ? 'MEDIUM' : 'LOW'}`);

    if (videoUrl && bestAudioUrl) {
      try {
        console.log('Attempting to merge video and audio streams...');
        const mergedPath = await mergeStreams(videoUrl, bestAudioUrl, tempDir);
        const finalUrl = `${req.protocol}://${req.get('host')}/temp/${path.basename(mergedPath)}`;

        return res.json({
          status: 'success',
          data: {
            name: metadata.title,
            thumbnail: metadata.thumbnail,
            videoUrl: finalUrl,
            quality: 'Merged HD',
            duration: metadata.duration,
            description: metadata.description,
            confidence: bestVideoEntry.isTarget ? 'high' : isVerified ? 'medium' : 'low',
            debug: {
              postId: postId,
              targetFound: streams.targetVideoFound,
              merged: true,
              originalQuality: quality,
              confidence: bestVideoEntry.isTarget ? 'high' : isVerified ? 'medium' : 'low'
            }
          }
        });
      } catch (mergeError) {
        console.error('Merge failed, sending video stream only:', mergeError);
      }
    }

    return res.json({
      status: 'success',
      data: {
        name: metadata.title,
        thumbnail: metadata.thumbnail,
        videoUrl: videoUrl,
        audioUrl: bestAudioUrl,
        quality: quality ? `${quality}p` : 'Available',
        duration: metadata.duration,
        description: metadata.description,
        confidence: bestVideoEntry.isTarget ? 'high' : isVerified ? 'medium' : 'low',
        debug: {
          postId: postId,
          targetFound: streams.targetVideoFound,
          availableQualities: Array.from(streams.videos.keys()).sort((a, b) => 
            (parseInt(b) || 0) - (parseInt(a) || 0)
          ),
          selectedBitrate: bestVideoEntry?.bitrate,
          confidence: bestVideoEntry.isTarget ? 'high' : isVerified ? 'medium' : 'low'
        }
      }
    });

  } catch (err) {
    console.error('Scraping error:', err);
    return res.status(500).json({
      status: 'error',
      message: `Scraping failed: ${err.message}`,
      debug: {
        url: url,
        postId: extractPostId(url)
      }
    });
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (e) {}
    }
    if (browser) {
      await browser.close();
    }
  }
});

// IMPROVED POST ID EXTRACTION
function extractPostId(url) {
  try {
    // First, try to get the full URL path for better context
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    
    // Extended patterns with priority order
    const patterns = [
      // Highest priority - most specific patterns
      /\/reel\/(\d+)/,                    // Reels format
      /\/videos\/(\d+)/,                  // Standard video format
      /\/watch\/?\?v=(\d+)/,              // Watch page format
      /\/video\.php\?v=(\d+)/,            // Old format
      
      // Medium priority - share links
      /\/share\/v\/([a-zA-Z0-9_-]+)/,    // New share format
      /\/share\/r\/([a-zA-Z0-9_-]+)/,    // Reel share format
      
      // Lower priority - post formats
      /\/posts\/([a-zA-Z0-9_-]+)/,       // Post format
      /story_fbid=([a-zA-Z0-9_-]+)/,     // Story format
      /fbid=([a-zA-Z0-9_-]+)/,           // FBID param
      /permalink\.php.*story_fbid=([a-zA-Z0-9_-]+)/, // Permalink
      
      // Fallback - any long number in path
      /\/([0-9]{10,})/
    ];
    
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        console.log(`Post ID extracted via pattern: ${pattern}, ID: ${match[1]}`);
        return match[1];
      }
    }
    
    // Check URL parameters
    const params = urlObj.searchParams;
    const paramPriority = ['v', 'video_id', 'story_fbid', 'fbid', 'id'];
    
    for (const param of paramPriority) {
      const value = params.get(param);
      if (value && value.length >= 8) {
        console.log(`Post ID extracted from param ${param}: ${value}`);
        return value;
      }
    }
    
    // Last resort - extract from full URL path
    const segments = pathname.split('/').filter(s => s.length > 0);
    for (const segment of segments) {
      if (/^[0-9]{10,}$/.test(segment)) {
        console.log(`Post ID extracted from path segment: ${segment}`);
        return segment;
      }
    }
    
    console.warn('Could not extract post ID from URL');
    return null;
  } catch (error) {
    console.error('Error extracting post ID:', error);
    return null;
  }
}

function extractQualityImproved(url) {
  try {
    const efgMatch = url.match(/efg=([^&]+)/);
    if (efgMatch) {
      try {
        const decodedEfg = decodeURIComponent(efgMatch[1]);
        const efgData = JSON.parse(atob(decodedEfg));
        
        if (efgData.vencode_tag) {
          const qualityMatch = efgData.vencode_tag.match(/(\d+)p/);
          if (qualityMatch) {
            return parseInt(qualityMatch[1]);
          }
        }
      } catch (e) {}
    }
    
    const tagMatch = url.match(/tag=([^&]+)/);
    if (tagMatch) {
      const tag = decodeURIComponent(tagMatch[1]);
      const qualityMatch = tag.match(/(\d+)p/);
      if (qualityMatch) {
        return parseInt(qualityMatch[1]);
      }
    }
    
    const bitrateMatch = url.match(/bitrate=(\d+)/);
    if (bitrateMatch) {
      const bitrate = parseInt(bitrateMatch[1]);
      if (bitrate > 3000000) return 1080;
      if (bitrate > 1500000) return 720;
      if (bitrate > 800000) return 480;
      if (bitrate > 400000) return 360;
      return 240;
    }
    
    const patterns = [
      /(\d+)p\.mp4/,
      /height_(\d+)/,
      /(\d+)p/,
      /hd_(\d+)/,
      /quality_(\d+)/,
      /res_(\d+)/,
      /f(\d+)\//
    ];
    
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        let quality = parseInt(match[1]);
        if (pattern.source === 'f(\\d+)\\/') {
          const fNumber = quality;
          if (fNumber === 4) quality = 2160;
          else if (fNumber === 3) quality = 1080;
          else if (fNumber === 2) quality = 720;
          else if (fNumber === 1) quality = 480;
          else if (fNumber === 0) quality = 360;
        }
        return quality;
      }
    }

    return null;
  } catch (error) {
    console.error('Error extracting quality:', error);
    return null;
  }
}

function extractBitrate(url) {
  const bitrateMatch = url.match(/bitrate=(\d+)/);
  return bitrateMatch ? parseInt(bitrateMatch[1]) : 0;
}

// NEW: Extract asset ID from stream URL
function extractAssetId(url) {
  try {
    // Check efg parameter for xpv_asset_id
    const efgMatch = url.match(/efg=([^&]+)/);
    if (efgMatch) {
      try {
        const decodedEfg = decodeURIComponent(efgMatch[1]);
        const efgData = JSON.parse(atob(decodedEfg));
        
        if (efgData.xpv_asset_id) {
          return efgData.xpv_asset_id.toString();
        }
        if (efgData.video_id) {
          return efgData.video_id.toString();
        }
        if (efgData.id) {
          return efgData.id.toString();
        }
      } catch (e) {
        // If parsing fails, continue
      }
    }
    
    // Try other patterns
    const patterns = [
      /video_id[=:](\d+)/,
      /asset_id[=:](\d+)/,
      /id[=:](\d+)/
    ];
    
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

// ENHANCED TARGET STREAM CHECKING - Now uses asset ID context
function checkIfTargetStream(url, postId, extractedAssetIds) {
  if (!postId) return false;
  
  const postIdLower = postId.toLowerCase();
  const urlLower = url.toLowerCase();
  
  // Extract asset ID from this stream
  const streamAssetId = extractAssetId(url);
  
  // Strategy 1: If we only have ONE unique asset ID across all streams, it must be the target
  if (extractedAssetIds && extractedAssetIds.size === 1 && streamAssetId) {
    console.log('✓ Target matched: Only one asset ID found across all streams');
    return true;
  }
  
  // Strategy 2: If this is the FIRST stream with this asset ID (not a suggested video)
  // This helps because the main video usually loads first
  if (streamAssetId && extractedAssetIds && extractedAssetIds.size <= 2) {
    // Among the first 2 asset IDs, prefer the larger one
    console.log('✓ Target matched: Early stream (likely main video)');
    return true;
  }
  
  // Strategy 3: Direct match in URL
  if (urlLower.includes(postIdLower)) {
    console.log('✓ Target matched: Direct post ID in URL');
    return true;
  }
  
  // Strategy 4: Check for partial matches (last 8 digits minimum)
  if (postId.length >= 8) {
    const postIdEnd = postIdLower.slice(-8);
    if (urlLower.includes(postIdEnd)) {
      console.log('✓ Target matched: Partial post ID match');
      return true;
    }
  }
  
  try {
    // Strategy 5: Check _nc_vs parameter
    const ncVsMatch = url.match(/_nc_vs=([^&]+)/);
    if (ncVsMatch) {
      try {
        const encodedData = decodeURIComponent(ncVsMatch[1]);
        const decodedData = atob(encodedData);
        if (decodedData.toLowerCase().includes(postIdLower)) {
          console.log('✓ Target matched: Found in _nc_vs');
          return true;
        }
        // Check partial match in decoded data
        if (postId.length >= 8 && decodedData.toLowerCase().includes(postIdLower.slice(-8))) {
          console.log('✓ Target matched: Partial match in _nc_vs');
          return true;
        }
      } catch (e) {
        // Try without base64 decode
        const encodedData = decodeURIComponent(ncVsMatch[1]);
        if (encodedData.toLowerCase().includes(postIdLower)) {
          console.log('✓ Target matched: Found in raw _nc_vs');
          return true;
        }
      }
    }
    
    // Strategy 6: Check efg parameter for asset_id match
    const efgMatch = url.match(/efg=([^&]+)/);
    if (efgMatch) {
      const decodedEfg = decodeURIComponent(efgMatch[1]);
      const efgData = JSON.parse(atob(decodedEfg));
      
      if (efgData.xpv_asset_id || efgData.video_id || efgData.id) {
        const assetId = (efgData.xpv_asset_id || efgData.video_id || efgData.id).toString();
        if (assetId.includes(postId) || postId.includes(assetId)) {
          console.log('✓ Target matched: Found in efg asset ID');
          return true;
        }
        // Check last 8 digits
        if (postId.length >= 8 && assetId.length >= 8) {
          if (assetId.slice(-8) === postIdLower.slice(-8)) {
            console.log('✓ Target matched: Asset ID partial match');
            return true;
          }
        }
      }
    }
    
    // Strategy 7: Check 'vs' parameter
    const vsMatch = url.match(/vs=([^&]+)/);
    if (vsMatch) {
      const vsValue = vsMatch[1].toLowerCase();
      if (vsValue.includes(postIdLower) || 
          (postIdLower.length >= 6 && vsValue.includes(postIdLower.slice(-6)))) {
        console.log('✓ Target matched: Found in vs parameter');
        return true;
      }
    }
    
    // Strategy 8: Check 'oh' hash parameter
    const ohMatch = url.match(/oh=([^&]+)/);
    if (ohMatch && postId.length >= 6) {
      const ohValue = ohMatch[1].toLowerCase();
      if (ohValue.includes(postIdLower.slice(-6))) {
        console.log('✓ Target matched: Found in oh parameter');
        return true;
      }
    }
    
  } catch (e) {
    console.error('Error checking target stream:', e);
  }
  
  return false;
}

// IMPROVED STREAM SELECTION LOGIC
function selectBestVideoStream(streams, postId) {
  const videoEntries = Array.from(streams.videos.entries());
  
  if (videoEntries.length === 0) {
    console.warn('No video streams found');
    return null;
  }
  
  console.log('=== STREAM SELECTION DEBUG ===');
  console.log(`Total streams found: ${videoEntries.length}`);
  console.log(`Target Post ID: ${postId}`);
  
  // Log all asset IDs we found
  const allAssetIds = streams.allVideoStreams.map(s => s.assetId).filter(Boolean);
  const uniqueAssetIds = [...new Set(allAssetIds)];
  console.log(`Unique Asset IDs found: ${uniqueAssetIds.length} - [${uniqueAssetIds.join(', ')}]`);
  
  // PRIORITY 1: Target-specific streams (highest priority)
  if (postId) {
    const targetStreams = videoEntries.filter(([quality, data]) => data.isTarget);
    console.log(`Target-matched streams: ${targetStreams.length}`);
    
    if (targetStreams.length > 0) {
      const sorted = targetStreams.sort(([aQ, aData], [bQ, bData]) => {
        const aQuality = parseInt(aQ) || 0;
        const bQuality = parseInt(bQ) || 0;
        
        // Prefer higher quality
        if (aQuality !== bQuality) return bQuality - aQuality;
        
        // Prefer progressive over DASH
        if (aData.isProgressive !== bData.isProgressive) {
          return aData.isProgressive ? -1 : 1;
        }
        
        // Prefer higher bitrate
        return (bData.bitrate || 0) - (aData.bitrate || 0);
      });
      
      console.log(`✓ SELECTED: Target-matched stream - ${sorted[0][0]}p (Asset: ${sorted[0][1].assetId})`);
      return sorted[0][1];
    }
  }
  
  // PRIORITY 1.5: If only ONE unique asset ID, use the highest quality from it
  if (uniqueAssetIds.length === 1) {
    const singleAssetStreams = videoEntries.filter(([quality, data]) => 
      data.assetId === uniqueAssetIds[0]
    );
    
    if (singleAssetStreams.length > 0) {
      const sorted = singleAssetStreams.sort(([aQ, aData], [bQ, bData]) => {
        const aQuality = parseInt(aQ) || 0;
        const bQuality = parseInt(bQ) || 0;
        if (aQuality !== bQuality) return bQuality - aQuality;
        if (aData.isProgressive !== bData.isProgressive) {
          return aData.isProgressive ? -1 : 1;
        }
        return (bData.bitrate || 0) - (aData.bitrate || 0);
      });
      
      console.log(`✓ SELECTED: Single asset ID stream - ${sorted[0][0]}p (Asset: ${sorted[0][1].assetId})`);
      return sorted[0][1];
    }
  }
  
  // PRIORITY 1.6: Multiple asset IDs but no target match - use LARGEST total size per asset
  if (uniqueAssetIds.length > 1) {
    console.log('⚠ Multiple asset IDs without clear target match - analyzing sizes...');
    
    // Group by asset ID and calculate total sizes
    const assetGroups = {};
    videoEntries.forEach(([quality, data]) => {
      const assetId = data.assetId || 'unknown';
      if (!assetGroups[assetId]) {
        assetGroups[assetId] = {
          streams: [],
          totalSize: 0,
          maxQuality: 0,
          firstTimestamp: Infinity
        };
      }
      assetGroups[assetId].streams.push([quality, data]);
      assetGroups[assetId].totalSize += (data.contentLength || 0);
      assetGroups[assetId].maxQuality = Math.max(
        assetGroups[assetId].maxQuality, 
        parseInt(quality) || 0
      );
      assetGroups[assetId].firstTimestamp = Math.min(
        assetGroups[assetId].firstTimestamp,
        data.timestamp
      );
    });
    
    // Find the "main" asset based on multiple factors
    let bestAssetId = null;
    let bestScore = -1;
    
    Object.entries(assetGroups).forEach(([assetId, group]) => {
      let score = 0;
      
      // Factor 1: Total size (heavily weighted) - main video is usually larger
      score += (group.totalSize / 1000000) * 2; // Points per MB
      
      // Factor 2: Number of quality variants - main video has more qualities
      score += group.streams.length * 10;
      
      // Factor 3: Maximum quality available
      score += group.maxQuality / 10;
      
      // Factor 4: Loading order - first is more likely to be main
      const isFirst = group.firstTimestamp === Math.min(
        ...Object.values(assetGroups).map(g => g.firstTimestamp)
      );
      if (isFirst) score += 20;
      
      console.log(`Asset ${assetId}: Score=${score.toFixed(1)} (Size: ${(group.totalSize/1000000).toFixed(1)}MB, Qualities: ${group.streams.length}, Max: ${group.maxQuality}p, First: ${isFirst})`);
      
      if (score > bestScore) {
        bestScore = score;
        bestAssetId = assetId;
      }
    });
    
    if (bestAssetId && assetGroups[bestAssetId]) {
      const sorted = assetGroups[bestAssetId].streams.sort(([aQ, aData], [bQ, bData]) => {
        const aQuality = parseInt(aQ) || 0;
        const bQuality = parseInt(bQ) || 0;
        if (aQuality !== bQuality) return bQuality - aQuality;
        if (aData.isProgressive !== bData.isProgressive) {
          return aData.isProgressive ? -1 : 1;
        }
        return (bData.bitrate || 0) - (aData.bitrate || 0);
      });
      
      console.log(`✓ SELECTED: Best scoring asset - ${sorted[0][0]}p (Asset: ${bestAssetId}, Score: ${bestScore.toFixed(1)})`);
      return sorted[0][1];
    }
  }
  
  // PRIORITY 2: Post-interaction streams with asset ID preference
  if (streams.mainVideoInteractionTime) {
    const postInteractionStreams = videoEntries.filter(([quality, data]) => 
      data.timestamp > streams.mainVideoInteractionTime
    );
    
    console.log(`Post-interaction streams: ${postInteractionStreams.length}`);
    
    if (postInteractionStreams.length > 0) {
      // Group by asset ID and prefer the one with most streams or largest total size
      const assetGroups = {};
      postInteractionStreams.forEach(([quality, data]) => {
        const assetId = data.assetId || 'unknown';
        if (!assetGroups[assetId]) {
          assetGroups[assetId] = [];
        }
        assetGroups[assetId].push([quality, data]);
      });
      
      // Find the asset ID with the largest total size
      let bestAssetId = null;
      let maxTotalSize = 0;
      
      Object.entries(assetGroups).forEach(([assetId, streams]) => {
        const totalSize = streams.reduce((sum, [q, d]) => sum + (d.contentLength || 0), 0);
        if (totalSize > maxTotalSize) {
          maxTotalSize = totalSize;
          bestAssetId = assetId;
        }
      });
      
      if (bestAssetId && assetGroups[bestAssetId]) {
        const sorted = assetGroups[bestAssetId].sort(([aQ, aData], [bQ, bData]) => {
          const aQuality = parseInt(aQ) || 0;
          const bQuality = parseInt(bQ) || 0;
          if (aQuality !== bQuality) return bQuality - aQuality;
          if (aData.isProgressive !== bData.isProgressive) {
            return aData.isProgressive ? -1 : 1;
          }
          return (bData.bitrate || 0) - (aData.bitrate || 0);
        });
        
        console.log(`✓ SELECTED: Post-interaction stream - ${sorted[0][0]}p (Asset: ${bestAssetId}, Total size: ${maxTotalSize})`);
        return sorted[0][1];
      }
    }
  }
  
  // PRIORITY 3: Fallback - prefer the asset ID with largest total size
  console.warn('⚠ Using fallback selection with asset ID grouping');
  
  // Group all streams by asset ID
  const assetGroups = {};
  videoEntries.forEach(([quality, data]) => {
    const assetId = data.assetId || 'unknown';
    if (!assetGroups[assetId]) {
      assetGroups[assetId] = [];
    }
    assetGroups[assetId].push([quality, data]);
  });
  
  // Find the asset ID with the largest total size
  let bestAssetId = null;
  let maxTotalSize = 0;
  
  Object.entries(assetGroups).forEach(([assetId, streams]) => {
    const totalSize = streams.reduce((sum, [q, d]) => sum + (d.contentLength || 0), 0);
    if (totalSize > maxTotalSize) {
      maxTotalSize = totalSize;
      bestAssetId = assetId;
    }
  });
  
  if (bestAssetId && assetGroups[bestAssetId]) {
    const sorted = assetGroups[bestAssetId].sort(([aQ, aData], [bQ, bData]) => {
      const aQuality = parseInt(aQ) || 0;
      const bQuality = parseInt(bQ) || 0;
      if (aQuality !== bQuality) return bQuality - aQuality;
      if (aData.isProgressive !== bData.isProgressive) {
        return aData.isProgressive ? -1 : 1;
      }
      return (bData.bitrate || 0) - (aData.bitrate || 0);
    });
    
    console.log(`⚠ FALLBACK SELECTED: ${sorted[0][0]}p (Asset: ${bestAssetId}, Total size: ${maxTotalSize})`);
    return sorted[0][1];
  }
  
  // Ultimate fallback - just pick highest quality
  const sorted = videoEntries.sort(([aQ, aData], [bQ, bData]) => {
    const aQuality = parseInt(aQ) || 0;
    const bQuality = parseInt(bQ) || 0;
    if (aQuality !== bQuality) return bQuality - aQuality;
    return (bData.bitrate || 0) - (aData.bitrate || 0);
  });
  
  console.log(`⚠ ULTIMATE FALLBACK: ${sorted[0][0]}p`);
  return sorted[0][1];
}

function selectBestAudioStream(streams, postId) {
  if (streams.audios.length === 0) return null;
  
  // Get all unique asset IDs from video streams
  const videoAssetIds = streams.allVideoStreams
    .map(s => s.assetId)
    .filter(Boolean);
  const uniqueVideoAssetIds = [...new Set(videoAssetIds)];
  
  // If we have a clear target asset ID from video selection, match audio to it
  if (uniqueVideoAssetIds.length === 1) {
    const matchingAudio = streams.audios.find(audio => 
      audio.assetId === uniqueVideoAssetIds[0]
    );
    if (matchingAudio) {
      console.log('Using asset-matched audio stream');
      return matchingAudio.url;
    }
  }
  
  // Fallback to target-specific audio
  if (postId) {
    const targetAudio = streams.audios.find(audio => audio.isTarget);
    if (targetAudio) {
      console.log('Using target-specific audio stream');
      return targetAudio.url;
    }
  }
  
  // Fallback to highest quality audio
  const sortedAudios = streams.audios.sort((a, b) => {
    const bitrateDiff = (b.bitrate || 0) - (a.bitrate || 0);
    if (Math.abs(bitrateDiff) > 50000) return bitrateDiff;
    return (b.timestamp || 0) - (a.timestamp || 0);
  });
  
  console.log(`Using best audio stream (bitrate: ${sortedAudios[0].bitrate || 'unknown'})`);
  return sortedAudios[0].url;
}

// VERIFICATION FUNCTION
function verifyStreamSelection(selectedStream, allStreams, postId) {
  console.log('=== STREAM VERIFICATION ===');
  
  if (!selectedStream) {
    console.error('❌ No stream selected');
    return false;
  }
  
  // If we found a target-matched stream, we're confident
  if (selectedStream.isTarget) {
    console.log('✓ High confidence - stream matched target post ID');
    return true;
  }
  
  // Get all unique asset IDs
  const allAssetIds = Array.from(allStreams.videos.values())
    .map(s => s.assetId)
    .filter(Boolean);
  const uniqueAssetIds = [...new Set(allAssetIds)];
  
  // If only one asset ID exists, high confidence
  if (uniqueAssetIds.length === 1) {
    console.log('✓ High confidence - only one asset ID found');
    return true;
  }
  
  // Check if this stream's asset has significantly more content
  const assetSizes = {};
  Array.from(allStreams.videos.values()).forEach(stream => {
    const assetId = stream.assetId || 'unknown';
    assetSizes[assetId] = (assetSizes[assetId] || 0) + (stream.contentLength || 0);
  });
  
  const selectedAssetSize = assetSizes[selectedStream.assetId] || 0;
  const avgOtherSize = Object.entries(assetSizes)
    .filter(([id]) => id !== selectedStream.assetId)
    .reduce((sum, [, size]) => sum + size, 0) / (Object.keys(assetSizes).length - 1 || 1);
  
  if (selectedAssetSize > avgOtherSize * 1.5) {
    console.log('✓ Medium confidence - selected asset is significantly larger');
    return true;
  }
  
  // Check if selected asset has more quality variants
  const assetQualityCounts = {};
  Array.from(allStreams.videos.values()).forEach(stream => {
    const assetId = stream.assetId || 'unknown';
    assetQualityCounts[assetId] = (assetQualityCounts[assetId] || 0) + 1;
  });
  
  const selectedQualityCount = assetQualityCounts[selectedStream.assetId] || 0;
  const maxOtherCount = Math.max(
    ...Object.entries(assetQualityCounts)
      .filter(([id]) => id !== selectedStream.assetId)
      .map(([, count]) => count),
    0
  );
  
  if (selectedQualityCount > maxOtherCount) {
    console.log('⚠ Medium confidence - selected asset has more quality variants');
    return true;
  }
  
  // If stream was loaded after video interaction, medium confidence
  if (allStreams.mainVideoInteractionTime && selectedStream.timestamp > allStreams.mainVideoInteractionTime) {
    console.log('⚠ Medium confidence - stream loaded after video interaction');
    return true;
  }
  
  console.warn('⚠ Low confidence - could not verify this is the correct video');
  return false;
}

function convertToMobileUrl(url) {
  try {
    let mobileUrl = url;
    
    if (url.includes('www.facebook.com')) {
      mobileUrl = url.replace('www.facebook.com', 'm.facebook.com');
    } else if (url.includes('facebook.com') && !url.includes('m.facebook.com')) {
      mobileUrl = url.replace('facebook.com', 'm.facebook.com');
    }
    
    if (mobileUrl.includes('/watch/')) {
      mobileUrl = mobileUrl.replace('/watch/', '/video.php?v=');
    }
    
    return mobileUrl;
  } catch (error) {
    return url;
  }
}

function convertToDesktopUrl(url) {
  try {
    let desktopUrl = url;
    
    if (url.includes('m.facebook.com')) {
      desktopUrl = url.replace('m.facebook.com', 'www.facebook.com');
    }
    
    return desktopUrl;
  } catch (error) {
    return url;
  }
}

function extractQuality(url) {
  return extractQualityImproved(url);
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
    throw error;
  }
}

async function downloadFile(url, filepath) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'Accept': '*/*',
        'Accept-Encoding': 'identity',
        'Range': 'bytes=0-'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const writer = fsSync.createWriteStream(filepath);
    
    return new Promise((resolve, reject) => {
      response.body.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  } catch (error) {
    console.error(`Download failed for ${url}:`, error);
    throw error;
  }
}

module.exports = router;