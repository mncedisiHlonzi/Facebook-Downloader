import { Component } from '@angular/core';
import { StatusBar, Style } from '@capacitor/status-bar';

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.scss'],
  standalone: false,
})
export class AppComponent {
  constructor() {
    this.initializeApp();
  }

  initializeApp() {
    this.setStatusBar();
  }

  setStatusBar() {
    StatusBar.setBackgroundColor({ color: '#f0f0f0' });
    StatusBar.setStyle({ style: Style.Light });
    StatusBar.setOverlaysWebView({
      overlay: false,
    });
  }

  async setStatusBarColor() {
    await StatusBar.setBackgroundColor({ color: '#f0f0f0' });
  }
}
