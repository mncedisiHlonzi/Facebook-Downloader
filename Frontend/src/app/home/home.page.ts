import { Component, ViewChild, ElementRef, Pipe, PipeTransform, OnDestroy } from '@angular/core';
import { Platform } from '@ionic/angular';
import { Clipboard } from '@capacitor/clipboard';
import { ToastController, AlertController, LoadingController } from '@ionic/angular';
import { HttpClient } from '@angular/common/http';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { NgZone } from '@angular/core';
import { Share } from '@capacitor/share';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { trigger, state, style, transition, animate } from '@angular/animations';
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';

interface DownloadItem {
  id: number;
  name: string;
  thumbnail: string;
  progress: number;
  status: 'Downloading' | 'Completed';
  downloadedSize: string;
  totalSize: string;
  downloadSpeed: string;
  path?: string;
  videoUrl?: string;
  videoData?: string;
  downloadDate?: string;
  downloadTime?: string;
  fileUri?: string;
}

@Pipe({ name: 'timeFormat' })
export class TimeFormatPipe implements PipeTransform {
  transform(value: number): string {
    if (isNaN(value)) return '0:00';
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
  }
}

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  standalone: false,
  animations: [
    trigger('fadeOut', [
      state('in', style({ opacity: 1, transform: 'scale(1)' })),
      state('out', style({ opacity: 0, transform: 'scale(0.95)' })),
      transition('in => out', [animate('600ms ease-in-out')]),
    ])
  ]
})
export class HomePage implements OnDestroy {
  // ADD THIS: Base API URL at the top
  private readonly API_BASE_URL = 'https://facebook-downloader-production.up.railway.app';
  @ViewChild('videoPlayer', { static: false }) videoPlayerRef?: ElementRef<HTMLVideoElement>;

  segment: string = 'url';
  videoUrl: string = '';
  isNativePlatform: boolean = false;
  videoData: any = null;
  downloadingVideos: DownloadItem[] = [];
  downloadedVideos: DownloadItem[] = [];
  isVideoModalOpen = false;
  currentPlayingVideo: SafeResourceUrl | null = null;
  currentPlayingVideoName: string = '';
  isOpeningVideo = false;
  downloadSpeedInterval: any;
  isPlaying: boolean = false;
  isMuted: boolean = false;
  videoProgress: number = 0;
  currentTime: number = 0;
  duration: number = 0;
  showCustomControls: boolean = true;
  controlsTimeout: any;
  isFullscreen: boolean = false;
  completedVideo: DownloadItem | null = null;
  isVideoLoading: boolean = false;

  private fullscreenChangeHandler = () => this.checkFullscreen();

  constructor(
    private platform: Platform,
    private toastController: ToastController,
    private alertController: AlertController,
    private loadingCtrl: LoadingController,
    private http: HttpClient,
    private ngZone: NgZone,
    private sanitizer: DomSanitizer
  ) {
    this.isNativePlatform = Capacitor.isNativePlatform();
    this.loadDownloadHistory();
    this.initializeDownloadDirectory();
  }

  ngOnDestroy() {
    document.removeEventListener('fullscreenchange', this.fullscreenChangeHandler);
    document.removeEventListener('webkitfullscreenchange', this.fullscreenChangeHandler);
    clearTimeout(this.controlsTimeout);
    clearInterval(this.downloadSpeedInterval);
  }

  async ionViewDidEnter() {
    await this.platform.ready();
    await this.checkClipboard();
  }

  private async initializeDownloadDirectory() {
    if (this.isNativePlatform) {
      try {
        await Filesystem.mkdir({
          path: 'Download/Facebook_Download',
          directory: Directory.ExternalStorage,
          recursive: true
        });
        this.presentToast('Ready to save your downloads', 'success');
      } catch (error) {
        console.error('Directory creation error:', error);
        this.presentToast('Could not setup downloads folder', 'warning');
      }
    }
  }

