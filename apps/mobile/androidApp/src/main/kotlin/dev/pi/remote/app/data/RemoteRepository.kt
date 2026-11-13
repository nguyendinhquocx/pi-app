package dev.pi.remote.app.data

import dev.pi.remote.protocol.CommandInfo
import dev.pi.remote.protocol.ContextStats
import dev.pi.remote.protocol.canonicalSessionKey
import dev.pi.remote.protocol.SessionStatsResult
import dev.pi.remote.protocol.ReviewDiffResult
import dev.pi.remote.protocol.BranchInfo
import dev.pi.remote.protocol.ForkResult
import dev.pi.remote.protocol.TimelineReset
import dev.pi.remote.protocol.FileEntry
import dev.pi.remote.protocol.FileListResult
import dev.pi.remote.crypto.Hs2Payload
import dev.pi.remote.net.HostConnection
import dev.pi.remote.net.RemoteApi
import dev.pi.remote.protocol.AppInfo
import dev.pi.remote.protocol.Base64Url
import dev.pi.remote.protocol.CapabilityRow
import dev.pi.remote.protocol.ClientCaps
import dev.pi.remote.protocol.HelloParams
import dev.pi.remote.protocol.HelloResult
import dev.pi.remote.protocol.ModelListResult
import dev.pi.remote.protocol.PairOffer
import dev.pi.remote.protocol.ProjectInfo
import dev.pi.remote.protocol.RemoteJson
import dev.pi.remote.protocol.SessionSummary
import dev.pi.remote.protocol.SessionsUpdate
import dev.pi.remote.protocol.SettingsChanged
import dev.pi.remote.protocol.ToolDetailResult
import dev.pi.remote.protocol.TurnPatchEvent
import dev.pi.remote.protocol.UiDismiss
import dev.pi.remote.protocol.UiRequest
import dev.pi.remote.protocol.UiResponse
import dev.pi.remote.sync.ApplyResult
import dev.pi.remote.sync.SessionSyncResult
import dev.pi.remote.sync.SessionTimeline
import dev.pi.remote.sync.SessionTimelineSync
import dev.pi.remote.sync.TurnStore
import java.io.File
import java.net.URI
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** Templates / components / dialog kinds this build renders natively (sent in host.hello). */
val CLIENT_CAPS = ClientCaps(
    templates = listOf("bash", "read", "edit", "write", "search", "default", "list", "kv", "media", "tree"),
    piUi = listOf("stat-grid", "chart", "data-table", "card-grid", "diff", "quiz", "decision-tree", "gantt"),
    uiKinds = listOf("select", "confirm", "input", "editor", "notify", "ask_user_question", "image_review"),
)

data class InboxState(
    val sessions: List<SessionSummary> = emptyList(),
    val projects: List<ProjectInfo> = emptyList(),
    val loaded: Boolean = false,
)

sealed interface SendOutcome {
    data object Sent : SendOutcome
    data object SessionNotReady : SendOutcome
    /** The socket dropped before the answer: the message may or may not have arrived. */
    data object Unknown : SendOutcome
    data class Failed(val message: String) : SendOutcome
}

/**
 * App-wide remote state for the active host: one [HostConnection], the inbox, and the
 * timeline of the open session. Survives screen changes; connects only while the app is in
 * the foreground (30 s grace after backgrounding).
 */
