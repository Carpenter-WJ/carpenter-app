// 번들러 없는 정적 앱에서 Capacitor 플러그인을 쓰기 위한 최소 브릿지.
// esbuild로 IIFE 번들링해서 window.Capacitor / window.FirebaseAuthentication으로 노출한다.
import { Capacitor } from '@capacitor/core';
import { FirebaseAuthentication } from '@capacitor-firebase/authentication';

window.Capacitor = Capacitor;
window.FirebaseAuthentication = FirebaseAuthentication;
