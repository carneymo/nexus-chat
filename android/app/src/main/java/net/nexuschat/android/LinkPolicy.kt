package net.nexuschat.android

import java.net.URI

/** Only the configured first-party origin may host the native bridge or navigation. */
object LinkPolicy {
    fun isTrusted(value: String?): Boolean = try {
        val uri = URI(value ?: "")
        uri.scheme == "https" && uri.host == "nexus-chat.net" &&
            (uri.port == -1 || uri.port == 443) && uri.userInfo == null
    } catch (_: Exception) { false }

    fun appLink(value: String?): String? {
        if (!isTrusted(value)) return null
        val uri = URI(value!!)
        if (uri.path !in listOf("", "/") || uri.rawQuery != null) return null
        val fragment = uri.rawFragment ?: return "https://nexus-chat.net/"
        if (fragment.length > 600 || !Regex("^(invite|peer|channel)=.+$").matches(fragment)) return null
        return "https://nexus-chat.net/#$fragment"
    }

    fun externalLink(value: String): Boolean = try {
        val uri = URI(value)
        uri.scheme == "https" && uri.host != null && uri.userInfo == null
    } catch (_: Exception) { false }
}
