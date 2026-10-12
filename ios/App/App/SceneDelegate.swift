import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private weak var bridgeViewController: CAPBridgeViewController?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        let bridgeVC = CAPBridgeViewController()
        bridgeViewController = bridgeVC
        window?.rootViewController = bridgeVC
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)

        // The WKWebView Capacitor wraps runs edge-to-edge behind the Dynamic
        // Island/notch — but `env(safe-area-inset-*)` has been observed
        // reporting 0 inside that WKWebView regardless of viewport-fit=cover
        // or ios.contentInset config. UIKit's own safeAreaInsets is always
        // correct, so read it here and hand it to the page as CSS custom
        // properties instead of trusting env() to propagate it. Retried a
        // few times to cover the webview not existing yet / the page not
        // having loaded on the very first attempt, and re-run on rotation
        // since the inset changes between portrait and landscape.
        scheduleSafeAreaInjection(retriesRemaining: 10)

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(injectSafeAreaInsetsNow),
            name: UIDevice.orientationDidChangeNotification,
            object: nil
        )
    }

    private func scheduleSafeAreaInjection(retriesRemaining: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self = self else { return }
            self.injectSafeAreaInsetsNow()
            if retriesRemaining > 0 {
                self.scheduleSafeAreaInjection(retriesRemaining: retriesRemaining - 1)
            }
        }
    }

    @objc private func injectSafeAreaInsetsNow() {
        guard let bridgeVC = bridgeViewController, let webView = bridgeVC.bridge?.webView else { return }
        let insets = bridgeVC.view.safeAreaInsets
        let js = """
        document.documentElement.style.setProperty('--native-safe-area-top', '\(insets.top)px');
        document.documentElement.style.setProperty('--native-safe-area-bottom', '\(insets.bottom)px');
        """
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
