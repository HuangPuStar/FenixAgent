// CJS entry — wraps the ESM build for require() compatibility.
// OpenCode CLI uses require() for npm packages; this ensures the
// default export is returned directly as a callable function.

const mod = require('./index.js');
const plugin = mod.default || mod.HindsightPlugin;
module.exports = plugin;
module.exports.default = plugin;
module.exports.HindsightPlugin = plugin;
