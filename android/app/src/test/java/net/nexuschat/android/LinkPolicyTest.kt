package net.nexuschat.android

import org.junit.Assert.*
import org.junit.Test

class LinkPolicyTest {
    @Test fun rejectsUntrustedOriginsAndPrivilegedSchemes() {
        for (url in listOf("http://nexus-chat.net", "https://nexus-chat.net.evil.test/", "https://nexus-chat.net@evil.test/", "https://nexus-chat.net:444/", "file:///etc/passwd", "javascript:alert(1)", "intent://test")) {
            assertFalse(url, LinkPolicy.isTrusted(url))
            assertNull(LinkPolicy.appLink(url))
        }
        assertTrue(LinkPolicy.isTrusted("https://nexus-chat.net/"))
    }
    @Test fun deepLinksOnlyOpenTheChatPage() {
        assertEquals("https://nexus-chat.net/#peer=123", LinkPolicy.appLink("https://nexus-chat.net/#peer=123"))
        assertNull(LinkPolicy.appLink("https://nexus-chat.net/api/logout"))
        assertNull(LinkPolicy.appLink("https://nexus-chat.net/?redirect=evil"))
        assertNull(LinkPolicy.appLink("https://nexus-chat.net/#javascript:evil"))
    }
}
