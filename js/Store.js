import {$, ajax, report} from './util.js';
import Module from './Module.js';
import Progress from './Progress.js';
import Flash from './Flash.js';
import * as semver from './semver.js';

window.semver = semver;

// Max time (msecs) to rely on something in localstore cache
const EXPIRE = 60 * 60 * 1000;

/**
 * HTTP request api backed by localStorage cache
 */
export default class Store {
  static init() {
    this._inflight = {};
    this._moduleCache = {};
    this._noCache = /noCache/i.test(location.search);
  }

  // GET package info
  static async getModule(name, version) {
    const isScoped = name.startsWith('@');

    // url-escape "/"'s in the name
    const path = `${name.replace(/\//g, '%2F')}`;

    // If semver isn't valid (i.e. not a simple, canonical version - e.g.
    // "1.2.3") fetch all versions (we'll figure out the specific version below)
    const cachePath = semver.valid(version) ? `${path}/${version}` : path;

    if (!this._moduleCache[cachePath]) {
      let body;

      if (!(/github:|git\+/.test(version))) { // We don't support git-hosted modules
        try {
          // HACK: Don't try to fetch specific version for scoped module name
          // See https://goo.gl/dSMitm
          body = await this.get(!isScoped && semver.valid(version) ? cachePath : path);
          if (!body) throw Error('No module info found');
          if (typeof(body) != 'object') throw Error('Response was not an object');
          if (body.unpublished) throw Error('Module is unpublished');
        } catch (err) {
          if ('status' in err) {
            Flash(err.message);
          } else {
            report.error(err);
          }
        }
      }

      // If no explicit version was requested, find best semver match
      const versions = body && body.versions;
      if (versions) {
        let resolvedVersion;

        // Use latest dist tags, if available
        if (!version && ('dist-tags' in body)) {
          resolvedVersion = body['dist-tags'].latest;
        }

        if (!resolvedVersion) {
          // Pick last version that satisfies semver
          for (const v in versions) {
            if (semver.satisfies(v, version || '*')) resolvedVersion = v;
          }
        }

        body = versions[resolvedVersion];
      }

      // If we fail to find info, just create a stub entry
      if (!body) {
        body = {stub: true, name, version, maintainers: []};
      } else if (path != cachePath) {
        // If this isn't from cache, store in localStorage
        this.store(path, cachePath);
        this.store(cachePath, body);
      }

      const module = new Module(body);

      /*
      const issues = module.validate();
      if (!issues.valid) console.log(module.key, issues);
      */

      this._moduleCache[cachePath] = this._moduleCache[path] = module;
    }

    return this._moduleCache[path];
  }

  // GET url, caching results in localStorage
  static get(path) {
    // In store?
    const stored = this.unstore(path);

    // In store?
    if (stored && !this._noCache) return stored;

    const progress = new Progress(path);
    $('#progress').appendChild(progress.el);
    return ajax('GET', `https://registry.npmjs.cf/${path}`, progress);
  }

  // Store a value in localStorage, purging if there's an error
  static store(key, obj) {
    try {
      if (obj && typeof(obj) == 'object') obj._storedAt = Date.now();
      localStorage.setItem(key, JSON.stringify(obj));
    } catch (err) {
      console.warn('Error while storing. Purging cache', err);
      this.purge();
    }
  }

  // Recover a value from localStorage
  static unstore(key) {
    let obj;
    for (let i = 0; i < 10; i++) {
      obj = localStorage.getItem(key);
      if (obj) obj = JSON.parse(obj);
      if (!obj || typeof(obj) != 'string') break;
      key = obj;
    }

    return (obj && obj._storedAt > Date.now() - EXPIRE) ? obj : null;
  }

  // Remove oldest half of store
  static purge() {
    const ls = localStorage;

    // List of entries
    const entries = new Array(ls.length).fill()
      .map((v, i) => [ls.key(i), JSON.parse(ls.getItem(ls.key(i)))]);

    // Get oldest 50% of entries
    let prune = entries.filter(entry => entry[1]._storedAt > 0)
      .sort((a, b) => {
        a = a._storedAt;
        b = b._storedAt;
        return a < b ? -1 : a > b ? 1 : 0;
      });
    prune = prune.slice(0, Math.max(1, prune.length >> 1));

    // Compile list of names to prune
    const names = {};
    prune.forEach(e => names[e[0]] = true);
    entries.filter(e => names[e[0]] || names[e[1]]).forEach(e => ls.removeItem(e[0]));
  }

  static clear() {
    localStorage.clear();
    $('#storage').innerText = '0 chars';
  }
}
