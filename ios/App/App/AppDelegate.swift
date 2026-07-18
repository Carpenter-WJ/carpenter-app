import UIKit
import Capacitor
import FirebaseCore
import GoogleSignIn

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    // TODO: 임시 디버깅용 — Firebase를 스토리보드/플러그인 로딩보다 먼저 초기화하기 위해
    // didFinishLaunchingWithOptions보다도 이른 시점인 init()에서 실행 (원인 파악 후 정리)
    override init() {
        super.init()
        let plistPath = Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist")
        NSLog("DIAGNOSTIC: GoogleService-Info.plist path = %@", plistPath ?? "NOT FOUND")
        if FirebaseApp.app() == nil {
            FirebaseApp.configure()
        }
        NSLog("DIAGNOSTIC: after configure, FirebaseApp.app() = %@", FirebaseApp.app() == nil ? "nil" : "configured, clientID=\(FirebaseApp.app()?.options.clientID ?? "none")")
        if let clientID = FirebaseApp.app()?.options.clientID {
            GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: clientID)
            NSLog("DIAGNOSTIC: GIDSignIn configured with clientID")
        } else {
            NSLog("DIAGNOSTIC: GIDSignIn NOT configured — no clientID available")
        }
    }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        // TODO: 임시 디버깅용 — 원인 파악 후 제거 (릴리즈 빌드에서 사파리 원격 디버깅 활성화)
        if #available(iOS 16.4, *), let bridgeVC = window?.rootViewController as? CAPBridgeViewController {
            bridgeVC.webView?.isInspectable = true
        }
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
        // TODO: 임시 디버깅용 — 원인 파악 후 제거
        if #available(iOS 16.4, *), let bridgeVC = window?.rootViewController as? CAPBridgeViewController {
            bridgeVC.webView?.isInspectable = true
        }
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        // TODO: 임시 디버깅용 — 구글 로그인 OAuth 콜백 URL을 GIDSignIn에 명시적으로 전달 (원인 파악 후 정리)
        if GIDSignIn.sharedInstance.handle(url) {
            return true
        }
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