  // Video Player Controls
  private setupVideoPlayer() {
  const video = this.videoPlayerRef?.nativeElement;
  if (!video) return;

  document.addEventListener('fullscreenchange', this.fullscreenChangeHandler);
  document.addEventListener('webkitfullscreenchange', this.fullscreenChangeHandler);

  // Remove poster attribute to prevent overlay
  video.removeAttribute('poster');
  
  video.onplay = () => {
    this.isPlaying = true;
    this.showControlsTemporarily();
  };

  video.onpause = () => {
    this.isPlaying = false;
    this.showCustomControls = true;
    clearTimeout(this.controlsTimeout);
  };

  video.ontimeupdate = () => {
    this.currentTime = video.currentTime;
    this.duration = video.duration || 0;
    this.videoProgress = (video.currentTime / video.duration) * 100 || 0;
  };

  video.onended = () => {
    this.isPlaying = false;
    this.showCustomControls = true;
    this.presentToast('Video finished playing', 'medium');
  };

  video.onclick = (e) => {
    e.stopPropagation();
    this.togglePlay();
  };

  video.onvolumechange = () => {
    this.isMuted = video.muted;
  };

  // Remove oncanplay auto-play logic that might cause overlay
  video.oncanplay = () => {
    // Just ensure the video is ready, don't auto-play
    console.log('Video ready to play');
  };

  // Prevent right-click context menu
  video.oncontextmenu = (e) => {
    e.preventDefault();
    return false;
  };
}

// Updated togglePlay method
togglePlay() {
  const video = this.videoPlayerRef?.nativeElement;
  if (!video) return;

  if (video.paused) {
    video.play().then(() => {
      this.isPlaying = true;
      this.showControlsTemporarily();
    }).catch(e => {
      this.presentToast('Could not play video', 'warning');
    });
  } else {
    video.pause();
    this.isPlaying = false;
  }
}

  toggleMute() {
    const video = this.videoPlayerRef?.nativeElement;
    if (!video) return;
  
    video.muted = !video.muted;
    this.isMuted = video.muted;
    this.presentToast(video.muted ? 'Sound muted' : 'Sound on', 'medium', 1000);
    
    if (!video.muted && video.paused) {
      video.play().catch(e => console.log('Play failed after unmute:', e));
    }
  }

  seekVideo() {
    const video = this.videoPlayerRef?.nativeElement;
    if (!video || !video.duration) return;

    const seekTime = (this.videoProgress / 100) * video.duration;
    video.currentTime = seekTime;
  }

  toggleControls() {
    this.showCustomControls = !this.showCustomControls;
    if (this.showCustomControls && this.isPlaying) {
      this.hideControlsAfterDelay();
    }
  }

  showControlsTemporarily() {
    this.showCustomControls = true;
    this.hideControlsAfterDelay();
  }

  hideControlsAfterDelay() {
    clearTimeout(this.controlsTimeout);
    if (this.isPlaying) {
      this.controlsTimeout = setTimeout(() => {
        this.showCustomControls = false;
      }, 3000);
    }
  }

  private checkFullscreen() {
    this.isFullscreen = !!(document.fullscreenElement || 
                          (document as any).webkitFullscreenElement);
    this.showControlsTemporarily();
  }