class RemoteRepository(
    private val scope: CoroutineScope,
    private val hostStore: HostStore,
    private val keyVault: KeyVault,
    private val cache: TimelineCache,
    private val assetDir: File,
    private val deviceName: String,
    private val platform: String,
    private val appVersion: String,
) {
    private val _hosts = MutableStateFlow(hostStore.hosts)
    val hosts: StateFlow<List<SavedHost>> = _hosts
    private val _active = MutableStateFlow(hostStore.hosts.firstOrNull { it.hostId == hostStore.activeHostId })
    val active: StateFlow<SavedHost?> = _active
    private val _connection = MutableStateFlow<HostConnection.State>(HostConnection.State.Idle)
    val connection: StateFlow<HostConnection.State> = _connection
    private val _inbox = MutableStateFlow(InboxState())
    val inbox: StateFlow<InboxState> = _inbox
    private val _timelines = MutableStateFlow<Map<String, SessionTimeline>>(emptyMap())
    val timelines: StateFlow<Map<String, SessionTimeline>> = _timelines
    private val _pendingSends = MutableStateFlow<Map<String, List<PendingSend>>>(emptyMap())
    /** Per-session optimistic bubbles, tracked until a matching host turn is observed. */
    val pendingSends: StateFlow<Map<String, List<PendingSend>>> = _pendingSends
    private val timelineSyncLock = Any()
    /** Mutable reducer state is owned by timelineSyncLock; UI observes the immutable StateFlow. */
    private val timelineSync = HashMap<String, SessionTimelineSync>()
    private val _settingsVersion = MutableStateFlow(0)
    val settingsVersion: StateFlow<Int> = _settingsVersion
    private val _notices = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val notices: SharedFlow<String> = _notices

    private var conn: HostConnection? = null
    private var api: RemoteApi? = null
    private var jobs = mutableListOf<Job>()
    private var openKey: String? = null
    private var stopJob: Job? = null
    private var hello: HelloResult? = null
    private var foreground = false

    private val helloParams get() = HelloParams(AppInfo("pi-remote", appVersion, platform), CLIENT_CAPS)

    private fun sessionKey(raw: String): String = canonicalSessionKey(raw)

    private fun normalizeSummary(summary: SessionSummary): SessionSummary =
        summary.copy(sessionKey = sessionKey(summary.sessionKey))

    private fun normalizeSummaries(sessions: List<SessionSummary>): List<SessionSummary> =
        sessions.map(::normalizeSummary)

    private inline fun <T> withTimelineSync(key: String, block: (SessionTimelineSync) -> T): T =
        synchronized(timelineSyncLock) {
            val canonical = sessionKey(key)
            block(timelineSync.getOrPut(canonical) { SessionTimelineSync(canonical) })
        }

    init {
        _active.value?.let { h ->
            _inbox.value = InboxState(sessions = cache.loadInbox(h.hostId).map(::normalizeSummary))
        }
    }

    // ── Hosts / pairing ──

    /** Pair with a scanned/pasted offer. Resolves once the host accepted and answered hello. */
    suspend fun pair(offer: PairOffer): Result<SavedHost> {
        disconnect()
        var saved: SavedHost? = null
        val c = HostConnection(
            scope, offer.endpoints, Base64Url.decode(offer.hostPub), keyVault.identity(), deviceName, platform, helloParams, offer.pairToken,
            onPaired = { p: Hs2Payload ->
                // Re-pairing the same computer keeps the addresses the user typed in.
                val manual = hostStore.hosts.firstOrNull { it.hostId == p.hostId }?.manualEndpoints.orEmpty()
                saved = SavedHost(p.hostId, p.hostName, offer.hostPub, offer.endpoints, p.deviceId, p.role, System.currentTimeMillis(), manual).also {
                    hostStore.upsert(it)
                    _hosts.value = hostStore.hosts
                }
            },
        )
        c.start()
        val end = withTimeoutOrNull(20_000) { c.state.first { it is HostConnection.State.Ready || it is HostConnection.State.Refused } }
        c.stop()
        return when {
            end is HostConnection.State.Ready && saved != null -> {
                select(saved!!.hostId)
                Result.success(saved!!)
            }
            end is HostConnection.State.Refused -> Result.failure(IllegalStateException(end.code))
            else -> Result.failure(IllegalStateException("unreachable"))
        }
    }

    fun select(hostId: String) {
        val host = hostStore.hosts.firstOrNull { it.hostId == hostId } ?: return
        hostStore.setActive(hostId)
        if (_active.value?.hostId != hostId) {
            disconnect()
            openKey = null
            _timelines.value = emptyMap()
            synchronized(timelineSyncLock) { timelineSync.clear() }
            _pendingSends.value = emptyMap()
            resyncing.clear()
            pendingResyncScheduled.clear()
            _inbox.value = InboxState(sessions = cache.loadInbox(hostId).map(::normalizeSummary))
        }
        _active.value = host
        if (foreground) connect()
    }

    /** Replace a host's typed-in addresses; the active connection tries them on its next attempt. */
    fun setManualEndpoints(hostId: String, list: List<String>) {
        val host = hostStore.hosts.firstOrNull { it.hostId == hostId } ?: return
        val updated = host.copy(manualEndpoints = list.distinct())
        hostStore.update(updated)
        _hosts.value = hostStore.hosts
        if (_active.value?.hostId == hostId) {
            _active.value = updated
            conn?.updateEndpoints(updated.allEndpoints)
            if (_connection.value !is HostConnection.State.Ready) conn?.kick()
        }
    }

    fun forget(hostId: String) {
        if (_active.value?.hostId == hostId) {
            disconnect()
            openKey = null
            _active.value = null
            _inbox.value = InboxState()
            _timelines.value = emptyMap()
            synchronized(timelineSyncLock) { timelineSync.clear() }
            _pendingSends.value = emptyMap()
            resyncing.clear()
            pendingResyncScheduled.clear()
        }
        hostStore.remove(hostId)
        cache.clearHost(hostId)
        _hosts.value = hostStore.hosts
    }

    // ── Lifecycle ──

    fun onForeground() {
        foreground = true
        openKey?.let { notifier?.clear(it) }
        updateKeepAlive()
        stopJob?.cancel()
        stopJob = null
        val c = conn
        if (c == null) connect() else c.kick()
    }

    fun onBackground() {
        foreground = false
        scheduleDisconnect()
        updateKeepAlive()
    }

    fun retry() {
        conn?.kick() ?: connect()
    }

    /**
     * Pull to refresh: re-list projects and sessions (the host rescans its session files, which
     * catches desktop changes that never reached us as `sessions.update`). Offline, it reconnects
     * instead (the list reloads on ready) and waits briefly for the link. False on failure.
     */
    suspend fun refreshInbox(): Boolean {
        if (_connection.value !is HostConnection.State.Ready) {
            retry()
            return withTimeoutOrNull(8_000) { _connection.first { it is HostConnection.State.Ready } } != null
        }
        val a = api ?: return false
        return runCatching {
            val projects = a.projects()
            val sessions = normalizeSummaries(a.watchList())
            _inbox.value = InboxState(sessions, projects, loaded = true)
            persistInbox()
        }.onFailure { _notices.tryEmit(it.message ?: "list failed") }.isSuccess
    }

    private fun connect() {
        val host = _active.value ?: return
        if (conn != null) return
        val c = HostConnection(scope, host.allEndpoints, Base64Url.decode(host.hostPub), keyVault.identity(), deviceName, platform, helloParams)
        conn = c
        api = RemoteApi(c)
        jobs += scope.launch { c.state.collect { s -> _connection.value = s; if (s is HostConnection.State.Ready) onReady(s) } }
        jobs += scope.launch { c.events.collect { event -> onEvent(event) } }
        c.start()
    }

    private fun disconnect() {
        jobs.forEach { it.cancel() }
        jobs.clear()
        conn?.stop()
        conn = null
        api = null
        _connection.value = HostConnection.State.Idle
    }

    private suspend fun onReady(s: HostConnection.State.Ready) {
        hello = s.hello
        _active.value?.let { h ->
            // Remember what worked (first) plus the host's current addresses, so the next start
            // connects at once and a DHCP change does not need a new QR scan.
            val endpoints = (listOf(s.endpoint) + s.hello.endpoints + h.endpoints).distinct().take(8)
            val updated = h.copy(hostName = s.hello.hostName, role = s.hello.role, endpoints = endpoints, lastConnectedAt = System.currentTimeMillis())
            conn?.updateEndpoints(updated.allEndpoints)
            hostStore.upsert(updated)
            _active.value = updated
            _hosts.value = hostStore.hosts
        }
        val a = api ?: return
        runCatching {
            val projects = a.projects()
            val sessions = normalizeSummaries(a.watchList())
            _inbox.value = InboxState(sessions, projects, loaded = true)
            persistInbox()
        }.onFailure { _notices.tryEmit(it.message ?: "list failed") }
        openKey?.let { reopen(it) }
    }

    private fun persistInbox() {
        val host = _active.value ?: return
        val sessions = _inbox.value.sessions
        scope.launch(Dispatchers.IO) { cache.saveInbox(host.hostId, sessions) }
    }

    private suspend fun onEvent(e: HostConnection.Event) {
        when (e.method) {
            "sessions.update" -> {
                val u = RemoteJson.decodeFromJsonElement(SessionsUpdate.serializer(), e.payload)
                val before = _inbox.value.sessions.associateBy { sessionKey(it.sessionKey) }
                val updated = normalizeSummaries(u.sessions)
                val removed = u.removed.orEmpty().map(::sessionKey).toSet()
                _inbox.update { inbox ->
                    val byKey = inbox.sessions.associateBy { sessionKey(it.sessionKey) }.toMutableMap()
                    updated.forEach { byKey[it.sessionKey] = it }
                    removed.forEach { byKey.remove(it) }
                    inbox.copy(sessions = byKey.values.sortedByDescending { it.updatedAt })
                }
                persistInbox()
                noticeTransitions(before, updated)
            }
            "turn.patch" -> {
                val event = RemoteJson.decodeFromJsonElement(TurnPatchEvent.serializer(), e.payload)
                val key = sessionKey(event.sessionKey)
                val result = withTimelineSync(key) { it.onPatch(event, hello?.epoch) }
                handleSyncResult(key, result)
            }
            "ui.request" -> {
                val req = RemoteJson.decodeFromJsonElement(UiRequest.serializer(), e.payload)
                val key = sessionKey(req.sessionKey)
                val current = withTimelineSync(key) { it.current() }
                if (current == null) requestResync(key, fresh = true)
                else putTimeline(TurnStore.addUi(current, req))
            }
            "ui.dismiss" -> {
                val wire = RemoteJson.decodeFromJsonElement(UiDismiss.serializer(), e.payload)
                val key = sessionKey(wire.sessionKey)
                val current = withTimelineSync(key) { it.current() }
                if (current == null) requestResync(key, fresh = true)
                else putTimeline(TurnStore.removeUi(current, wire.id))
            }
            "settings.changed" -> {
                RemoteJson.decodeFromJsonElement(SettingsChanged.serializer(), e.payload)
                _settingsVersion.update { it + 1 }
            }
            "host.notice" -> _notices.tryEmit(e.payload.toString())
        }
    }

    private suspend fun handleSyncResult(key: String, result: SessionSyncResult) {
        when (result) {
            is SessionSyncResult.Applied -> publishCurrentTimeline(key)
            is SessionSyncResult.Buffered, SessionSyncResult.Ignored, SessionSyncResult.StaleOpen -> Unit
            is SessionSyncResult.NeedsResync -> {
                publishCurrentTimeline(key)
                requestResync(key, fresh = true)
            }
        }
    }

    /** Cache/open/page mutations enter the same per-session reducer used by live patches. */
    private suspend fun putTimeline(raw: SessionTimeline) {
        val key = sessionKey(raw.sessionKey)
        val normalized = raw.copy(sessionKey = key)
        withTimelineSync(key) { sync ->
            sync.seed(normalized)
            publishTimelineLocked(key, sync)
        }
    }

    /** Must be called while holding timelineSyncLock so StateFlow cannot lag behind reducer state. */
    private fun publishTimelineLocked(key: String, sync: SessionTimelineSync): SessionTimeline? {
        val timeline = sync.current()?.let { if (it.sessionKey == key) it else it.copy(sessionKey = key) } ?: return null
        _timelines.update { it + (key to timeline) }
        reconcilePendingSends(key, timeline)
        return timeline
    }

    private fun publishCurrentTimeline(rawKey: String): SessionTimeline? {
        val key = sessionKey(rawKey)
        return synchronized(timelineSyncLock) {
            timelineSync[key]?.let { publishTimelineLocked(key, it) }
        }
    }

    private fun reconcilePendingSends(key: String, timeline: SessionTimeline) {
        val pending = _pendingSends.value[key].orEmpty()
        if (pending.isEmpty()) return
        val unmatched = PendingSendReconciler.reconcile(pending, timeline)
        _pendingSends.update { current ->
            if (unmatched.isEmpty()) current - key else current + (key to unmatched)
        }
    }

    private fun updatePending(key: String, messageId: String, transform: (PendingSend) -> PendingSend?) {
        _pendingSends.update { current ->
            val sends = current[sessionKey(key)].orEmpty()
            val next = sends.mapNotNull { send -> if (send.messageId == messageId) transform(send) else send }
            if (next.isEmpty()) current - sessionKey(key) else current + (sessionKey(key) to next)
        }
    }

    private val resyncing = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    private fun requestResync(rawKey: String, fresh: Boolean = true) {
        val key = sessionKey(rawKey)
        if (!resyncing.add(key)) return
        scope.launch {
            try {
                reopen(key, fresh = fresh, maxResyncs = 1)
            } finally {
                resyncing.remove(key)
            }
        }
    }

    private var saveJob: Job? = null
    private fun persistTimeline(rawKey: String) {
        val host = _active.value ?: return
        val key = sessionKey(rawKey)
        saveJob?.cancel()
        saveJob = scope.launch(Dispatchers.IO) {
            delay(1500)
            _timelines.value[key]?.let { cache.saveTimeline(host.hostId, it) }
        }
    }

    // ── Sessions ──

    /** Show cache immediately, then sync (replay from the current cursor when possible). */
    suspend fun openSession(rawKey: String) {
        val key = sessionKey(rawKey)
        openKey = key
        if (foreground) notifier?.clear(key)
        val host = _active.value
        if (_timelines.value[key] == null && host != null) {
            // Try the old raw-path cache name once for upgrades; new writes always use canonical keys.
            val cached = withContext(Dispatchers.IO) {
                cache.loadTimeline(host.hostId, rawKey) ?: cache.loadTimeline(host.hostId, key)
            }
            cached?.let { putTimeline(it) }
        }
        reopen(key)
    }

    private suspend fun reopen(rawKey: String, fresh: Boolean = false, maxResyncs: Int = 1) {
        val key = sessionKey(rawKey)
        val a = api ?: return
        if (conn?.isReady != true) return
        var requestFresh = fresh
        repeat(maxResyncs + 1) { attempt ->
            val (openId, cursor) = withTimelineSync(key) { sync ->
                val id = sync.beginOpen(hello?.epoch, fresh = requestFresh)
                val current = sync.current()
                val nextCursor = if (requestFresh) null else current?.cursor?.takeIf { it.epoch == hello?.epoch }
                id to nextCursor
            }
            val response = runCatching { a.open(key, cursor) }
            if (response.isFailure) {
                val failure = response.exceptionOrNull()!!
                val syncResult = withTimelineSync(key) { sync ->
                    val result = sync.failOpen(openId)
                    if (result is SessionSyncResult.Applied || result is SessionSyncResult.NeedsResync) {
                        publishTimelineLocked(key, sync)
                    }
                    result
                }
                when (syncResult) {
                    is SessionSyncResult.NeedsResync -> {
                        if (attempt < maxResyncs && conn?.isReady == true) {
                            requestFresh = true
                            return@repeat
                        }
                    }
                    is SessionSyncResult.Applied -> Unit
                    is SessionSyncResult.Buffered,
                    is SessionSyncResult.StaleOpen,
                    SessionSyncResult.Ignored -> Unit
                }
                _notices.tryEmit(failure.message ?: "open failed")
                return
            }

            val opened = response.getOrThrow().copy(sessionKey = key)
            if (opened.kind == "replay" && opened.patches.orEmpty().any { it is TimelineReset }) {
                requestFresh = true
                if (attempt < maxResyncs) return@repeat
                withTimelineSync(key) { sync ->
                    sync.failOpen(openId)
                    publishTimelineLocked(key, sync)
                }
                _notices.tryEmit("session changed while opening; retry sync")
                return
            }

            when (val result = withTimelineSync(key) { sync ->
                val outcome = sync.completeOpen(openId, opened)
                if (outcome is SessionSyncResult.Applied || outcome is SessionSyncResult.NeedsResync) {
                    publishTimelineLocked(key, sync)
                }
                outcome
            }) {
                is SessionSyncResult.Applied -> {
                    persistTimeline(key)
                    return
                }
                is SessionSyncResult.NeedsResync -> {
                    if (attempt < maxResyncs) {
                        requestFresh = true
                    } else {
                        _notices.tryEmit("session stream has a sequence gap; reopen the session to resync")
                        return
                    }
                }
                is SessionSyncResult.StaleOpen,
                is SessionSyncResult.Buffered,
                SessionSyncResult.Ignored -> return
            }
        }
    }

    fun closeSession(rawKey: String) {
        val key = sessionKey(rawKey)
        if (openKey == key) openKey = null
        persistTimeline(key)
        val a = api ?: return
        scope.launch { runCatching { a.close(key) } }
    }

    suspend fun loadOlder(rawKey: String) {
        val key = sessionKey(rawKey)
        val a = api ?: return
        val t = _timelines.value[key] ?: return
        val first = t.turns.firstOrNull() ?: return
        runCatching { a.page(key, first.anchor) }.onSuccess { r ->
            _timelines.value[key]?.let { putTimeline(TurnStore.prependOlder(it, r.turns, r.hasOlder)) }
        }
    }

    suspend fun send(rawKey: String, text: String, mode: String): SendOutcome {
        val key = sessionKey(rawKey)
        val a = api ?: return SendOutcome.Failed("offline")
        val timeline = withTimelineSync(key) { it.current() }
        if (timeline == null) {
            requestResync(key, fresh = true)
            return SendOutcome.SessionNotReady
        }
        val messageId = "m_${UUID.randomUUID()}"
        val pending = if (mode == "prompt") {
            PendingSend(
                messageId = messageId,
                text = text.trim(),
                status = PendingSendStatus.Sending,
                baselineAnchors = timeline.turns.mapTo(HashSet()) { it.anchor },
                createdAt = System.currentTimeMillis(),
            ).also { item ->
                _pendingSends.update { current -> current + (key to (current[key].orEmpty() + item)) }
            }
        } else null
        return sendWithId(a, key, text, mode, messageId, pending)
    }

    /** Retry an ambiguous delivery with the same ID so the desktop can deduplicate it. */
    suspend fun retryPendingSend(rawKey: String, messageId: String): SendOutcome {
        val key = sessionKey(rawKey)
        val pending = _pendingSends.value[key].orEmpty().firstOrNull { it.messageId == messageId }
            ?: return SendOutcome.Failed("pending message not found")
        val a = api ?: return SendOutcome.Unknown
        updatePending(key, messageId) { it.copy(status = PendingSendStatus.Sending) }
        return sendWithId(a, key, pending.text, "prompt", messageId, pending, retainPendingOnFailure = true)
    }

    private suspend fun sendWithId(
        a: RemoteApi,
        key: String,
        text: String,
        mode: String,
        messageId: String,
        pending: PendingSend?,
        retainPendingOnFailure: Boolean = false,
    ): SendOutcome {
        return try {
            val result = a.send(key, text, mode, messageId)
            if (!result.accepted) {
                pending?.let {
                    updatePending(key, it.messageId) { current ->
                        if (retainPendingOnFailure) current.copy(status = PendingSendStatus.Unknown) else null
                    }
                }
                SendOutcome.Failed("host did not accept the message")
            } else {
                pending?.let { updatePending(key, it.messageId) { it.copy(status = PendingSendStatus.Accepted) } }
                pending?.let { schedulePendingReconcile(key, it.messageId) }
                SendOutcome.Sent
            }
        } catch (e: HostConnection.ConnectionLost) {
            pending?.let { updatePending(key, it.messageId) { it.copy(status = PendingSendStatus.Unknown) } }
            pending?.let { schedulePendingReconcile(key, it.messageId) }
            SendOutcome.Unknown
        } catch (e: Exception) {
            pending?.let {
                updatePending(key, it.messageId) { current ->
                    if (retainPendingOnFailure) current.copy(status = PendingSendStatus.Unknown) else null
                }
            }
            SendOutcome.Failed(e.message ?: "send failed")
        }
    }

    private val pendingResyncScheduled = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    private fun schedulePendingReconcile(rawKey: String, messageId: String) {
        val key = sessionKey(rawKey)
        if (!pendingResyncScheduled.add(key)) return
        scope.launch {
            delay(1_500)
            pendingResyncScheduled.remove(key)
            val stillPending = _pendingSends.value[key].orEmpty().any {
                it.messageId == messageId && it.status != PendingSendStatus.Sending
            }
            if (stillPending) requestResync(key, fresh = false)
        }
    }

    /** Queued texts the host pulled back, or null when the stop did not reach it. */
    suspend fun abort(rawKey: String): List<String>? = runCatching { api?.abort(sessionKey(rawKey))?.let { it.restored.orEmpty() } }.getOrNull()

    private val commandCache = HashMap<String, Pair<Long, List<CommandInfo>>>()

    /** Slash commands for the session's project; cached briefly so the panel opens instantly. */
    suspend fun commands(rawKey: String, maxAgeMs: Long = 15_000): List<CommandInfo>? {
        val key = sessionKey(rawKey)
        commandCache[key]?.let { (at, list) -> if (System.currentTimeMillis() - at < maxAgeMs) return list }
        val list = runCatching { api?.commands(key) }.getOrNull() ?: return commandCache[key]?.second
        commandCache[key] = System.currentTimeMillis() to list
        return list
    }

    fun cachedCommands(rawKey: String): List<CommandInfo>? = commandCache[sessionKey(rawKey)]?.second

    suspend fun listFiles(rawKey: String, path: String): FileListResult? = runCatching { api?.listFiles(sessionKey(rawKey), path) }.getOrNull()

    suspend fun searchFiles(rawKey: String, query: String): List<FileEntry>? = runCatching { api?.searchFiles(sessionKey(rawKey), query) }.getOrNull()

    /** Rewind before the turn's user message; the message text on success, failure message otherwise. */
    suspend fun rewind(rawKey: String, anchor: String): Result<String> {
        val key = sessionKey(rawKey)
        return runCatching {
            val a = api ?: error("offline")
            a.rewind(key, anchor).editorText.orEmpty()
        }.onSuccess { reopen(key, fresh = true) }
    }

    suspend fun branches(rawKey: String): Result<List<BranchInfo>> {
        val key = sessionKey(rawKey)
        return runCatching { api?.branches(key) ?: error("offline") }
    }

    /** Make another branch active; viewers re-open like after a rewind. */
    suspend fun switchBranch(rawKey: String, leafId: String): Result<Unit> {
        val key = sessionKey(rawKey)
        return runCatching {
            (api ?: error("offline")).switchBranch(key, leafId)
            Unit
        }.onSuccess { reopen(key, fresh = true) }
    }

    /** Fork before a user message: the new session's key and the message to edit there. */
    suspend fun fork(rawKey: String, anchor: String): Result<ForkResult> = runCatching {
        (api ?: error("offline")).fork(sessionKey(rawKey), anchor).let { it.copy(sessionKey = sessionKey(it.sessionKey)) }
    }

    /** `review.diff`: file list (no [path]) or one file's lines; failure carries the host's message. */
    suspend fun reviewDiff(rawKey: String, scope: String, turnId: String? = null, path: String? = null): Result<ReviewDiffResult> {
        val key = sessionKey(rawKey)
        return runCatching { api?.reviewDiff(key, scope, turnId, path) ?: error("offline") }
    }

    suspend fun sessionStats(rawKey: String): SessionStatsResult? = runCatching { api?.stats(sessionKey(rawKey)) }.getOrNull()

    suspend fun dequeue(rawKey: String): List<String>? = runCatching { api?.dequeue(sessionKey(rawKey))?.restored }.getOrNull()

    suspend fun respondUi(rawKey: String, response: UiResponse): Boolean {
        val key = sessionKey(rawKey)
        val ok = runCatching { api?.respondUi(response) ?: false }.getOrDefault(false)
        withTimelineSync(key) { it.current() }?.let { putTimeline(TurnStore.removeUi(it, response.id)) }
        return ok
    }

    suspend fun cancelUi(rawKey: String, id: String) {
        val key = sessionKey(rawKey)
        runCatching { api?.cancelUi(id) }
        withTimelineSync(key) { it.current() }?.let { putTimeline(TurnStore.removeUi(it, id)) }
    }

    suspend fun models(rawKey: String): ModelListResult? = runCatching { api?.models(sessionKey(rawKey)) }.getOrNull()
    suspend fun setModel(rawKey: String, id: String) = runCatching { api?.setModel(sessionKey(rawKey), id) }
    private val _pendingShare = MutableStateFlow<SharedContent?>(null)
    /** Shared from another app; the next opened session takes it into its composer. */
    val pendingShare: StateFlow<SharedContent?> = _pendingShare
    fun share(content: SharedContent) { _pendingShare.value = content }
    fun takeShare(): SharedContent? = _pendingShare.value.also { _pendingShare.value = null }

    /** Set by [dev.pi.remote.app.AppGraph]: run notifications and the background keep-alive. */
    var notifier: RunNotifier? = null
    private var keptAlive = false

    /** Notify on running → done/failed and on a new question, unless the user is looking at it. */
    private fun noticeTransitions(before: Map<String, SessionSummary>, after: List<SessionSummary>) {
        val n = notifier ?: return
        for (s in after) {
            val was = before[s.sessionKey]?.status ?: continue
            val settled = was == "running" && s.status != "running"
            val asks = s.status == "needsInput" && was != "needsInput"
            if ((settled || asks) && !(foreground && openKey == s.sessionKey)) n.notifySession(s)
        }
        updateKeepAlive()
    }

    /** In the background, stay connected while something is still running; drop 30 s after the last run ends. */
    private fun updateKeepAlive() {
        val running = _inbox.value.sessions.count { it.status == "running" }
        val want = !foreground && running > 0
        if (want) {
            stopJob?.cancel()
            stopJob = null
            notifier?.keepAlive(running)
            keptAlive = true
        } else if (keptAlive) {
            notifier?.keepAlive(0)
            keptAlive = false
            if (!foreground) scheduleDisconnect()
        }
    }

    private fun scheduleDisconnect() {
        stopJob?.cancel()
        stopJob = scope.launch {
            delay(30_000)
            disconnect()
        }
    }

    /** Set by [dev.pi.remote.app.AppGraph]; receives our own uploads so they show without a download. */
    var attachmentStore: AttachmentStore? = null

    /** Uploads one prepared attachment; returns the host path the prompt should reference. */
    suspend fun upload(prepared: PreparedAttachment): Result<String> = runCatching {
        val a = api ?: error("offline")
        val data = withContext(Dispatchers.Default) { android.util.Base64.encodeToString(prepared.bytes, android.util.Base64.NO_WRAP) }
        a.upload(prepared.name, prepared.mime, data).path.also { path -> attachmentStore?.put(path, prepared.bytes) }
    }

    suspend fun downloadAttachment(path: String): ByteArray? {
        val a = api ?: return null
        val r = a.attachment(path)
        return withContext(Dispatchers.Default) { android.util.Base64.decode(r.data, android.util.Base64.NO_WRAP) }
    }
    suspend fun setThinking(rawKey: String, level: String) = runCatching { api?.setThinking(sessionKey(rawKey), level) }
    suspend fun capabilities(rawKey: String): List<CapabilityRow> = runCatching { api?.capabilities(sessionKey(rawKey)) }.getOrNull().orEmpty()
    suspend fun setCapability(rawKey: String, id: String, on: Boolean) = runCatching { api?.setCapability(sessionKey(rawKey), id, on) }
    suspend fun cacheWarming(): String? = runCatching { api?.cacheWarming() }.getOrNull()
    suspend fun setCacheWarming(mode: String) = runCatching { api?.setCacheWarming(mode) }
    suspend fun toolDetail(rawKey: String, toolCallId: String): ToolDetailResult? = runCatching { api?.toolDetail(sessionKey(rawKey), toolCallId) }.getOrNull()
    suspend fun createSession(projectId: String, caps: List<String>?): String? = runCatching {
        api?.create(projectId, caps)?.sessionKey?.let(::sessionKey)
    }.getOrNull()

    val canWrite: Boolean get() = (hello?.role ?: _active.value?.role) == "operator"

    /** mermaid.min.js served by the desktop, verified against the hash from the encrypted hello. */
    suspend fun mermaidScript(): File? = withContext(Dispatchers.IO) {
        val info = hello?.assets?.firstOrNull { it.name == "mermaid.min.js" } ?: return@withContext null
        val file = File(assetDir, "${info.sha256}.js")
        if (file.exists()) return@withContext file
        val endpoint = (conn?.state?.value as? HostConnection.State.Ready)?.endpoint ?: return@withContext null
        val u = URI(endpoint)
        runCatching {
            val bytes = URI("http", null, u.host, u.port, "/assets/mermaid.min.js", null, null).toURL().openStream().use { it.readBytes() }
            val sha = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            if (sha != info.sha256) return@runCatching null
            assetDir.mkdirs()
            file.writeBytes(bytes)
            file
        }.getOrNull()
    }
}
