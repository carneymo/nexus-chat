package net.nexuschat.android

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.NotificationManagerCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject

class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private lateinit var errorPanel: LinearLayout
    private lateinit var progress: ProgressBar
    private var microphoneRequest: PermissionRequest? = null
    private var files: ValueCallback<Array<Uri>>? = null
    private var pendingLink: String? = null
    private val prefs by lazy { PhoneState.preferences(this) }
    private val permission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val request = microphoneRequest
        microphoneRequest = null
        if (granted && request != null && LinkPolicy.isTrusted(request.origin.toString()) && PhoneState.foreground)
            request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        else request?.deny()
    }
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) enableNotifications() else emitStatus()
    }
    private val filePicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        files?.onReceiveValue(uri?.let { arrayOf(it) }); files = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        PhoneState.createChannel(this)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.rgb(16, 24, 21)) }
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100 }
        root.addView(progress, LinearLayout.LayoutParams(-1, 6))
        errorPanel = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 48, 32, 32); visibility = View.GONE }
        errorPanel.addView(TextView(this).apply {
            text = "Nexus is unavailable right now. Check your connection, then try again."
            textSize = 18f; setTextColor(Color.WHITE)
        })
        errorPanel.addView(Button(this).apply { text = "Try again"; setOnClickListener { web.reload() } })
        root.addView(errorPanel)
        web = WebView(this)
        root.addView(web, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
            WindowInsetsCompat.CONSUMED
        }
        configureWebView()
        pendingLink = LinkPolicy.appLink(intent?.dataString)
        web.loadUrl(pendingLink ?: "${BuildConfig.NEXUS_ORIGIN}/")
        pendingLink = null
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("(() => { const e = new Event('nexus-back', {cancelable:true}); window.dispatchEvent(e); return e.defaultPrevented; })()") { handled ->
                    if (handled != "true") moveTaskToBack(true)
                }
            }
        })
    }

    private fun configureWebView() {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web.setBackgroundColor(Color.rgb(16, 24, 21))
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = true // Only user-selected content URIs from Android's picker.
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = true
            setSupportMultipleWindows(false)
            userAgentString += " NexusAndroid/${BuildConfig.VERSION_NAME}"
        }
        CookieManager.getInstance().apply { setAcceptCookie(true); setAcceptThirdPartyCookies(web, false) }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            AlertDialog.Builder(this).setMessage("Update Android System WebView to use Nexus Chat.")
                .setPositiveButton("Close") { _, _ -> finish() }.setCancelable(false).show()
            return
        }
        WebViewCompat.addWebMessageListener(web, "NexusAndroid", setOf(BuildConfig.NEXUS_ORIGIN)) { _, message, origin, mainFrame, _ ->
            if (!mainFrame || !LinkPolicy.isTrusted(origin.toString())) return@addWebMessageListener
            val raw = message.data ?: return@addWebMessageListener
            if (raw.length > 1024) return@addWebMessageListener
            try {
                val value = JSONObject(raw)
                when (value.optString("type")) {
                    "ready" -> emitStatus()
                    "session" -> {
                        val account = value.optString("account")
                        if (account.isEmpty() || Regex("^[A-Za-z0-9-]{1,100}$").matches(account)) {
                            if (prefs.getString("account", "") != account)
                                NotificationManagerCompat.from(this).cancelAll()
                            prefs.edit().putString("account", account).apply()
                            emitStatus()
                        }
                    }
                    "enableNotifications" -> requestNotifications()
                    "disableNotifications" -> {
                        prefs.edit().putBoolean("notifications_enabled", false).apply()
                        NotificationManagerCompat.from(this).cancelAll()
                        emitStatus()
                    }
                    "notificationSettings" -> startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
                }
            } catch (_: Exception) { /* Malformed bridge input has no native effect. */ }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, value: Int) {
                progress.progress = value
                progress.visibility = if (value == 100) View.GONE else View.VISIBLE
            }
            override fun onPermissionRequest(request: PermissionRequest) {
                if (!PhoneState.foreground || !LinkPolicy.isTrusted(request.origin.toString()) ||
                    !request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) { request.deny(); return }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
                    request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                else {
                    microphoneRequest?.deny(); microphoneRequest = request
                    permission.launch(Manifest.permission.RECORD_AUDIO)
                }
            }
            override fun onPermissionRequestCanceled(request: PermissionRequest) {
                if (microphoneRequest == request) microphoneRequest = null
            }
            override fun onShowFileChooser(view: WebView?, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                if (!LinkPolicy.isTrusted(web.url)) return false
                files?.onReceiveValue(null); files = callback
                filePicker.launch(arrayOf("image/png", "image/jpeg", "image/gif", "image/webp"))
                return true
            }
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest): Boolean {
                val value = request.url.toString()
                if (LinkPolicy.isTrusted(value)) return false
                if (request.isForMainFrame && request.hasGesture() && LinkPolicy.externalLink(value)) {
                    AlertDialog.Builder(this@MainActivity).setTitle("Open in your browser?")
                        .setMessage(request.url.host)
                        .setPositiveButton("Open") { _, _ ->
                            try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                            catch (_: android.content.ActivityNotFoundException) { }
                        }.setNegativeButton("Cancel", null).show()
                }
                return true
            }
            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                if (!LinkPolicy.isTrusted(url)) { web.stopLoading(); showError(); return }
                errorPanel.visibility = View.GONE
            }
            override fun onPageFinished(view: WebView?, url: String?) {
                if (!LinkPolicy.isTrusted(url)) return
                CookieManager.getInstance().flush()
                // Compatibility guard also releases microphone tracks on older hosted frontend versions.
                web.evaluateJavascript("""
                    (() => {
                      if (window.nexusStopMedia || !navigator.mediaDevices) return;
                      const tracks = new Set();
                      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
                      window.nexusInForeground = true;
                      navigator.mediaDevices.getUserMedia = async (...args) => {
                        const stream = await original(...args);
                        stream.getTracks().forEach(t => { tracks.add(t); t.addEventListener('ended', () => tracks.delete(t)); });
                        if (!window.nexusInForeground) { stream.getTracks().forEach(t => t.stop()); throw new Error('Return to Nexus to join voice.'); }
                        return stream;
                      };
                      window.nexusStopMedia = () => { tracks.forEach(t => t.stop()); tracks.clear(); };
                    })();
                """.trimIndent(), null)
                emitStatus()
            }
            override fun onReceivedError(view: WebView?, request: WebResourceRequest, error: WebResourceError?) {
                if (request.isForMainFrame) showError()
            }
            override fun onReceivedHttpError(view: WebView?, request: WebResourceRequest, response: WebResourceResponse) {
                if (request.isForMainFrame && response.statusCode >= 400) showError()
            }
            override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler, error: SslError?) {
                handler.cancel(); showError()
            }
        }
    }
    private fun showError() { errorPanel.visibility = View.VISIBLE; progress.visibility = View.GONE }

    private fun requestNotifications() {
        if (!BuildConfig.PUSH_CONFIGURED) { emitStatus(); return }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        else enableNotifications()
    }
    private fun enableNotifications() {
        if (!BuildConfig.PUSH_CONFIGURED || FirebaseApp.initializeApp(this) == null) { emitStatus(); return }
        prefs.edit().putBoolean("notifications_enabled", true).apply()
        FirebaseMessaging.getInstance().isAutoInitEnabled = true
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (task.isSuccessful) prefs.edit().putString("token", task.result).apply()
            emitStatus(if (task.isSuccessful) "" else "Could not register this phone. Try again.")
        }
    }
    private fun emitStatus(error: String = "") {
        val value = JSONObject().put("configured", BuildConfig.PUSH_CONFIGURED)
            .put("permission", NotificationManagerCompat.from(this).areNotificationsEnabled())
            .put("enabled", prefs.getBoolean("notifications_enabled", false))
            .put("token", prefs.getString("token", "")).put("error", error)
        emit("nexus-phone-status", value)
    }
    private fun emit(name: String, data: JSONObject) {
        if (::web.isInitialized && LinkPolicy.isTrusted(web.url))
            web.evaluateJavascript("window.dispatchEvent(new CustomEvent(${JSONObject.quote(name)}, {detail:$data}));", null)
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent); setIntent(intent)
        val link = LinkPolicy.appLink(intent.dataString) ?: return
        if (LinkPolicy.isTrusted(web.url)) {
            // Fragment navigation preserves the current draft and page instance.
            web.evaluateJavascript("location.hash = ${JSONObject.quote(Uri.parse(link).encodedFragment ?: "")};", null)
        } else web.loadUrl(link)
    }
    override fun onResume() {
        super.onResume(); PhoneState.foreground = true
        if (::web.isInitialized) {
            web.onResume()
            web.evaluateJavascript("window.nexusInForeground = true; window.dispatchEvent(new Event('nexus-resume'));", null)
            emitStatus()
        }
    }
    override fun onStop() {
        PhoneState.foreground = false
        if (::web.isInitialized) {
            web.evaluateJavascript("window.nexusInForeground = false; window.dispatchEvent(new Event('nexus-background')); window.nexusStopMedia?.();", null)
            CookieManager.getInstance().flush()
        }
        super.onStop()
    }
    override fun onDestroy() {
        files?.onReceiveValue(null); microphoneRequest?.deny()
        web.destroy()
        super.onDestroy()
    }
}
