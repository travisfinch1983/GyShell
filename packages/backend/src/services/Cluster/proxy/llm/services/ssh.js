/**
 * ssh.js — SSH Service with Connection Pooling
 *
 * Provides SSH command execution and connectivity checking for all remote
 * operations (service discovery, GPU monitoring, system stats, terminal
 * sessions, hookscript deployment, LXC config editing).
 *
 * Maintains persistent connections per host to avoid TCP churn and
 * TIME_WAIT socket pile-up from rapid connect/disconnect cycles.
 *
 * @module ssh
 */

import { Client } from 'ssh2';
import { readFileSync } from 'fs';

export class SSHService {
  constructor(sshConfig) {
    this.defaultUser = sshConfig.defaultUser || 'root';
    this.connectTimeout = sshConfig.connectTimeout || 10000;
    this.privateKey = null;
    this._pool = new Map();      // host -> { conn, ready, queue, lastUsed, connecting }
    this._IDLE_TIMEOUT = 120000; // Close idle connections after 2 min
    this._KEEPALIVE_MS = 15000;  // SSH keepalive interval

    try {
      this.privateKey = readFileSync(sshConfig.privateKeyPath);
    } catch (err) {
      console.warn(`SSH key not found at ${sshConfig.privateKeyPath}, SSH will be unavailable`);
    }

    // Periodically clean up idle connections
    setInterval(() => this._cleanIdle(), 30000);
  }

  /**
   * Get or create a pooled SSH connection to a host.
   * Returns a ready ssh2.Client. Multiple callers waiting for the same host
   * share one connection attempt.
   */
  _getConn(host, user) {
    const key = `${user || this.defaultUser}@${host}`;
    const entry = this._pool.get(key);

    if (entry?.ready && entry.conn) {
      entry.lastUsed = Date.now();
      return Promise.resolve(entry.conn);
    }

    // If already connecting, queue up
    if (entry?.connecting) {
      return new Promise((resolve, reject) => {
        entry.queue.push({ resolve, reject });
      });
    }

    // New connection
    const newEntry = { conn: null, ready: false, connecting: true, queue: [], lastUsed: Date.now() };
    this._pool.set(key, newEntry);

    return new Promise((resolve, reject) => {
      const conn = new Client();

      const timer = setTimeout(() => {
        conn.end();
        newEntry.connecting = false;
        const err = new Error(`SSH connect timed out to ${host}`);
        reject(err);
        for (const waiter of newEntry.queue) waiter.reject(err);
        newEntry.queue = [];
        this._pool.delete(key);
      }, this.connectTimeout);

      conn.on('ready', () => {
        clearTimeout(timer);
        newEntry.conn = conn;
        newEntry.ready = true;
        newEntry.connecting = false;
        newEntry.lastUsed = Date.now();
        resolve(conn);
        for (const waiter of newEntry.queue) waiter.resolve(conn);
        newEntry.queue = [];
      });

      conn.on('error', (err) => {
        clearTimeout(timer);
        newEntry.ready = false;
        newEntry.connecting = false;
        this._pool.delete(key);
        reject(err);
        for (const waiter of newEntry.queue) waiter.reject(err);
        newEntry.queue = [];
      });

      conn.on('close', () => {
        newEntry.ready = false;
        this._pool.delete(key);
      });

      conn.on('end', () => {
        newEntry.ready = false;
        this._pool.delete(key);
      });

      conn.connect({
        host,
        port: 22,
        username: user || this.defaultUser,
        privateKey: this.privateKey,
        readyTimeout: this.connectTimeout,
        hostVerifier: () => true,
        keepaliveInterval: this._KEEPALIVE_MS,
        keepaliveCountMax: 3,
      });
    });
  }

  /** Close idle connections */
  _cleanIdle() {
    const now = Date.now();
    for (const [key, entry] of this._pool) {
      if (entry.ready && (now - entry.lastUsed) > this._IDLE_TIMEOUT) {
        entry.conn?.end();
        this._pool.delete(key);
      }
    }
  }

  /**
   * Execute a command on a remote host via SSH (pooled connection).
   * Returns { code, stdout, stderr }.
   */
  async exec(host, command, { user, timeout } = {}) {
    if (!this.privateKey) {
      throw new Error('SSH key not configured');
    }

    let conn;
    try {
      conn = await this._getConn(host, user);
    } catch (err) {
      throw new Error(`SSH connect to ${host} failed: ${err.message}`);
    }

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`SSH command timed out after ${timeout || 60000}ms`));
      }, timeout || 60000);

      conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            // Connection may be dead — evict from pool
            const key = `${user || this.defaultUser}@${host}`;
            this._pool.delete(key);
            conn.end();
            reject(err);
          }
          return;
        }

        stream.on('data', (data) => { stdout += data.toString(); });
        stream.stderr.on('data', (data) => { stderr += data.toString(); });

        stream.on('close', (code) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve({ code: code || 0, stdout, stderr });
          }
        });
      });
    });
  }

  /**
   * Execute a command with real-time output streaming via callback.
   * Returns the ssh2 Client so caller can manage lifecycle.
   * NOTE: Streaming sessions use a fresh connection (not pooled) since
   * the caller controls the lifecycle.
   */
  execStream(host, command, { user, onStdout, onStderr, onClose, onError } = {}) {
    if (!this.privateKey) {
      onError?.(new Error('SSH key not configured'));
      return null;
    }

    const conn = new Client();

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          onError?.(err);
          conn.end();
          return;
        }

        stream.on('data', (data) => onStdout?.(data.toString()));
        stream.stderr.on('data', (data) => onStderr?.(data.toString()));

        stream.on('close', (code) => {
          onClose?.(code || 0);
          conn.end();
        });
      });
    });

    conn.on('error', (err) => {
      onError?.(err);
    });

    conn.connect({
      host,
      port: 22,
      username: user || this.defaultUser,
      privateKey: this.privateKey,
      readyTimeout: this.connectTimeout,
      hostVerifier: () => true,
    });

    return conn;
  }

  /**
   * Execute a command with data written to stdin.
   * Returns { code, stdout, stderr }.
   */
  async execWithStdin(host, command, stdinData, { user, timeout } = {}) {
    if (!this.privateKey) {
      throw new Error('SSH key not configured');
    }

    let conn;
    try {
      conn = await this._getConn(host, user);
    } catch (err) {
      throw new Error(`SSH connect to ${host} failed: ${err.message}`);
    }

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`SSH command timed out after ${timeout || 60000}ms`));
      }, timeout || 60000);

      conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            const key = `${user || this.defaultUser}@${host}`;
            this._pool.delete(key);
            conn.end();
            reject(err);
          }
          return;
        }

        stream.on('data', (data) => { stdout += data.toString(); });
        stream.stderr.on('data', (data) => { stderr += data.toString(); });

        stream.on('close', (code) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve({ code: code || 0, stdout, stderr });
          }
        });

        stream.write(stdinData);
        stream.end();
      });
    });
  }

  /**
   * Check if a host is reachable via SSH.
   */
  async ping(host, { user } = {}) {
    try {
      const result = await this.exec(host, 'echo PULSE_OK', { user, timeout: 5000 });
      return result.stdout.includes('PULSE_OK');
    } catch {
      return false;
    }
  }

  /** Get pool stats for debugging */
  getPoolStats() {
    const stats = {};
    for (const [key, entry] of this._pool) {
      stats[key] = { ready: entry.ready, connecting: entry.connecting, queueLength: entry.queue.length, idleMs: Date.now() - entry.lastUsed };
    }
    return stats;
  }
}
