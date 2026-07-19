// 번들러 없는 정적 앱에서 Capacitor 플러그인을 쓰기 위한 최소 브릿지.
// esbuild로 IIFE 번들링해서 window.Capacitor 등으로 노출한다.
import { Capacitor } from '@capacitor/core';
import { FirebaseAuthentication } from '@capacitor-firebase/authentication';
import { Browser } from '@capacitor/browser';
import { App } from '@capacitor/app';
import { Purchases } from '@revenuecat/purchases-capacitor';
import { Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

window.Capacitor = Capacitor;
window.FirebaseAuthentication = FirebaseAuthentication;
window.CapacitorBrowser = Browser;
window.CapacitorApp = App;
window.Purchases = Purchases;
window.CapacitorFilesystem = Filesystem;
window.CapacitorShare = Share;
