import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.ionic.starter',
  appName: 'Fb-Downloader',
  webDir: 'www',
  plugins: {
    FileOpener: {
      packageName: 'com.example.app'
    }
  }
};

export default config;
