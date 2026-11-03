package com.rokid.cxr.sample.model

import com.rokid.cxr.session.AiInterceptMode
import com.rokid.cxr.session.CloseReason
import com.rokid.cxr.session.GlassesInfo
import com.rokid.cxr.session.PausedReason
import com.rokid.cxr.session.RokidAppStatus
import com.rokid.cxr.session.SessionConfig
import com.rokid.cxr.session.SessionType
import com.rokid.cxr.session.TerminatingReason

data class SampleUiState(
    val rokidAppInstalled: Boolean? = null,
    val rokidAppStatus: RokidAppStatus? = null,
    val glassesBtConnected: Boolean? = null,

    val authToken: String? = null,
    val authError: String? = null,
    val isAuthorized: Boolean = false,

    val sessionType: SessionType = SessionType.CUSTOM_VIEW,
    val glassesPackageName: String = "",
    val glassesActivityName: String = "",
    val glassesApkPath: String = "",
    val aiInterceptMode: AiInterceptMode = AiInterceptMode.ALLOW_WITH_PAUSE,
    val viewData: String = """
        {
          "type": "LinearLayout",
          "props": {
            "id": "root",
            "layout_width": "match_parent",
            "layout_height": "match_parent",
            "backgroundColor": "#FF000000",
            "orientation": "vertical",
            "gravity": "center"
          },
          "children": [
            {
              "type": "TextView",
              "props": {
                "id": "textView",
                "layout_width": "wrap_content",
                "layout_height": "wrap_content",
                "text": "Hello CXR-L",
                "textColor": "#FF00FF00",
                "textSize": "16sp",
                "gravity": "center",
                "textStyle": "bold"
              }
            }
          ]
        }
    """.trimIndent(),
    val terminatingGracePeriodMs: Long = 3_000L,

    val sessionConfig: SessionConfig? = null,
    val isSessionCreated: Boolean = false,
    val isConnected: Boolean = false,

    val isAudioStreaming: Boolean = false,
    val lastPhotoResult: String? = null,
    val lastCmdResult: String? = null,
    val glassesInfo: GlassesInfo? = null,
    val brightnessLevel: Int = 50,
    val volumeLevel: Int = 50,

    val customViewUpdateJson: String = """
        [
          { "action": "update", "id": "textView", "props": { "text": "Updated by Sample" } }
        ]
    """.trimIndent(),

    val customCmdName: String = "",
    val customCmdPayload: String = "",
    val customCmdStream: String = "",

    val pausedReason: PausedReason? = null,
    val lastCloseReason: CloseReason? = null,
    val lastTerminatingReason: TerminatingReason? = null,
    val statusMessage: String? = null,
    val eventFilter: EventCategory? = null,
    val lastExportPath: String? = null,
    val wearing: Boolean? = null,
    val screenOn: Boolean? = null,
    val aiInterrupted: Boolean? = null,
    val capsApiConfirmed: Boolean = true,
    /** Historical fact: SDK accepted a CUSTOM_VIEW update once. Not cleared on pause/close. */
    val hasCompletedCustomViewDemo: Boolean = false,
    val lastConnectErrorCode: String? = null,
)
