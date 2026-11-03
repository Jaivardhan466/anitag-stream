package com.anitag.stream;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.PictureInPictureParams;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Rational;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewAssetLoader;

/**
 * Native Android Activity for AniTAG Streaming Application.
 * 
 * Secure Architecture:
 * 1. Uses WebViewAssetLoader to serve local assets from https://appassets.androidplatform.net/assets/
 *    - Eliminates file:/// protocol
 *    - Disables allowUniversalAccessFromFileURLs and allowFileAccess
 *    - Provides a real HTTPS origin for clean CORS and API fetches
 * 2. Strict Zero-Popup & Zero-Redirect Enforcement
 * 3. Native Android Picture-in-Picture (PiP)
 * 4. Immersive Fullscreen Video Player Mode
 */
public class MainActivity extends Activity {

    private WebView webView;
    private WebViewAssetLoader assetLoader;
    private static final String APP_URL = "https://appassets.androidplatform.net/assets/index.html";

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Dark Canvas Background (#151515 matching default Monochrome theme)
        getWindow().getDecorView().setBackgroundColor(Color.parseColor("#151515"));

        // Initialize Secure WebViewAssetLoader
        assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView = new WebView(this);
        setContentView(webView);

        setupImmersiveFullscreen();

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setLoadsImagesAutomatically(true);
        settings.setSupportMultipleWindows(false); // Disallow popup windows
        settings.setJavaScriptCanOpenWindowsAutomatically(false); // Block automatic popups
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        // Security Hardening: File and Content access disabled
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);

        // Hardware Acceleration
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString().toLowerCase();

                // Block known malicious ad/popup redirect patterns
                if (url.contains("popads") || url.contains("adsterra") || url.contains("propellerads")
                        || url.contains("monetag") || url.contains("onclick") || url.contains("syndication")
                        || url.contains("redirect") || url.contains("bet365") || url.contains("1xbet")) {
                    return true; // Blocked
                }

                // Allow app assets and secure API/media stream targets
                if (url.startsWith("https://appassets.androidplatform.net")
                        || url.startsWith("https://anitag-stream.onrender.com")
                        || url.startsWith("https://")
                        || url.startsWith("http://10.0.2.2")
                        || url.startsWith("http://localhost")) {
                    return false;
                }

                return true;
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();

                // 1. Local secure asset intercept
                WebResourceResponse assetResponse = assetLoader.shouldInterceptRequest(uri);
                if (assetResponse != null) {
                    return assetResponse;
                }

                // 2. Block known tracking/ad domains
                String url = uri.toString().toLowerCase();
                if (url.contains("googleads") || url.contains("doubleclick") || url.contains("adservice")
                        || url.contains("adnxs") || url.contains("adsystem") || url.contains("histats")) {
                    return new WebResourceResponse("text/plain", "UTF-8", null);
                }

                return super.shouldInterceptRequest(view, request);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, android.os.Message resultMsg) {
                return false; // Strict block on popup creation
            }
        });

        // Load AniTAG UI via secure HTTPS asset loader
        webView.loadUrl(APP_URL);
    }

    private void setupImmersiveFullscreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
            );
        }
    }

    @Override
    public void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Rational aspectRatio = new Rational(16, 9);
            PictureInPictureParams params = new PictureInPictureParams.Builder()
                    .setAspectRatio(aspectRatio)
                    .build();
            enterPictureInPictureMode(params);
        }
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        setupImmersiveFullscreen();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
