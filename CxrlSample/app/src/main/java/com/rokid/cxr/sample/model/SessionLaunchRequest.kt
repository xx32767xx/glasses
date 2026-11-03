package com.rokid.cxr.sample.model

import com.rokid.cxr.session.SessionConfig

/**
 * Singleton for passing parameters from Setup to Hub.
 *
 * Only holds two pieces of pure data: [SessionConfig] and an authorization token; Hub must call
 * [clear] immediately after reading to avoid leaving session credentials in memory. This object
 * holds no lifecycle, callbacks, or coroutines, so there is no leak risk.
 */
object SessionLaunchRequest {

    @Volatile
    var config: SessionConfig? = null

    @Volatile
    var token: String? = null

    /** Clears the passed launch parameters. */
    fun clear() {
        config = null
        token = null
    }
}
