const safetyCatch = require('safety-catch')
const DHT = require('hyperdht')
const ScopeLock = require('scope-lock')

const b4a = require('b4a')

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
      onerror = safetyCatch,
      seed = null,
      keyPair = DHT.keyPair(seed),
      relayAddresses = () => []
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

    this._discovered = new Set()
    this._activeQuery = null
    this._timer = null
    this._closestNodes = null
    this._firstAnnounce = true
    this._needsUnannounce = false
    this._refreshes = 0
    this._wait = wait

    this._mutex = new ScopeLock({ debounce: true })
  }

  get announce() {
    return this._announce
  }

  get active() {
    return !!(this._activeQuery || this._timer)
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

    const delay = timeLeft < 0 || eager ? jitter : timeLeft + jitter

    if (this._timer) clearTimeout(this._timer)

    const startTime = Date.now()
    this._timer = setTimeout(() => {
      // If your laptop went to sleep, and is coming back online...
      const overdue = Date.now() - startTime > delay + DELAY_GRACE_PERIOD
      if (overdue) this._scheduleRefresh(true)
      else this.refresh().catch(this._onerror)
    }, delay)
  }

  _runnable() {
    return !this.destroyed && !this.suspended
  }

  async _refresh() {
    if (!this._runnable()) return

    if (this._wait) {
      await this._wait
      this._wait = null
    }

    const locked = await this._mutex.lock()
    if (!locked) return this._mutex.flush() // debounced

    if (!this._runnable()) {
      this._mutex.unlock()
      return
    }

    const clear = this.announce && this._firstAnnounce

    const opts = {
      clear,
      closestNodes: this._closestNodes
    }

    const bump = this.bump.local
    if (bump >= 0) opts.bump = bump

    if (this.announce) this._needsUnannounce = true

    let nDiscovered = 0

    this._discovered.clear()

    const announcing = this.announce

    let query
    if (announcing) {
      query = this.dht.announce(this.topic, this.keyPair, this._relayAddresses(), opts)
    } else if (this._needsUnannounce) {
      query = this.dht.lookupAndUnannounce(this.topic, this.keyPair, opts)
    } else {
      query = this.dht.lookup(this.topic, opts)
    }

    this._activeQuery = query

    try {
      for await (const data of query) {
        if (!this._runnable()) continue

        for (const peer of data.peers) {
          const id = b4a.toString(peer.publicKey, 'hex')
          const duplicate = this._discovered.has(id)

          if (this._discovered.size < MAX_DISCOVERY_CACHE) {
            this._discovered.add(id)
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
    } catch (err) {
      if (this._runnable()) throw err // propagate unless shutting down
    } finally {
      this._activeQuery = null
      this._closestNodes = query.closestNodes
      this.lastRefreshed = Date.now()
      this._refreshes++

      if (announcing) this.bump.announced = bump
      if (clear) this._firstAnnounce = false
      if (!announcing) this._needsUnannounce = false

      this._mutex.unlock()

      if (this._runnable()) this._scheduleRefresh() // schedule next
    }
  }

  async refresh() {
    if (this.destroyed) throw new Error('PeerDiscovery is destroyed')
    if (this.suspended) return

    await this._refresh()
  }

  async flushed() {
    await this._wait
    return this._mutex.flush()
  }

  destroy() {
    if (this.destroying) return this.destroying
    this.destroying = this._destroy()
    return this.destroying
  }

  async abort(log = noop) {
    const id = log === noop ? '' : b4a.toString(this.topic, 'hex')

    log('Aborting discovery', id)
    if (this._wait) await this._wait
    log('Aborting discovery (post wait)', id)

    if (this._activeQuery) {
      this._activeQuery.destroy()
      this._activeQuery = null
    }
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }

    let nodes = this._closestNodes

    try {
      await this._mutex.flush()
    } catch {
      // If the destroy causes the refresh to fail, suppress it.
    }

    log('Aborting discovery (post refresh)', id)
    if (this._runnable()) return

    if (!nodes) nodes = this._closestNodes
    else if (this._closestNodes && this._closestNodes !== nodes) {
      const len = nodes.length
      for (const newer of this._closestNodes) {
        if (newer.id && !hasNode(nodes, len, newer)) nodes.push(newer)
      }
    }

    if (this._needsUnannounce) {
      log('Unannouncing discovery', id)
      if (nodes && nodes.length) {
        await this.dht.unannounce(this.topic, this.keyPair, {
          closestNodes: nodes,
          onlyClosestNodes: true,
          force: true
        })
      }
      this._needsUnannounce = false
      log('Unannouncing discovery (done)', id)
    }
  }

  _destroy() {
    if (this.destroyed) return
    this.destroyed = true
    return this.abort(noop)
  }

  async suspend({ log = noop } = {}) {
    if (this.suspended) return
    this.suspended = true
    try {
      await this.abort(log)
    } catch {
      // ignore
    }
  }

  async resume() {
    if (!this.suspended) return
    this.suspended = false
    return this.refresh()
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
