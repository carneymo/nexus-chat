package net.nexuschat.android

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

object PhoneState {
    @Volatile var foreground = false
    const val CHANNEL = "nexus_messages"
    fun preferences(context: Context) = context.getSharedPreferences("nexus_phone", Context.MODE_PRIVATE)
    fun createChannel(context: Context) {
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Whispers and mentions", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Private message and @handle mention alerts. Message text stays inside Nexus."
                lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
            }
        )
    }
}

class NexusMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        // Registration is refreshed through the authenticated web session on next resume.
        PhoneState.preferences(this).edit().putString("token", token).apply()
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val prefs = PhoneState.preferences(this)
        if (PhoneState.foreground || !prefs.getBoolean("notifications_enabled", false) ||
            data["account"].isNullOrEmpty() || data["account"] != prefs.getString("account", null)) return
        val kind = data["kind"]
        if (kind != "dm" && kind != "mention") return
        val path = data["link"] ?: return
        if (!path.startsWith("/#")) return
        val link = LinkPolicy.appLink(BuildConfig.NEXUS_ORIGIN + path) ?: return
        val id = data["messageId"]?.toIntOrNull() ?: return
        PhoneState.createChannel(this)
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) return
        val intent = Intent(this, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            this.data = Uri.parse(link)
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pending = PendingIntent.getActivity(this, id, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(this, PhoneState.CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Nexus Chat")
            .setContentText(if (kind == "dm") "You have a new whisper." else "You were mentioned in a channel.")
            .setContentIntent(pending).setAutoCancel(true).setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE).build()
        try { NotificationManagerCompat.from(this).notify(id, notification) }
        catch (_: SecurityException) { /* Permission can be revoked between check and delivery. */ }
    }
}
