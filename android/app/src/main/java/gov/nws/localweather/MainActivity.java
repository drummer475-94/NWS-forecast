package gov.nws.localweather;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.GeolocationPermissions;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.EdgeToEdge;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewAssetLoader;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Hosts the NWS Local Weather web app in a WebView.
 *
 * The HTML/CSS/JS is bundled in the APK and served from a secure https origin via
 * WebViewAssetLoader, so geolocation and localStorage behave exactly as on the website
 * while the app shell loads instantly without a network round trip. Weather, radar and
 * map data are still fetched live from NWS/NOAA and the other documented providers.
 */
public class MainActivity extends ComponentActivity {

    private static final String APP_HOST = WebViewAssetLoader.DEFAULT_DOMAIN;
    private static final String START_URL = "https://" + APP_HOST + "/assets/index.html";

    /** Leaflet is requested from unpkg by index.html; serve the bundled, SRI-identical copy. */
    private static final String LEAFLET_CDN_PREFIX = "https://unpkg.com/leaflet@1.9.4/dist/";
    private static final String LEAFLET_ASSET_DIR = "vendor/leaflet/";

    /** Identifies this client to api.weather.gov, as the NWS API terms request. */
    private static final String USER_AGENT_SUFFIX =
            " NWSLocalWeatherAndroid/" + BuildConfig.VERSION_NAME
                    + " (+https://github.com/drummer475-94/NWS-forecast)";

    private WebView webView;
    private WebViewAssetLoader assetLoader;

    private String pendingGeoOrigin;
    private GeolocationPermissions.Callback pendingGeoCallback;

    private final ActivityResultLauncher<String[]> locationPermissionLauncher =
            registerForActivityResult(new ActivityResultContracts.RequestMultiplePermissions(), result -> {
                boolean granted = Boolean.TRUE.equals(result.get(Manifest.permission.ACCESS_FINE_LOCATION))
                        || Boolean.TRUE.equals(result.get(Manifest.permission.ACCESS_COARSE_LOCATION));
                resolveGeolocation(granted);
                if (!granted) {
                    Toast.makeText(this, R.string.location_denied, Toast.LENGTH_LONG).show();
                }
            });

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        EdgeToEdge.enable(this);
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        webView = new WebView(this);
        webView.setBackgroundColor(ContextCompat.getColor(this, R.color.app_background));
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        // Keep content clear of the status bar, navigation bar, display cutout and keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout()
                    | WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(APP_HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        configureWebView();

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack();
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                }
            }
        });

        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(START_URL);
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // theme + radar-source preferences
        s.setGeolocationEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setAllowFileAccess(false);           // everything is served over https
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setSupportMultipleWindows(false);    // target=_blank links route through shouldOverrideUrlLoading
        s.setUserAgentString(s.getUserAgentString() + USER_AGENT_SUFFIX);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith(LEAFLET_CDN_PREFIX)) {
                    WebResourceResponse leaflet = bundledLeaflet(url.substring(LEAFLET_CDN_PREFIX.length()));
                    if (leaflet != null) {
                        return leaflet;
                    }
                }
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (APP_HOST.equals(uri.getHost())) {
                    return false;
                }
                // External links (NWS details, attributions) open in the user's browser.
                openExternally(uri);
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (hasLocationPermission()) {
                    callback.invoke(origin, true, false);
                    return;
                }
                // A newer request supersedes any unanswered one.
                if (pendingGeoCallback != null) {
                    pendingGeoCallback.invoke(pendingGeoOrigin, false, false);
                }
                pendingGeoOrigin = origin;
                pendingGeoCallback = callback;
                locationPermissionLauncher.launch(new String[] {
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION
                });
            }

            @Override
            public void onGeolocationPermissionsHidePrompt() {
                pendingGeoOrigin = null;
                pendingGeoCallback = null;
            }
        });
    }

    private WebResourceResponse bundledLeaflet(String path) {
        int query = path.indexOf('?');
        if (query >= 0) {
            path = path.substring(0, query);
        }
        if (path.isEmpty() || path.contains("..")) {
            return null;
        }
        String mime;
        if (path.endsWith(".js")) {
            mime = "text/javascript";
        } else if (path.endsWith(".css")) {
            mime = "text/css";
        } else if (path.endsWith(".png")) {
            mime = "image/png";
        } else {
            return null;
        }
        try {
            InputStream in = getAssets().open(LEAFLET_ASSET_DIR + path);
            Map<String, String> headers = new HashMap<>();
            // index.html loads Leaflet with crossorigin + SRI, so the response must be CORS-readable.
            headers.put("Access-Control-Allow-Origin", "*");
            headers.put("Cache-Control", "max-age=31536000, immutable");
            return new WebResourceResponse(mime, mime.startsWith("text/") ? "utf-8" : null,
                    200, "OK", headers, in);
        } catch (IOException e) {
            return null; // fall through to the network copy
        }
    }

    private boolean hasLocationPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED
                || ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void resolveGeolocation(boolean granted) {
        if (pendingGeoCallback != null) {
            pendingGeoCallback.invoke(pendingGeoOrigin, granted, false);
        }
        pendingGeoOrigin = null;
        pendingGeoCallback = null;
    }

    private void openExternally(Uri uri) {
        String scheme = uri.getScheme();
        if (scheme == null) {
            return;
        }
        if (!scheme.equals("https") && !scheme.equals("http")
                && !scheme.equals("mailto") && !scheme.equals("tel")) {
            return; // ignore intent:, javascript:, file: and other unexpected schemes
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.no_browser, Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
        webView.resumeTimers();
    }

    @Override
    protected void onPause() {
        // Stop radar animation and refresh timers while backgrounded to save battery and data.
        webView.onPause();
        webView.pauseTimers();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        resolveGeolocation(false);
        if (webView != null) {
            ViewGroup parent = (ViewGroup) webView.getParent();
            if (parent != null) {
                parent.removeView(webView);
            }
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
