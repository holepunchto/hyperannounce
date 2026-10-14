const safetyCatch = require('safety-catch')
const DHT = require('hyperdht')
const ScopeLock = require('scope-lock')

const b4a = require('b4a')
const { toHex } = b4a

const REFRESH_INTERVAL = 1000 * 60 * 10 // 10 min
const RANDOM_JITTER = 1000 * 60 * 2 // 2 min
const DELAY_GRACE_PERIOD = 1000 * 30 // 30s

const MAX_DISCOVERY_CACHE = 64

module.exports = class PeerDiscovery {
  constructor(
    dht,
    topic,
    {
      announce = false,
      limit = Infinity,
      wait = null,
      suspended = false,
      onpeer = noop,
      onbump = noop,
      onstats = noop,
      onerror = safetyCatch,
      seed = null,
      keyPair = DHT.keyPair(seed),
      relayAddresses = () => [],

      fastRetry = 0 // experimental
    } = {}
  ) {
    this.dht = dht
    this.keyPair = keyPair
    this._relayAddresses = relayAddresses
    this._announce = !!announce

    this.limit = limit
    this.topic = topic
    this.destroyed = false
    this.destroying = null
    this.suspended = suspended
    this.lastRefreshed = -1
    this.bump = {
      announced: -1,
      local: -1,
      seen: -1
    }

    this._onpeer = onpeer
    this._onerror = onerror
    this._onbump = onbump
    this._onstats = onstats

    this.stats = {
      lookup: 0,
      announce: 0,
      unannounce: 0,
      refresh: 0,
      errors: 0
    }

    this._activeQuery = null
    this._timer = null
    this._closestNodes = null
    this._firstAnnounce = true
    this._needsUnannounce = false
    this._wait = wait // legacy

    this._queued = 0
    this._applied = 0
    this._subscribers = []
    this._refreshPending = false
    this._fastRetry = fastRetry

    this._mutex = new ScopeLock()
  }

  get announce() {
    return this._announce
  }

  get active() {
    return !!(this._activeQuery || this._timer || this._applied < this._queued)
  }

  setAnnounce(announce, bump = -1) {
    announce = !!announce
    this.update(bump)
    if (announce === this._announce) return

    this._announce = announce
    this.bump.announced = -1

    if (this._activeQuery) this._activeQuery.destroy()
  }

  update(bump) {
    if (bump <= this.bump.local) return
    this.bump.local = bump
  }

  _scheduleRefresh(eager = false) {
    const jitter = Math.round(Math.random() * RANDOM_JITTER)
    const timeLeft = REFRESH_INTERVAL - (Date.now() - this.lastRefreshed)

    let delay = timeLeft + jitter
    if (timeLeft < 0) delay = jitter
    if (eager) delay = jitter

    if (this._timer) clearTimeout(this._timer)

    const startTime = Date.now()
    this._timer = setTimeout(() => {
      // If your laptop went to sleep, and is coming back online...
      const overdue = Date.now() - startTime > delay + DELAY_GRACE_PERIOD

      if (overdue) {
        this._scheduleRefresh(true)
      } else {
        try {
          this.refresh()
        } catch (err) {
          this._onerror(err)
        }
      }
    }, delay)
  }

  get _isRunning() {
    return !this.destroyed && !this.suspended
  }

  refresh() {
    if (this.destroyed) throw new Error('PeerDiscovery is destroyed')
    if (this.suspended) return

    if (this._refreshPending) return

    this._refreshPending = true
    const snapshot = ++this._queued
    this._refresh(snapshot).catch(this._onerror)
  }

  async _refresh(snapshot) {
    if (!this._isRunning) return

    if (this._wait) {
      await this._wait
      this._wait = null
    }

    const locked = await this._mutex.lock()
    this._refreshPending = false
    if (!locked) return this._mutex.flush() // debounced

    if (!this._isRunning) {
      // no-op
      this._settlePending(snapshot)
      this._mutex.unlock()
      return
    }

    try {
      const nDiscovered = await this._query()

      // experimental
      const firstRun = snapshot === 1
      const topicEmpty = nDiscovered === 0

      if (this._fastRetry > 0 && firstRun && topicEmpty && this._isRunning) {
        const delay = Math.random() * this._fastRetry
        await new Promise((resolve) => setTimeout(resolve, delay))

        await this._query() // fast-retry before mutex release
      }
    } finally {
      this._settlePending(snapshot)

      this._mutex.unlock()

      if (this._isRunning) this._scheduleRefresh() // schedule next
    }
  }

  async _query() {
    const clear = this.announce && this._firstAnnounce

    const opts = {
      clear,
      closestNodes: this._closestNodes
    }

    const bump = this.bump.local
    if (bump >= 0) opts.bump = bump

    if (this.announce) this._needsUnannounce = true

    let nDiscovered = 0
    const discovered = new Set()

    const announcing = this.announce

    let query
    if (announcing) {
      this._updateStats('announce')

      query = this.dht.announce(this.topic, this.keyPair, this._relayAddresses(), opts)
    } else if (this._needsUnannounce) {
      this._updateStats('unannounce')

      query = this.dht.lookupAndUnannounce(this.topic, this.keyPair, opts)
    } else {
      this._updateStats('lookup')

      query = this.dht.lookup(this.topic, opts)
    }

    this._activeQuery = query
    let completed = false

    try {
      for await (const data of query) {
        if (!this._isRunning) continue

        for (const peer of data.peers) {
          const id = toHex(peer.publicKey)
          const duplicate = discovered.has(id)

          if (discovered.size < MAX_DISCOVERY_CACHE) {
            discovered.add(id)
          }

          if (duplicate) continue

          if (++nDiscovered > this.limit) continue

          this._onpeer(peer, data)
        }

        if (Number.isSafeInteger(data.bump) && data.bump > this.bump.seen) {
          this.bump.seen = data.bump
          this._onbump(this.bump.seen)
        }
      }

      completed = true
    } catch (err) {
      this.stats.errors++
      if (this._isRunning) throw err // propagate unless shutting down
    } finally {
      this._activeQuery = null
      this.lastRefreshed = Date.now()

      if (completed) {
        this.stats.refresh++
        this._closestNodes = query.closestNodes

        if (announcing) this.bump.announced = bump
        if (clear) this._firstAnnounce = false
        if (!announcing) this._needsUnannounce = false
      }
    }

    return nDiscovered
  }

  _settlePending(applied) {
    for (let i = 0; this._subscribers.length; i++) {
      const { target } = this._subscribers[0]

      if (target > applied) {
        break
      }

      const subscriber = this._subscribers.shift()
      subscriber.settle(subscriber.target)
    }

    if (this._applied < applied) {
      this._applied = applied
    }
  }

  async flush() {
    const target = this._queued
    if (target <= this._applied) return

    // dedupe
    const head = this._subscribers[0]
    if (head && target === head.target) {
      return head.promise
    }

    let settle = null
    const promise = new Promise((resolve) => {
      settle = resolve
    })
    this._subscribers.push({ target, settle, promise })

    return promise
  }

  destroy() {
    if (this.destroying) return this.destroying
    this.destroying = this._destroy()
    return this.destroying
  }

  abort(unannounce = false, log = noop) {
    if (!this.active) {
      log('Abort skipped')
      return
    }

    const snapshot = ++this._queued
    const lock = this._mutex.lock()
    return this._abort(snapshot, lock, unannounce, log)
  }

  async _abort(snapshot, lock, unannounce, log) {
    const id = log === noop ? '' : toHex(this.topic)
    let locked = false

    try {
      log('Aborting discovery', id)
      if (this._wait) await this._wait
      log('Aborting discovery (post wait)', id)

      if (this._activeQuery) {
        this._activeQuery.destroy()
        this._activeQuery = null
      }

      // snapshot pre-abort
      let nodes = this._closestNodes

      if (this._timer) {
        clearTimeout(this._timer)
        this._timer = null
      }

      locked = await lock
      if (!locked) return

      if (this._timer) {
        clearTimeout(this._timer)
        this._timer = null
      }

      if (!unannounce) return
      log('Aborting discovery (post refresh)', id)

      // merge aborted work / avoid leaking announcements
      const latest = this._closestNodes

      if (!nodes) {
        nodes = latest
      } else if (latest && latest !== nodes) {
        const len = nodes.length

        for (const newer of latest) {
          if (newer.id && !hasNode(nodes, len, newer)) nodes.push(newer)
        }
      }

      if (this._needsUnannounce) {
        log('Unannouncing discovery', id)
        if (nodes && nodes.length) {
          this._updateStats('unannounce')

          await this.dht.unannounce(this.topic, this.keyPair, {
            closestNodes: nodes,
            onlyClosestNodes: true,
            force: true
          })
        }
        this._needsUnannounce = false
        log('Unannouncing discovery (done)', id)
      }
    } finally {
      // the lock was taken in abort(), so it must be released even if we threw before acquiring it
      if (!locked) locked = await lock
      if (locked) {
        this._settlePending(snapshot)
        this._mutex.unlock()
      }
    }
  }

  _updateStats(action) {
    switch (action) {
      case 'lookup':
        this.stats.lookup++
        break

      case 'announce':
        this.stats.announce++
        break

      case 'unannounce':
        this.stats.unannounce++
        break

      default:
        throw new Error('unknown action: ' + action)
    }

    new Promise(async (resolve) => {
      await this._onstats(this.stats, action)
      resolve()
    }).catch(this._onerror)
  }

  async _destroy() {
    if (this.destroyed) return
    this.destroyed = true

    try {
      await this.abort(true, noop)
    } catch (err) {
      // ignore
      safetyCatch(err)
    }
  }

  async suspend({ log = noop } = {}) {
    if (this.suspended) return
    this.suspended = true
    try {
      await this.abort(true, log)
    } catch (err) {
      // ignore
      safetyCatch(err)
    }
  }

  resume() {
    if (!this.suspended) return
    this.suspended = false
    this.refresh()
  }
}

function hasNode(nodes, len, node) {
  for (let i = 0; i < len; i++) {
    const existing = nodes[i]
    if (existing.id && b4a.equals(existing.id, node.id)) return true
  }

  return false
}

function noop() {}
