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
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
      ]
    });
    
    const page = await browser.newPage();
    
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
      allVideoStreams: [] // Track all streams with metadata
    };

    const postId = extractPostId(url);
    console.log(`Target post ID: ${postId}`);

    await page.setRequestInterception(true);

    page.on('request', (request) => {
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

    page.on('response', async (response) => {
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
          const isTarget = checkIfTargetStream(responseUrl, postId);
          
          const streamData = {
            url: responseUrl.split('&bytestart=')[0].split('&range=')[0],
            quality: quality,
            bitrate: bitrate,
            contentLength: contentLength,
            isTarget: isTarget,
            timestamp: Date.now(),
            responseOrder: streams.allVideoStreams.length,
            isDash: responseUrl.includes('dash'),
            isProgressive: responseUrl.includes('progressive')
          };
          
          streams.allVideoStreams.push(streamData);
          
          // Only store if we can determine quality or if it's a target stream
          if (quality || isTarget) {
            const qualityKey = quality || 'unknown';
            if (!streams.videos.has(qualityKey) || streams.videos.get(qualityKey).bitrate < bitrate) {
              streams.videos.set(qualityKey, streamData);
            }
          }
          
          if (isTarget) {
            streams.targetVideoFound = true;
          }
          
          console.log(`Found video stream: ${quality || 'unknown'}p - Bitrate: ${bitrate} - Target: ${isTarget} - Progressive: ${streamData.isProgressive} - Size: ${contentLength}`);
        }

        if (contentType.includes('audio/mp4') || 
            contentType.includes('audio/') ||
            responseUrl.includes('audio_dashinit')) {
          
          const isTarget = checkIfTargetStream(responseUrl, postId);
          const bitrate = extractBitrate(responseUrl);
          
          const audioData = {
            url: responseUrl.split('&bytestart=')[0].split('&range=')[0],
            isTarget: isTarget,
            bitrate: bitrate,
            timestamp: Date.now(),
            responseOrder: streams.audios.length
          };
          
          if (!streams.audios.find(a => a.url === audioData.url)) {
            streams.audios.push(audioData);
            console.log(`Found audio stream: Target: ${isTarget} - Bitrate: ${bitrate}`);
          }
        }
      } catch (err) {
        console.error('Response handler error:', err);
      }
    });

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
      convertToMobileUrl(url),
      convertToDesktopUrl(url),
      url
    ];

    let pageLoaded = false;
    
    for (const testUrl of urlsToTry) {
      try {
        console.log(`Trying URL: ${testUrl}`);
        
        await page.goto(testUrl, {
          waitUntil: 'networkidle2',
          timeout: 30000
        });

        await new Promise(resolve => setTimeout(resolve, 3000));

        const hasVideo = await page.evaluate(() => {
          return document.querySelectorAll('video').length > 0 || 
                 document.querySelector('[data-testid*="video"]') !== null ||
                 document.querySelector('.videoStage') !== null;
        });

        if (hasVideo) {
          console.log(`Successfully loaded video page with URL: ${testUrl}`);
          pageLoaded = true;
          break;
        }
      } catch (error) {
        console.log(`Failed to load ${testUrl}:`, error.message);
        continue;
      }
    }

    if (!pageLoaded) {
      throw new Error('Could not load video page with any URL variant');
    }

    // Enhanced video interaction with quality triggering
    try {
      const videoInfo = await page.evaluate((targetPostId) => {
        const findMainVideo = () => {
          const videos = Array.from(document.querySelectorAll('video'));
          console.log(`Found ${videos.length} video elements on page`);
          
          if (videos.length === 1) {
            return { video: videos[0], reason: 'only-video' };
          }
          
          const videoAnalysis = videos.map(video => {
            const rect = video.getBoundingClientRect();
            const area = rect.width * rect.height;
            
            const isMainContent = video.closest('article') || 
                                video.closest('[data-pagelet*="FeedUnit"]') ||
                                video.closest('[role="main"]') ||
                                video.closest('main');
            
            const isSuggested = video.closest('[data-pagelet*="RightRail"]') ||
                              video.closest('[data-pagelet*="Suggested"]') ||
                              video.closest('.uiSideNav') ||
                              rect.width < 200;
            
            const distanceFromTop = rect.top + window.scrollY;
            const container = video.closest('div[data-pagelet]') || video.closest('article') || video.parentElement;
            const hasDescription = container && container.querySelector('[data-testid*="post-content"], .userContent, [data-ad-preview]');
            
            return {
              video,
              area,
              isMainContent: !!isMainContent,
              isSuggested: !!isSuggested,
              distanceFromTop,
              hasDescription: !!hasDescription,
              score: 0
            };
          });
          
          videoAnalysis.forEach(analysis => {
            let score = 0;
            
            if (analysis.area > 50000) score += 3;
            else if (analysis.area > 20000) score += 2;
            else if (analysis.area > 5000) score += 1;
            
            if (analysis.isMainContent) score += 5;
            if (analysis.isSuggested) score -= 3;
            
            if (analysis.distanceFromTop < 500) score += 2;
            else if (analysis.distanceFromTop < 1000) score += 1;
            
            if (analysis.hasDescription) score += 2;
            
            analysis.score = score;
          });
          
          videoAnalysis.sort((a, b) => b.score - a.score);
          
          return { 
            video: videoAnalysis[0].video, 
            reason: 'context-analysis',
            score: videoAnalysis[0].score
          };
        };

        const result = findMainVideo();
        const targetVideo = result.video;
        
        if (targetVideo) {
          targetVideo.scrollIntoView({ behavior: 'smooth', block: 'center' });
          targetVideo.setAttribute('data-target-video', 'true');
          
          // More aggressive interaction to trigger higher quality streams
          setTimeout(() => {
            try {
              // Try multiple interaction methods to trigger HD streams
              targetVideo.play().catch(() => {});
              targetVideo.click();
              
              // Try to trigger fullscreen which often loads higher quality
              if (targetVideo.requestFullscreen) {
                targetVideo.requestFullscreen().then(() => {
                  setTimeout(() => {
                    document.exitFullscreen().catch(() => {});
                  }, 500);
                }).catch(() => {});
              }
              
              // Simulate user seeking to trigger quality adaptation
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
                
                // Look for quality/settings buttons
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
      
      // Wait longer for higher quality streams to load
      await new Promise(resolve => setTimeout(resolve, 12000));
      
    } catch (err) {
      console.log('Could not interact with video elements:', err.message);
    }

    // Wait for all streams to load
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

    // Improved stream selection logic
    let bestVideoEntry = selectBestVideoStream(streams, postId);
    let bestAudioUrl = selectBestAudioStream(streams, postId);

    if (!bestVideoEntry) {
      console.log('No streams found via network monitoring, trying alternative method...');
      
      const alternativeStreams = await page.evaluate((targetPostId) => {
        const scripts = Array.from(document.querySelectorAll('script'));
        const videoData = [];
        
        scripts.forEach(script => {
          const content = script.textContent || '';
          
          // Enhanced pattern matching for video URLs
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
                  const quality = extractQualityImproved(url);
                  const bitrate = extractBitrate(url);
                  const isTarget = targetPostId && checkIfTargetStream(url, targetPostId);
                  
                  videoData.push({ 
                    url: url.replace(/\\u0026/g, '&').replace(/\\/g, ''),
                    quality: quality,
                    bitrate: bitrate,
                    isTarget: isTarget
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
        const quality = streamData.quality || 'unknown';
        if (!streams.videos.has(quality) || 
            (streams.videos.get(quality).bitrate || 0) < (streamData.bitrate || 0)) {
          streams.videos.set(quality, streamData);
        }
      });
      
      bestVideoEntry = selectBestVideoStream(streams, postId);
    }

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

    // Try to merge streams if both video and audio are available
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
            debug: {
              postId: postId,
              targetFound: streams.targetVideoFound,
              merged: true,
              originalQuality: quality
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
        debug: {
          postId: postId,
          targetFound: streams.targetVideoFound,
          availableQualities: Array.from(streams.videos.keys()).sort((a, b) => 
            (parseInt(b) || 0) - (parseInt(a) || 0)
          ),
          selectedBitrate: bestVideoEntry?.bitrate
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
    if (browser) {
      await browser.close();
    }
  }
});

// Improved post ID extraction
function extractPostId(url) {
  try {
    const patterns = [
      /\/share\/v\/([^\/\?]+)/,             
      /\/share\/r\/([^\/\?]+)/,             // New pattern for /share/r/ URLs
      /\/videos\/(\d+)/,                    
      /\/posts\/(\d+)/,                     
      /\/video\.php\?v=(\d+)/,              
      /story_fbid=(\d+)/,                   
      /fbid=(\d+)/,                         
      /\/(\d{10,})/,                        
      /watch\/?\?v=(\d+)/,                  
      /permalink\.php.*story_fbid=(\d+)/,   
      /\/reel\/(\d+)/,                      
    ];
    
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }
    
    const urlObj = new URL(url);
    const params = urlObj.searchParams;
    
    for (const [key, value] of params) {
      if ((key.includes('id') || key.includes('fbid') || key === 'v') && 
          (value.length >= 8)) {
        return value;
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error extracting post ID:', error);
    return null;
  }
}

// Significantly improved quality extraction
function extractQualityImproved(url) {
  try {
    // Decode the efg parameter which contains quality information
    const efgMatch = url.match(/efg=([^&]+)/);
    if (efgMatch) {
      try {
        const decodedEfg = decodeURIComponent(efgMatch[1]);
        const efgData = JSON.parse(atob(decodedEfg));
        
        // Extract quality from vencode_tag
        if (efgData.vencode_tag) {
          const qualityMatch = efgData.vencode_tag.match(/(\d+)p/);
          if (qualityMatch) {
            return parseInt(qualityMatch[1]);
          }
        }
      } catch (e) {
        // Continue to other methods if decode fails
      }
    }
    
    // Extract from tag parameter
    const tagMatch = url.match(/tag=([^&]+)/);
    if (tagMatch) {
      const tag = decodeURIComponent(tagMatch[1]);
      const qualityMatch = tag.match(/(\d+)p/);
      if (qualityMatch) {
        return parseInt(qualityMatch[1]);
      }
    }
    
    // Bitrate-based quality estimation
    const bitrateMatch = url.match(/bitrate=(\d+)/);
    if (bitrateMatch) {
      const bitrate = parseInt(bitrateMatch[1]);
      // Estimate quality based on bitrate
      if (bitrate > 3000000) return 1080;
      if (bitrate > 1500000) return 720;
      if (bitrate > 800000) return 480;
      if (bitrate > 400000) return 360;
      return 240;
    }
    
    // Fallback patterns
    const patterns = [
      /(\d+)p\.mp4/,
      /height_(\d+)/,
      /(\d+)p/,
      /hd_(\d+)/,
      /quality_(\d+)/,
      /res_(\d+)/,
      /f(\d+)\//  // Facebook's f1/, f2/, etc. format
    ];
    
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        let quality = parseInt(match[1]);
        // Convert f-number to quality
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

// Extract bitrate from URL
function extractBitrate(url) {
  const bitrateMatch = url.match(/bitrate=(\d+)/);
  return bitrateMatch ? parseInt(bitrateMatch[1]) : 0;
}

// Improved target stream checking
function checkIfTargetStream(url, postId) {
  if (!postId) return false;
  
  // Direct ID matching (case insensitive)
  const postIdLower = postId.toLowerCase();
  const urlLower = url.toLowerCase();
  
  if (urlLower.includes(postIdLower)) {
    return true;
  }
  
  // Check encoded parameters
  try {
    // Check _nc_vs parameter (base64 encoded data)
    const ncVsMatch = url.match(/_nc_vs=([^&]+)/);
    if (ncVsMatch) {
      try {
        const encodedData = decodeURIComponent(ncVsMatch[1]);
        const decodedData = atob(encodedData);
        if (decodedData.toLowerCase().includes(postIdLower)) {
          return true;
        }
      } catch (e) {
        // Try without base64 decode
        const encodedData = decodeURIComponent(ncVsMatch[1]);
        if (encodedData.toLowerCase().includes(postIdLower)) {
          return true;
        }
      }
    }
    
    // Check vs parameter (often contains post correlation)
    const vsMatch = url.match(/vs=([^&]+)/);
    if (vsMatch) {
      const vsValue = vsMatch[1].toLowerCase();
      // Sometimes the vs parameter correlates with post ID through hash
      if (vsValue.includes(postIdLower.slice(-6)) || 
          postIdLower.includes(vsValue.slice(-6))) {
        return true;
      }
    }
    
    // Check efg parameter for asset correlation
    const efgMatch = url.match(/efg=([^&]+)/);
    if (efgMatch) {
      const decodedEfg = decodeURIComponent(efgMatch[1]);
      const efgData = JSON.parse(atob(decodedEfg));
      
      if (efgData.xpv_asset_id) {
        const assetId = efgData.xpv_asset_id.toString();
        // More flexible asset ID matching
        if (assetId.includes(postId) || 
            postId.includes(assetId.slice(-8)) ||
            assetId.slice(-8).includes(postId.slice(-6))) {
          return true;
        }
      }
    }
    
    // Check oh parameter (hash that sometimes correlates)
    const ohMatch = url.match(/oh=([^&]+)/);
    if (ohMatch) {
      const ohValue = ohMatch[1].toLowerCase();
      if (ohValue.includes(postIdLower.slice(-6))) {
        return true;
      }
    }
    
  } catch (e) {
    // Ignore decode errors
  }
  
  return false;
}

// Improved stream selection logic
function selectBestVideoStream(streams, postId) {
  const videoEntries = Array.from(streams.videos.entries());
  
  if (videoEntries.length === 0) {
    return null;
  }
  
  console.log('Selecting from streams:', videoEntries.map(([q, d]) => ({
    quality: q,
    bitrate: d.bitrate,
    size: d.contentLength,
    isProgressive: d.isProgressive,
    isTarget: d.isTarget
  })));
  
  // First priority: Target-specific streams with good quality
  if (postId) {
    const targetStreams = videoEntries.filter(([quality, data]) => data.isTarget);
    if (targetStreams.length > 0) {
      const sorted = targetStreams.sort(([aQ, aData], [bQ, bData]) => {
        const aQuality = parseInt(aQ) || 0;
        const bQuality = parseInt(bQ) || 0;
        if (aQuality !== bQuality) return bQuality - aQuality;
        
        // Prefer progressive over DASH
        if (aData.isProgressive !== bData.isProgressive) {
          return aData.isProgressive ? -1 : 1;
        }
        
        return (bData.bitrate || 0) - (aData.bitrate || 0);
      });
      console.log('Using target-specific video stream');
      return sorted[0][1];
    }
  }
  
  // Second priority: Post-interaction streams
  if (streams.mainVideoInteractionTime) {
    const postInteractionStreams = videoEntries.filter(([quality, data]) => 
      data.timestamp > streams.mainVideoInteractionTime
    );
    
    if (postInteractionStreams.length > 0) {
      const sorted = postInteractionStreams.sort(([aQ, aData], [bQ, bData]) => {
        const aQuality = parseInt(aQ) || 0;
        const bQuality = parseInt(bQ) || 0;
        
        // First sort by quality
        if (aQuality !== bQuality) return bQuality - aQuality;
        
        // Then prefer progressive over DASH
        if (aData.isProgressive !== bData.isProgressive) {
          return aData.isProgressive ? -1 : 1;
        }
        
        // For DASH streams, prefer the one with largest content length
        // (likely the most complete segment)
        if (!aData.isProgressive && !bData.isProgressive) {
          const sizeDiff = (bData.contentLength || 0) - (aData.contentLength || 0);
          if (Math.abs(sizeDiff) > 1000000) { // 1MB difference
            return sizeDiff;
          }
        }
        
        // Finally sort by bitrate
        return (bData.bitrate || 0) - (aData.bitrate || 0);
      });
      
      console.log(`Using post-interaction video stream: ${sorted[0][0]}p (${sorted[0][1].isProgressive ? 'Progressive' : 'DASH'})`);
      return sorted[0][1];
    }
  }
  
  // Third priority: Best quality available with smart DASH handling
  const sortedByQuality = videoEntries.sort(([aQ, aData], [bQ, bData]) => {
    const aQuality = parseInt(aQ) || 0;
    const bQuality = parseInt(bQ) || 0;
    
    // Prioritize quality first
    if (aQuality !== bQuality) {
      return bQuality - aQuality;
    }
    
    // For same quality, prefer progressive over DASH
    if (aData.isProgressive !== bData.isProgressive) {
      return aData.isProgressive ? -1 : 1;
    }
    
    // For DASH streams of same quality, prefer larger file size
    // (indicates more complete/longer segment)
    if (!aData.isProgressive && !bData.isProgressive) {
      const sizeDiff = (bData.contentLength || 0) - (aData.contentLength || 0);
      if (Math.abs(sizeDiff) > 1000000) { // Significant size difference
        return sizeDiff;
      }
    }
    
    // Finally prefer higher bitrate
    return (bData.bitrate || 0) - (aData.bitrate || 0);
  });
  
  const selected = sortedByQuality[0];
  console.log(`Using best quality stream: ${selected[0]}p (${selected[1].isProgressive ? 'Progressive' : 'DASH'}, ${selected[1].contentLength} bytes, ${selected[1].bitrate} bitrate)`);
  return selected[1];
}

function selectBestAudioStream(streams, postId) {
  if (streams.audios.length === 0) return null;
  
  // Prefer target-specific audio
  if (postId) {
    const targetAudio = streams.audios.find(audio => audio.isTarget);
    if (targetAudio) {
      console.log('Using target-specific audio stream');
      return targetAudio.url;
    }
  }
  
  // Sort by bitrate and recency
  const sortedAudios = streams.audios.sort((a, b) => {
    const bitrateDiff = (b.bitrate || 0) - (a.bitrate || 0);
    if (Math.abs(bitrateDiff) > 50000) return bitrateDiff;
    return (b.timestamp || 0) - (a.timestamp || 0);
  });
  
  console.log(`Using best audio stream (bitrate: ${sortedAudios[0].bitrate || 'unknown'})`);
  return sortedAudios[0].url;
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

// Legacy function for compatibility
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

    // Clean up temporary files
    await fs.unlink(videoPath).catch(() => {});
    await fs.unlink(audioPath).catch(() => {});

    return outputPath;
  } catch (error) {
    // Clean up on error
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