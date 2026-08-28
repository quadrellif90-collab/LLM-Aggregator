/**
 * @typedef {Object} Provider
 * @property {string} name
 * @property {string} label
 * @property {boolean} needsKey
 * @property {string} authId
 * @property {string} baseURL
 * @property {Array<Model>} models
 */

/**
 * @typedef {Object} Model
 * @property {string} id
 * @property {boolean} [free]
 * @property {string} [label]
 */

/**
 * @typedef {Object} EnhancerCfg
 * @property {boolean} enabled
 * @property {number} maxChars
 * @property {number} timeoutMs
 */

/**
 * @typedef {Object} AppState
 * @property {Object} models
 * @property {Object} profiles
 * @property {Object} prefs
 * @property {Object} pricing
 */

module.exports = {};