  toggleFullscreen() {
    const video = this.videoPlayerRef?.nativeElement;
    if (!video) return;

    if (this.isFullscreen) {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      } else if ((document as any).webkitExitFullscreen) {
        (document as any).webkitExitFullscreen();
      }
      this.presentToast('Exited fullscreen', 'medium', 1000);
    } else {
      if (video.requestFullscreen) {
        video.requestFullscreen();
      } else if ((video as any).webkitEnterFullscreen) {
        (video as any).webkitEnterFullscreen();
      }
      this.presentToast('Entered fullscreen', 'medium', 1000);
    }
  }

  // Video Playback
  async playDownloadedVideo(video: DownloadItem) {
  if (this.isOpeningVideo) return;
  this.isOpeningVideo = true;

  // Set status bar to dark style
  if (this.isNativePlatform) {
    try {
      await StatusBar.setStyle({ style: Style.Dark });
      await StatusBar.setBackgroundColor({ color: '#000000' });
    } catch (error) {
      console.error('Status bar error:', error);
    }
  }

  try {
    let videoUrl: string;

    if (this.isNativePlatform && video.fileUri) {
      videoUrl = Capacitor.convertFileSrc(video.fileUri);
    } else if (video.videoData) {
      const blob = this.b64toBlob(video.videoData, 'video/mp4');
      videoUrl = URL.createObjectURL(blob);
    } else {
      throw new Error('No playable video source');
    }

    this.currentPlayingVideo = this.sanitizer.bypassSecurityTrustResourceUrl(videoUrl);
    this.currentPlayingVideoName = video.name.replace('.mp4', '');
    
    // Show spinner overlay immediately
    this.isVideoLoading = true;
    this.isVideoModalOpen = true;

    // Wait for modal to be fully open
    setTimeout(() => {
      const videoElement = this.videoPlayerRef?.nativeElement;
      if (!videoElement) {
        this.isVideoLoading = false;
        return;
      }

      this.setupVideoPlayer();

      // Set initial video properties
      videoElement.muted = true;
      videoElement.preload = 'metadata';
      videoElement.poster = '';
      videoElement.controls = false;
      
      // Reset states
      this.isMuted = true;
      this.showCustomControls = false; // Hide controls until video starts
      this.isPlaying = false;
      this.currentTime = 0;
      this.duration = 0;
      this.videoProgress = 0;

      // Load the video
      videoElement.load();

      // When video starts playing (duration counting begins)
      videoElement.ontimeupdate = () => {
        this.currentTime = videoElement.currentTime;
        this.duration = videoElement.duration || 0;
        this.videoProgress = (videoElement.currentTime / videoElement.duration) * 100 || 0;
        
        // Hide spinner when time starts counting
        if (this.currentTime > 0 && this.isVideoLoading) {
          this.ngZone.run(() => {
            this.isVideoLoading = false;
            this.showCustomControls = true;
            this.showControlsTemporarily();
          });
        }
      };

      // Auto-play when ready
      videoElement.oncanplay = async () => {
        try {
          await videoElement.play();
          this.isPlaying = true;
        } catch (error) {
          console.log('Autoplay failed:', error);
          // Hide spinner even if autoplay fails
          this.ngZone.run(() => {
            this.isVideoLoading = false;
            this.showCustomControls = true;
          });
        }
      };

      // Fallback timeout to hide spinner
      setTimeout(() => {
        if (this.isVideoLoading) {
          this.ngZone.run(() => {
            this.isVideoLoading = false;
            this.showCustomControls = true;
          });
        }
      }, 8000);

    }, 100);

  } catch (error) {
    console.error('Playback error:', error);
    this.isVideoLoading = false;
    this.presentToast('Could not play this video', 'danger');
  } finally {
    this.isOpeningVideo = false;
  }
}


  async closeVideoPlayer() {
  if (this.isFullscreen) {
    if (document.exitFullscreen) {
      document.exitFullscreen();
    } else if ((document as any).webkitExitFullscreen) {
      (document as any).webkitExitFullscreen();
    }
  }
  
  // Revert status bar to default style
  if (this.isNativePlatform) {
    try {
      // Set back to light style (or your app's default)
      await StatusBar.setStyle({ style: Style.Light });
      // Revert background color if needed
      await StatusBar.setBackgroundColor({ color: '#f0f0f0' });
    } catch (error) {
      console.error('Status bar error:', error);
    }
  }
  
  this.isVideoModalOpen = false;
  this.currentPlayingVideo = null;
  this.currentPlayingVideoName = '';
  this.isPlaying = false;
  clearTimeout(this.controlsTimeout);
}

  // Clipboard and Download
  async checkClipboard() {
    try {
      let clipboardValue: string | null = null;

      if (this.isNativePlatform) {
        const { value } = await Clipboard.read();
        clipboardValue = value;
      } else if (navigator.clipboard?.readText) {
        clipboardValue = await navigator.clipboard.readText();
      }

      if (clipboardValue?.includes('facebook.com')) {
        this.videoUrl = clipboardValue;
        this.presentToast('We found a Facebook link in your clipboard!', 'success');
        this.fetchVideoData(this.videoUrl);
      }
    } catch (error) {
      console.error('Clipboard access error:', error);
    }
  }

  async pasteClipboard() {
    try {
      if (this.isNativePlatform) {
        const { value } = await Clipboard.read();
        this.videoUrl = value;
      } else if (navigator.clipboard?.readText) {
        this.videoUrl = await navigator.clipboard.readText();
      }
      
      if (this.videoUrl.includes('facebook.com')) {
        this.presentToast('Checking your video link...', 'medium');
        this.fetchVideoData(this.videoUrl);
      } else {
        this.presentToast('Please paste a valid Facebook video link', 'warning');
      }
    } catch (error) {
      this.presentToast('Unable to access your clipboard', 'danger');
    }
  }

  async fetchVideoData(url: string) {
    const loading = await this.loadingCtrl.create({ 
      message: 'Getting your video ready...',
      spinner: 'circular',
      cssClass: 'custom-loading'
    });
    await loading.present();
  
    this.presentToast('Looking for your video...', 'medium', 2000);
  
    this.http.post<any>(`${this.API_BASE_URL}/fetch-fb-video-data`, { url }).subscribe({
      next: async (response) => {
        await loading.dismiss();
  
        if (response?.status === 'success') {
          const generatingToast = await this.toastController.create({
            message: 'Creating video preview...',
            duration: 1500,
            position: 'bottom',
            color: 'medium'
          });
          await generatingToast.present();
  
          if (!response.data.thumbnail && response.data.videoUrl) {
            try {
              response.data.thumbnail = await this.generateVideoThumbnail(response.data.videoUrl);
              await generatingToast.dismiss();
            } catch (error) {
              console.error('Thumbnail generation failed:', error);
              response.data.thumbnail = '../assets/images/defaultThumbnail.png';
              await generatingToast.dismiss();
            }
          }
  
          this.videoData = response.data;
          
          const alert = await this.alertController.create({
            header: 'Ready to Download!',
            message: 'Your video is ready. Tap the download button to save it.',
            buttons: [
              {
                text: 'Got It',
                cssClass: 'alert-button-confirm',
                handler: () => {
                  this.presentToast('You can now download this video', 'success');
                }
              }
            ],
            cssClass: 'custom-alert'
          });
          await alert.present();
        } else {
          this.videoData = null;
          this.presentToast('We couldn\'t find a video at this link', 'warning');
        }
      },
      error: async (err) => {
        await loading.dismiss();
        console.error(err);
        
        let errorMessage = 'Sorry, we couldn\'t process this video';
        if (err.status === 404) {
          errorMessage = 'Video not found - please check the link';
        } else if (err.status === 403) {
          errorMessage = 'This video might be private or unavailable';
        } else if (err.status === 0) {
          errorMessage = 'Connection issue - please check your internet';
        }
        
        this.presentToast(errorMessage, 'danger', 3000);
      }
    });
  }

  async downloadVideo() {
    if (!this.videoData?.videoUrl) {
      this.presentToast('No video available to download', 'warning');
      return;
    }
  
    const loading = await this.loadingCtrl.create({
      message: 'Starting your download...',
      spinner: 'circular',
      cssClass: 'download-loading'
    });
    await loading.present();

    const fileName = `fb_video_${Date.now()}.mp4`;
    const filePath = `Download/Facebook_Download/${fileName}`;
    
    const downloadItem: DownloadItem = {
      id: Date.now(),
      name: fileName,
      thumbnail: this.videoData.thumbnail || '../assets/images/defaultThumbnail.png',
      progress: 0,
      status: 'Downloading',
      downloadedSize: '0 MB',
      totalSize: '0 MB',
      downloadSpeed: '0 KB/s',
      videoUrl: this.videoData.videoUrl,
      path: filePath
    };

    this.downloadingVideos.push(downloadItem);
    await loading.dismiss();
    this.presentToast('Download started - please wait...', 'success');

    try {
      if (this.isNativePlatform) {
        await this.downloadWithCapacitor(downloadItem);
      } else {
        await this.downloadForWeb(downloadItem);
      }
    } catch (error) {
      console.error('Download failed:', error);
      this.ngZone.run(() => {
        this.downloadingVideos = this.downloadingVideos.filter(v => v.id !== downloadItem.id);
        this.presentToast('Download failed - please try again', 'danger');
      });
    }
  }

  private async downloadWithCapacitor(downloadItem: DownloadItem) {
    const CHUNK_SIZE = 5 * 1024 * 1024;
    let startByte = 0;
    let fileSize = 0;
    let lastUpdateTime = Date.now();
    let lastLoadedBytes = 0;
    let speedSamples: number[] = [];
    const MAX_SAMPLES = 5;
    let totalDownloadedBytes = 0;

    try {
      const headResponse = await fetch(downloadItem.videoUrl!, { method: 'HEAD' });
      fileSize = parseInt(headResponse.headers.get('content-length') || '0', 10);
      downloadItem.totalSize = this.formatFileSize(fileSize);
    } catch (error) {
      console.error('Error getting file size:', error);
      this.presentToast('Could not get video size', 'warning');
    }

    await Filesystem.writeFile({
      path: downloadItem.path!,
      data: '',
      directory: Directory.ExternalStorage,
      recursive: true
    });

    this.downloadSpeedInterval = setInterval(() => {
      if (speedSamples.length > 0) {
        const avgSpeed = speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length;
        const speedText = this.formatDownloadSpeed(avgSpeed);
        
        this.ngZone.run(() => {
          const item = this.downloadingVideos.find(v => v.id === downloadItem.id);
          if (item) {
            item.downloadSpeed = speedText;
          }
        });
        
        speedSamples = [];
      }
    }, 1000);

    const controller = new AbortController();
    const signal = controller.signal;

    try {
      while (startByte < fileSize) {
        const endByte = Math.min(startByte + CHUNK_SIZE - 1, fileSize - 1);
        
        const response = await fetch(downloadItem.videoUrl!, {
          headers: { 'Range': `bytes=${startByte}-${endByte}` },
          signal
        });

        if (!response.ok && response.status !== 206) {
          throw new Error(`Download failed with status ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('Failed to get reader from response');

        let chunkBytesReceived = 0;
        let chunks: Uint8Array[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          chunks.push(value);
          chunkBytesReceived += value.length;
          totalDownloadedBytes += value.length;

          const now = Date.now();
          const timeDiff = (now - lastUpdateTime) / 1000;

          if (timeDiff > 0.1) {
            const speed = (totalDownloadedBytes - lastLoadedBytes) / timeDiff;
            speedSamples.push(speed);
            
            if (speedSamples.length > MAX_SAMPLES) {
              speedSamples.shift();
            }

            const percent = Math.round((totalDownloadedBytes / fileSize) * 100);
            const downloadedSize = this.formatFileSize(totalDownloadedBytes);

            this.ngZone.run(() => {
              const item = this.downloadingVideos.find(v => v.id === downloadItem.id);
              if (item) {
                item.progress = Math.min(percent, 100);
                item.downloadedSize = downloadedSize;
              }
            });

            lastLoadedBytes = totalDownloadedBytes;
            lastUpdateTime = now;
          }
        }

        const combinedLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
        const combinedArray = new Uint8Array(combinedLength);
        let offset = 0;
        
        for (const chunk of chunks) {
          combinedArray.set(chunk, offset);
          offset += chunk.length;
        }

        const base64Data = this.arrayBufferToBase64(combinedArray.buffer);
        await Filesystem.appendFile({
          path: downloadItem.path!,
          data: base64Data,
          directory: Directory.ExternalStorage
        });

        startByte = endByte + 1;
      }

      clearInterval(this.downloadSpeedInterval);

      const fileUri = await Filesystem.getUri({
        path: downloadItem.path!,
        directory: Directory.ExternalStorage
      });

      this.ngZone.run(() => {
        downloadItem.status = 'Completed';
        downloadItem.fileUri = fileUri.uri;
        downloadItem.progress = 100;
        downloadItem.downloadedSize = downloadItem.totalSize;
        this.saveToHistory(downloadItem);
        this.downloadingVideos = this.downloadingVideos.filter(v => v.id !== downloadItem.id);
        this.completedVideo = downloadItem; // Set completed video

        // Automatically close the card after 5 seconds
        setTimeout(() => {
          this.closeDownloadCard();
        }, 15000);
        
        this.presentToast('Download complete!', 'success');
      });
    } catch (error) {
      clearInterval(this.downloadSpeedInterval);
      controller.abort();
      throw error;
    }
  }

  closeDownloadCard() {
    this.completedVideo = null; // Clear the completed video
  }

  async shareVideo(video: DownloadItem) {
  try {
    if (!Capacitor.isNativePlatform()) {
      // Web fallback - use Web Share API if available
      if (navigator.share && video.videoData) {
        const blob = this.b64toBlob(video.videoData, 'video/mp4');
        const file = new File([blob], video.name, { type: 'video/mp4' });
        
        await navigator.share({
          title: 'Check out this video!',
          text: `Downloaded from Facebook: ${video.name}`,
          files: [file]
        });
        
        this.presentToast('Video shared successfully!', 'success');
        return;
      } else {
        // Fallback for browsers without Web Share API
        this.presentToast('Sharing not supported on this browser', 'warning');
        return;
      }
    }

    // Native platform sharing
    let shareOptions: any = {
      title: 'Check out this video!',
      text: `Downloaded from Facebook: ${video.name.replace('.mp4', '')}`,
      dialogTitle: 'Share Video'
    };

    // For native platforms, share the actual video file
    if (video.fileUri) {
      shareOptions.url = video.fileUri;
    } else if (video.videoData) {
      // If we only have base64 data, we need to write it to a temporary file first
      const tempFileName = `temp_share_${Date.now()}.mp4`;
      const tempPath = `Download/Facebook_Download/${tempFileName}`;
      
      try {
        await Filesystem.writeFile({
          path: tempPath,
          data: video.videoData.split(',')[1], // Remove data URL prefix
          directory: Directory.ExternalStorage
        });

        const tempUri = await Filesystem.getUri({
          path: tempPath,
          directory: Directory.ExternalStorage
        });

        shareOptions.url = tempUri.uri;
        
        // Clean up temp file after sharing
        setTimeout(async () => {
          try {
            await Filesystem.deleteFile({
              path: tempPath,
              directory: Directory.ExternalStorage
            });
          } catch (error) {
            console.error('Failed to delete temp file:', error);
          }
        }, 5000);
        
      } catch (error) {
        console.error('Failed to create temp file for sharing:', error);
        this.presentToast('Could not prepare video for sharing', 'danger');
        return;
      }
    }

    await Share.share(shareOptions);
    this.presentToast('Video shared successfully!', 'success');
    
  } catch (error) {
    console.error('Share error:', error);
    if (error instanceof Error && error.message !== 'Share canceled') {
      this.presentToast('Sharing failed - please try again', 'danger');
    }
  }
}

// Alternative method for sharing with custom app selection
async shareVideoWithOptions(video: DownloadItem) {
  const alert = await this.alertController.create({
    header: 'Share Video',
    message: 'Choose how to share this video',
    buttons: [
      {
        text: 'WhatsApp',
        handler: () => this.shareToSpecificApp(video, 'whatsapp')
      },
      {
        text: 'Telegram',
        handler: () => this.shareToSpecificApp(video, 'telegram')
      },
      {
        text: 'Other Apps',
        handler: () => this.shareVideo(video)
      },
      {
        text: 'Cancel',
        role: 'cancel'
      }
    ],
    cssClass: 'share-alert'
  });
  
  await alert.present();
}

private async shareToSpecificApp(video: DownloadItem, app: string) {
  // This would require additional setup for specific app sharing
  // For now, fall back to general sharing
  await this.shareVideo(video);
}

  private async downloadForWeb(downloadItem: DownloadItem) {
    const response = await fetch(downloadItem.videoUrl!);
    const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
    downloadItem.totalSize = this.formatFileSize(contentLength);
    
    if (!response.body) {
      throw new Error('No response body');
    }

    const reader = response.body.getReader();
    let receivedLength = 0;
    let chunks: Uint8Array[] = [];
    let lastUpdateTime = Date.now();
    let lastLoadedBytes = 0;
    let speedSamples: number[] = [];
    const MAX_SAMPLES = 5;

    this.downloadSpeedInterval = setInterval(() => {
      if (speedSamples.length > 0) {
        const avgSpeed = speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length;
        const speedText = this.formatDownloadSpeed(avgSpeed);
        
        this.ngZone.run(() => {
          const item = this.downloadingVideos.find(v => v.id === downloadItem.id);
          if (item) {
            item.downloadSpeed = speedText;
          }
        });
        
        speedSamples = [];
      }
    }, 1000);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      receivedLength += value.length;

      const now = Date.now();
      const timeDiff = (now - lastUpdateTime) / 1000;

      if (timeDiff > 0.1) {
        const speed = (receivedLength - lastLoadedBytes) / timeDiff;
        speedSamples.push(speed);
        
        if (speedSamples.length > MAX_SAMPLES) {
          speedSamples.shift();
        }

        const percent = Math.round((receivedLength / contentLength) * 100);
        const downloadedSize = this.formatFileSize(receivedLength);

        this.ngZone.run(() => {
          const item = this.downloadingVideos.find(v => v.id === downloadItem.id);
          if (item) {
            item.progress = percent;
            item.downloadedSize = downloadedSize;
          }
        });

        lastLoadedBytes = receivedLength;
        lastUpdateTime = now;
      }
    }

    clearInterval(this.downloadSpeedInterval);

    const blob = new Blob(chunks);
    downloadItem.videoData = await this.blobToBase64(blob);
    
    this.ngZone.run(() => {
      downloadItem.status = 'Completed';
      downloadItem.progress = 100;
      downloadItem.downloadedSize = downloadItem.totalSize;
      this.saveToHistory(downloadItem);
      this.downloadingVideos = this.downloadingVideos.filter(v => v.id !== downloadItem.id);
      this.presentToast('Download complete!', 'success');
    });
  }

  // Thumbnail Generation (Fixed version)
  private async generateVideoThumbnail(videoUrl: string): Promise<string> {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;

      const timeout = setTimeout(() => {
        cleanup();
        resolve('../assets/images/defaultThumbnail.png');
      }, 10000);

      const cleanup = () => {
        clearTimeout(timeout);
        video.removeEventListener('loadedmetadata', onLoaded);
        video.removeEventListener('error', onError);
        video.src = '';
        video.load();
      };

      const onError = () => {
        cleanup();
        resolve('../assets/images/defaultThumbnail.png');
      };

      const onLoaded = () => {
        const seekPoints = [
          Math.min(1, video.duration * 0.1),
          Math.min(3, video.duration * 0.3),
          Math.min(5, video.duration * 0.5)
        ];
        
        let attempts = 0;
        
        const tryCapture = () => {
          if (attempts >= seekPoints.length) {
            cleanup();
            resolve('../assets/images/defaultThumbnail.png');
            return;
          }
          
          video.currentTime = seekPoints[attempts];
          attempts++;
        };

        const onSeek = () => {
          video.removeEventListener('seeked', onSeek);
          captureFrame();
        };

        video.addEventListener('seeked', onSeek);
        tryCapture();
      };

      const captureFrame = () => {
        setTimeout(() => {
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth || 640;
          canvas.height = video.videoHeight || 360;
          const ctx = canvas.getContext('2d');
          
          if (ctx) {
            try {
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              
              if (!this.isFrameValid(ctx, canvas.width, canvas.height)) {
                video.currentTime += 1;
                return;
              }
              
              const thumbnailUrl = canvas.toDataURL('image/jpeg', 0.8);
              cleanup();
              resolve(thumbnailUrl);
            } catch (error) {
              console.error('Frame capture error:', error);
              cleanup();
              resolve('../assets/images/defaultThumbnail.png');
            }
          } else {
            cleanup();
            resolve('../assets/images/defaultThumbnail.png');
          }
        }, 200);
      };

      video.addEventListener('loadedmetadata', onLoaded, { once: true });
      video.addEventListener('error', onError, { once: true });
      
      video.src = videoUrl;
      video.load();
    });
  }

  private isFrameValid(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
    try {
      const sampleSize = 100;
      const stepX = Math.max(1, Math.floor(width / sampleSize));
      const stepY = Math.max(1, Math.floor(height / sampleSize));
      
      let totalBrightness = 0;
      let samplesTaken = 0;
      
      for (let y = 0; y < height; y += stepY) {
        for (let x = 0; x < width; x += stepX) {
          const pixel = ctx.getImageData(x, y, 1, 1).data;
          const brightness = (pixel[0] + pixel[1] + pixel[2]) / 3;
          totalBrightness += brightness;
          samplesTaken++;
        }
      }
      
      const averageBrightness = totalBrightness / samplesTaken;
      return averageBrightness > 10;
    } catch (error) {
      console.error('Error validating frame:', error);
      return true;
    }
  }

  // Utility Methods
  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  private formatDownloadSpeed(bytesPerSecond: number): string {
    if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`;
    if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private async blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  private b64toBlob(b64Data: string, contentType: string): Blob {
    const byteCharacters = atob(b64Data.split(',')[1]);
    const byteArrays = [];
    
    for (let offset = 0; offset < byteCharacters.length; offset += 512) {
      const slice = byteCharacters.slice(offset, offset + 512);
      const byteNumbers = new Array(slice.length);
      
      for (let i = 0; i < slice.length; i++) {
        byteNumbers[i] = slice.charCodeAt(i);
      }
      
      byteArrays.push(new Uint8Array(byteNumbers));
    }
    
    return new Blob(byteArrays, { type: contentType });
  }

  // Download History Management
  private saveToHistory(video: DownloadItem) {
    const now = new Date();
    video.downloadDate = now.toLocaleDateString();
    video.downloadTime = now.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
    
    const existing = JSON.parse(localStorage.getItem('downloadedVideos') || '[]');
    const filtered = existing.filter((v: DownloadItem) => v.id !== video.id);
    filtered.push(video);
    
    localStorage.setItem('downloadedVideos', JSON.stringify(filtered));
    this.downloadedVideos = filtered;
  }

  private loadDownloadHistory() {
    const data = localStorage.getItem('downloadedVideos');
    if (data) {
      this.downloadedVideos = JSON.parse(data);
    }
  }

  async deleteVideo(id: number) {
    const alert = await this.alertController.create({
      header: 'Delete Video',
      message: 'Are you sure you want to remove this video?',
      buttons: [
        {
          text: 'Cancel',
          role: 'cancel',
          cssClass: 'alert-button-cancel',
          handler: () => {
            this.presentToast('Cancelled - video was not deleted', 'medium');
          }
        },
        {
          text: 'Delete',
          cssClass: 'delete-button',
          handler: async () => {
            const loading = await this.loadingCtrl.create({
              message: 'Removing video...',
              spinner: 'circular',
              duration: 1000,
              cssClass: 'delete-loading'
            });
            await loading.present();

            const video = this.downloadedVideos.find(v => v.id === id);
            if (!video) return;

            if (this.isNativePlatform && video.path) {
              try {
                await Filesystem.deleteFile({
                  path: video.path,
                  directory: Directory.ExternalStorage
                });
              } catch (error) {
                console.error('Delete error:', error);
              }
            }

            this.downloadedVideos = this.downloadedVideos.filter(v => v.id !== id);
            localStorage.setItem('downloadedVideos', JSON.stringify(this.downloadedVideos));
            await loading.dismiss();
            this.presentToast('Video was successfully removed', 'success');
          }
        }
      ],
      cssClass: 'custom-alert'
    });

    await alert.present();
  }

  private async presentToast(message: string, color: string = 'medium', duration: number = 2000) {
    const toast = await this.toastController.create({
      message: message,
      duration: duration,
      //color: color,
      position: 'bottom',
      cssClass: 'custom-toast'
    });
    await toast.present();
  }

  segmentChanged() {
    this.presentToast(`Viewing ${this.segment === 'url' ? 'URL input' : 'Your downloads'}`, 'medium');
  }
}